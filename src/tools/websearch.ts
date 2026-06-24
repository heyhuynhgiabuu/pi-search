/**
 * websearch tool — searches the open web via Exa.
 *
 * Strategy:
 *  1. If an Exa API key is available, use direct REST (full features:
 *     searchType, recencyFilter, domainFilter, highlights, etc.)
 *  2. Otherwise fall back to the MCP server (zero-config path).
 *
 * Always returns structured citations so downstream tools can build
 * on the result without re-parsing prose.
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
import { EXA_RECENCY_FILTERS, EXA_SEARCH_TYPES, type NormalizedExaResult } from "../types.js";
import { dedupeCitations, extractCitationsFromMcpText } from "./citations.js";
import { renderWebsearchResult } from "./render.js";

type ExaQueryRun = {
	query: string;
	requestId?: string;
	costDollars?: number;
	results: NormalizedExaResult[];
};

export function createWebsearchTool(_pi: ExtensionAPI) {
	return {
		name: "websearch",
		label: "Web Search",
		description:
			"Search the open web for source discovery. Returns URL, title, published date, and a short highlight per result. Use recencyFilter for sitreps, domainFilter to shape the source set, and searchType='deep' / 'deep-reasoning' for thorough research.",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description: "Single search query. Prefer this for focused lookups.",
				}),
			),
			queries: Type.Optional(
				Type.Array(Type.String(), {
					description: "Multiple queries searched sequentially. Useful for sitreps and multi-angle research.",
				}),
			),
			numResults: Type.Optional(
				Type.Integer({
					description: `Results per query (default ${DEFAULT_NUM_RESULTS}, max ${MAX_NUM_RESULTS}).`,
					minimum: 1,
					maximum: MAX_NUM_RESULTS,
				}),
			),
			searchType: Type.Optional(
				Type.Union(
					EXA_SEARCH_TYPES.map((s) => Type.Literal(s)),
					{ description: "Exa search mode (default auto). Use 'deep' or 'deep-reasoning' for sitreps." },
				),
			),
			recencyFilter: Type.Optional(
				Type.Union(
					EXA_RECENCY_FILTERS.map((s) => Type.Literal(s)),
					{
						description:
							"Filter for fresh results by relative time window. Mutually exclusive with startPublishedDate/endPublishedDate.",
					},
				),
			),
			startPublishedDate: Type.Optional(
				Type.String({ description: "ISO date or datetime lower bound, e.g. 2026-03-01 or 2026-03-01T00:00:00Z." }),
			),
			endPublishedDate: Type.Optional(Type.String({ description: "ISO date or datetime upper bound." })),
			domainFilter: Type.Optional(
				Type.Array(Type.String(), {
					description: "Domains to include or exclude with a - prefix, e.g. ['reuters.com', '-reddit.com'].",
				}),
			),
			includeDomains: Type.Optional(Type.Array(Type.String(), { description: "Explicit domains to include." })),
			excludeDomains: Type.Optional(Type.Array(Type.String(), { description: "Explicit domains to exclude." })),
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
				const effectiveParams = normalizeExaParams(params as RawExaParams);

				if (config.disabledTools.has("websearch")) {
					throw new ValidationError("websearch is disabled in config.");
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
		renderResult: renderWebsearchResult,
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
			content: [{ type: "text", text: `Exa searching ${index + 1}/${effectiveParams.queries.length}: ${query}` }],
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
	const toolName = pickWebsearchToolName(names);
	if (!toolName) {
		throw new ValidationError("Could not find a web_search Exa MCP tool. Set EXA_API_KEY to use direct REST.");
	}

	const runs: ExaQueryRun[] = [];
	for (const [index, query] of effectiveParams.queries.entries()) {
		if (signal?.aborted) throw new ValidationError("Search aborted.");
		onUpdate?.({
			content: [{ type: "text", text: `Exa MCP searching ${index + 1}/${effectiveParams.queries.length}: ${query}` }],
			details: { phase: "searching", currentQuery: query, progress: index / effectiveParams.queries.length },
		});

		const response = await client.invoke({
			server: "exa",
			toolName,
			arguments: {
				query,
				numResults: effectiveParams.numResults,
				type: effectiveParams.searchType,
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

function pickWebsearchToolName(names: string[]): string | null {
	const candidates = ["web_search_exa", "web_search", "exa_web_search", "search_web", "web-search"];
	for (const c of candidates) if (names.includes(c)) return c;
	return names.find((n) => n.includes("web_search")) ?? null;
}

function renderOutput(runs: ExaQueryRun[]): string {
	const sections: string[] = [];
	for (const run of runs) {
		sections.push(`Results for: ${run.query}`);
		if (run.results.length === 0) {
			sections.push("No results.");
			sections.push("");
			continue;
		}
		sections.push(run.results.map((r, i) => formatExaResult(r, i)).join("\n"));
		sections.push("");
	}
	sections.push(
		"Suggested next step: use web_fetch on the most relevant URLs for full extraction before final synthesis.",
	);
	return sections.join("\n").trim();
}
