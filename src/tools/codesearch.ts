/**
 * codesearch tool — searches code-relevant sources via Exa.
 *
 * Uses the same direct-REST-then-MCP-fallback strategy as websearch
 * but targets code-specific search modes and the `get_code_context_exa`
 * MCP tool (or equivalent) when falling back.
 */

import type { AgentToolUpdateCallback, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { arr, compile, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { resolveConfig } from "../config.js";
import { buildErrorResult, toPiSearchError, ValidationError } from "../errors.js";
import { createExaRestClient, formatExaResult, normalizeExaResults } from "../exa/client.js";
import {
	DEFAULT_HIGHLIGHTS_MAX_CHARACTERS,
	DEFAULT_NUM_RESULTS,
	ExaExecuteParamsSchema,
	MAX_HIGHLIGHTS_MAX_CHARACTERS,
	MAX_NUM_RESULTS,
	MIN_HIGHLIGHTS_MAX_CHARACTERS,
	normalizeExaParams,
} from "../exa/params.js";
import type { NormalizedExaResult } from "../types.js";
import { dedupeCitations, extractCitationsFromMcpText } from "./citations.js";
import { renderCodesearchResult, renderToolCall } from "./render.js";

type ExaQueryRun = {
	query: string;
	requestId?: string;
	costDollars?: number;
	results: NormalizedExaResult[];
};

const CODE_SEARCH_TYPES = ["auto", "neural", "instant"] as const;

const codesearchParameters = obj({
	query: opt(str({ description: "Single search query." })),
	queries: opt(arr(str(), { description: "Multiple queries searched sequentially." })),
	numResults: opt(
		int({
			description: `Results per query (default ${DEFAULT_NUM_RESULTS}, max ${MAX_NUM_RESULTS}).`,
			minimum: 1,
			maximum: MAX_NUM_RESULTS,
		}),
	),
	searchType: opt(
		oneOf(CODE_SEARCH_TYPES, {
			description: "Exa search mode (default auto).",
		}),
	),
	highlightsMaxCharacters: opt(
		int({
			description: `Maximum characters for highlights (default ${DEFAULT_HIGHLIGHTS_MAX_CHARACTERS}, ${MIN_HIGHLIGHTS_MAX_CHARACTERS}-${MAX_HIGHLIGHTS_MAX_CHARACTERS}).`,
			minimum: MIN_HIGHLIGHTS_MAX_CHARACTERS,
			maximum: MAX_HIGHLIGHTS_MAX_CHARACTERS,
		}),
	),
});

const validateCodesearchParams = compile(ExaExecuteParamsSchema);

export function createCodesearchTool(_pi: ExtensionAPI): ToolDefinition {
	return {
		name: "codesearch",
		label: "⚙ codesearch",
		description:
			"Search public external code and documentation via Exa for API references, library patterns, and examples. Use only for external sources; do not use for searching the local workspace or repository.",
		promptSnippet: "Search external code and library documentation",
		promptGuidelines: [
			"Use codesearch only for external code or library references, never for local repository search.",
		],
		parameters: codesearchParameters,
		async execute(_id, params, signal, onUpdate) {
			try {
				const config = resolveConfig();

				const parsed = validateCodesearchParams.validate(params);

				if (!parsed.ok) {
					const first = parsed.errors[0];
					throw new ValidationError(
						first ? `${first.path || "params"}: ${first.message}` : "Invalid codesearch parameters.",
					);
				}

				const effectiveParams = normalizeExaParams({
					...parsed.value,
					searchType: parsed.value.searchType ?? "neural",
				});

				if (config.disabledTools.has("codesearch")) {
					throw new ValidationError("codesearch is disabled in config.");
				}

				const queryRuns: ExaQueryRun[] = config.exaApiKey
					? await runWithRest(config.exaApiKey, effectiveParams, signal, onUpdate)
					: await runWithMcp(effectiveParams, signal, onUpdate, config.mcpTimeoutMs);

				const text = renderOutput(queryRuns);

				return {
					content: [{ type: "text", text }],
					details: {
						provider: config.exaApiKey ? "exa-rest" : "exa-mcp",
						effectiveParams,
						queries: queryRuns,
					},
				};
			} catch (error) {
				return buildErrorResult(toPiSearchError(error));
			}
		},
		renderCall: renderToolCall("codesearch"),
		renderResult: renderCodesearchResult,
	};
}

async function runWithRest(
	apiKey: string,
	effectiveParams: ReturnType<typeof normalizeExaParams>,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
): Promise<ExaQueryRun[]> {
	const client = createExaRestClient(apiKey);
	const runs: ExaQueryRun[] = [];

	for (const [index, query] of effectiveParams.queries.entries()) {
		if (signal?.aborted) throw new ValidationError("Search aborted.");
		onUpdate?.({
			content: [{ type: "text", text: `Exa code searching ${index + 1}/${effectiveParams.queries.length}: ${query}` }],
			details: { phase: "searching", currentQuery: query, progress: index / effectiveParams.queries.length },
		});
		const response = await client.search({ query, effectiveParams, signal });
		runs.push({
			query,
			requestId: response.requestId,
			costDollars: response.costDollars,
			results: normalizeExaResults(response.results),
		});
	}

	return runs;
}

async function runWithMcp(
	effectiveParams: ReturnType<typeof normalizeExaParams>,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
	timeoutMs: number,
): Promise<ExaQueryRun[]> {
	const { createDefaultMcpClient } = await import("../mcp/client.js");
	const client = createDefaultMcpClient();
	const names = await client.listToolNames("exa");
	const toolName = pickCodesearchToolName(names);

	if (!toolName) {
		throw new ValidationError("Could not find a code_search Exa MCP tool. Set EXA_API_KEY to use direct REST.");
	}

	const runs: ExaQueryRun[] = [];

	for (const [index, query] of effectiveParams.queries.entries()) {
		if (signal?.aborted) throw new ValidationError("Search aborted.");
		onUpdate?.({
			content: [
				{ type: "text", text: `Exa MCP code searching ${index + 1}/${effectiveParams.queries.length}: ${query}` },
			],
			details: { phase: "searching", currentQuery: query, progress: index / effectiveParams.queries.length },
		});

		const response = await client.invoke({
			server: "exa",
			toolName,
			arguments: {
				query,
				numResults: effectiveParams.numResults,
			},
			options: { signal, timeoutMs },
		});

		const text = response.content.map((c) => c.text).join("\n");
		const citations = dedupeCitations(extractCitationsFromMcpText(text, "exa"));
		runs.push({
			query,
			results: citations.map((c) => ({
				title: c.title,
				url: c.url,
				highlights: [],
				summary: text,
			})),
		});
	}

	return runs;
}

function pickCodesearchToolName(names: string[]): string | null {
	const candidates = ["get_code_context_exa", "code_search", "code_search_exa", "exa_code_search"];

	for (const c of candidates) if (names.includes(c)) return c;

	return names.find((n) => n.includes("code")) ?? null;
}

function renderOutput(runs: ExaQueryRun[]): string {
	const sections: string[] = [];

	for (const run of runs) {
		sections.push(`Code results for: ${run.query}`);

		if (run.results.length === 0) {
			sections.push("No results.");
			sections.push("");
			continue;
		}

		sections.push(run.results.map((r, i) => formatExaResult(r, i)).join("\n"));
		sections.push("");
	}

	sections.push(
		"Suggested next step: use web_fetch on the most relevant URLs for full code examples and documentation.",
	);

	return sections.join("\n").trim();
}
