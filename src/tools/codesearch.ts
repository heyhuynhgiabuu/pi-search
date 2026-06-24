/**
 * codesearch tool — searches code-relevant sources via Exa.
 *
 * Uses the same direct-REST-then-MCP-fallback strategy as websearch
 * but targets code-specific search modes and the `get_code_context_exa`
 * MCP tool (or equivalent) when falling back.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolveConfig } from "../config.js";
import { buildErrorResult, toPiSearchError, ValidationError } from "../errors.js";
import { createExaRestClient, formatExaResult, normalizeExaResults } from "../exa/client.js";
import {
	DEFAULT_HIGHLIGHTS_MAX_CHARACTERS,
	DEFAULT_NUM_RESULTS,
	MAX_HIGHLIGHTS_MAX_CHARACTERS,
	MAX_NUM_RESULTS,
	MIN_HIGHLIGHTS_MAX_CHARACTERS,
	normalizeExaParams,
	type RawExaParams,
} from "../exa/params.js";
import type { NormalizedExaResult } from "../types.js";
import { dedupeCitations, extractCitationsFromMcpText } from "./citations.js";
import { renderCodesearchResult } from "./render.js";

type ExaQueryRun = {
	query: string;
	requestId?: string;
	costDollars?: number;
	results: NormalizedExaResult[];
};

const CODE_SEARCH_TYPES = ["auto", "neural", "instant"] as const;

export function createCodesearchTool(_pi: ExtensionAPI) {
	return {
		name: "codesearch",
		label: "Code Search",
		description:
			"Search for code-relevant sources (docs, examples, library references) via Exa. Use this when looking for API references, library patterns, or implementation examples. Prefer websearch for general topical research.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query." })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple queries searched sequentially." })),
			numResults: Type.Optional(
				Type.Integer({
					description: `Results per query (default ${DEFAULT_NUM_RESULTS}, max ${MAX_NUM_RESULTS}).`,
					minimum: 1,
					maximum: MAX_NUM_RESULTS,
				}),
			),
			searchType: Type.Optional(
				Type.Union(
					CODE_SEARCH_TYPES.map((s) => Type.Literal(s)),
					{
						description: "Exa search mode (default auto).",
					},
				),
			),
			highlightsMaxCharacters: Type.Optional(
				Type.Integer({
					description: `Maximum characters for highlights (default ${DEFAULT_HIGHLIGHTS_MAX_CHARACTERS}, ${MIN_HIGHLIGHTS_MAX_CHARACTERS}-${MAX_HIGHLIGHTS_MAX_CHARACTERS}).`,
					minimum: MIN_HIGHLIGHTS_MAX_CHARACTERS,
					maximum: MAX_HIGHLIGHTS_MAX_CHARACTERS,
				}),
			),
		}),
		async execute(
			_id: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate:
				| ((update: { content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }) => void)
				| undefined,
		) {
			try {
				const config = resolveConfig();
				const effectiveParams = normalizeExaParams({
					...(params as RawExaParams),
					searchType: ((params as RawExaParams).searchType ?? "neural") as RawExaParams["searchType"],
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
		renderResult: renderCodesearchResult,
	};
}

async function runWithRest(
	apiKey: string,
	effectiveParams: ReturnType<typeof normalizeExaParams>,
	signal: AbortSignal | undefined,
	onUpdate:
		| ((update: { content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }) => void)
		| undefined,
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
	onUpdate:
		| ((update: { content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }) => void)
		| undefined,
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
