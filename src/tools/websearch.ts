import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { buildErrorResult, toPiSearchError, ValidationError } from "../errors.js";
import {
	DEFAULT_HIGHLIGHTS_MAX_CHARACTERS,
	DEFAULT_NUM_RESULTS,
	MAX_HIGHLIGHTS_MAX_CHARACTERS,
	MIN_HIGHLIGHTS_MAX_CHARACTERS,
	normalizeExaParams,
	type RawExaParams,
} from "../exa/params.js";
import { fetchSearchResultUrlsInBackground } from "../fetch/search-content.js";
import { runWebsearchQueries } from "../search/run-websearch.js";
import type { ExaQueryRun, ResolvedConfig } from "../types.js";
import { renderWebsearchResult } from "./render.js";

export function createWebsearchTool(pi: ExtensionAPI, config: ResolvedConfig): ToolDefinition {
	return {
		name: "websearch",
		label: "Web Search",
		description:
			"Search the open web for source discovery (Exa). Returns URL, title, published date, and a short highlight per result. Use searchType='deep' / 'deep-reasoning' for sitreps; recencyFilter and domainFilter to shape results. Prefer this over pi-web-access web_search when you need Exa deep modes or cited highlights—not synthesized answers or browser curation. Optional BRAVE_API_KEY enables failover when Exa fails or returns no results.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query." })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple queries searched sequentially." })),
			numResults: Type.Optional(
				Type.Integer({
					description: `Results per query (default ${DEFAULT_NUM_RESULTS}, max 10).`,
					minimum: 1,
					maximum: 10,
				}),
			),
			includeContent: Type.Optional(
				Type.Boolean({
					description:
						"When true, fetches full page content for up to 5 result URLs in the background (stored for get_fetch_content).",
				}),
			),
			searchType: Type.Optional(
				Type.Union(
					[
						Type.Literal("auto"),
						Type.Literal("neural"),
						Type.Literal("instant"),
						Type.Literal("deep"),
						Type.Literal("deep-reasoning"),
						Type.Literal("deep-max"),
					],
					{ description: "Exa search mode (default auto). Use 'deep' or 'deep-reasoning' for sitreps." },
				),
			),
			recencyFilter: Type.Optional(
				Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")], {
					description:
						"Filter for fresh results by relative time window. Mutually exclusive with startPublishedDate/endPublishedDate.",
				}),
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
		async execute(_id, params, signal, onUpdate) {
			try {
				if (signal?.aborted) {
					throw new ValidationError("Search aborted.");
				}

				const effectiveParams = normalizeExaParams(params as RawExaParams);

				if (config.disabledTools.has("websearch")) {
					throw new ValidationError("websearch is disabled in config.");
				}

				const onProgress = onUpdate
					? (update: { content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }) =>
							onUpdate({ content: update.content, details: update.details ?? {} })
					: undefined;
				const { runs, provider } = await runWebsearchQueries(config, effectiveParams, signal, onProgress);
				const queryRuns: ExaQueryRun[] = runs.map(({ query, requestId, costDollars, results }) => ({
					query,
					requestId,
					costDollars,
					results,
				}));

				const urls: string[] = [];
				for (const run of queryRuns) {
					for (const r of run.results) {
						if (r.url && !urls.includes(r.url)) urls.push(r.url);
					}
				}

				let includeContentNote = "";
				if (effectiveParams.includeContent && urls.length > 0) {
					const slice = urls.slice(0, 5);
					void fetchSearchResultUrlsInBackground(pi, config, slice, signal).catch(() => {});
					includeContentNote = `\n\n---\nFetching full content for ${slice.length} URL(s) in background. Use get_fetch_content with list=true shortly.`;
				}

				const text = `${renderOutput(queryRuns)}${includeContentNote}`.trim();
				return {
					content: [{ type: "text", text }],
					details: {
						provider,
						effectiveParams,
						queries: queryRuns,
						failover: provider === "brave",
						includeContent: effectiveParams.includeContent,
						backgroundFetchUrls: effectiveParams.includeContent ? urls.slice(0, 5) : undefined,
					},
				};
			} catch (error) {
				return buildErrorResult(toPiSearchError(error));
			}
		},
		renderResult: renderWebsearchResult as never,
	};
}

function renderOutput(runs: ExaQueryRun[]): string {
	const sections: string[] = [];
	for (const run of runs) {
		sections.push(`## Query: ${run.query}`);
		if (run.results.length === 0) {
			sections.push("No results.");
			continue;
		}
		for (const [i, r] of run.results.entries()) {
			const highlight = r.highlights[0] ?? r.summary ?? r.text ?? "";
			sections.push(`${i + 1}. **${r.title}**`);
			sections.push(`   ${r.url}`);
			if (r.publishedDate) sections.push(`   Published: ${r.publishedDate}`);
			if (highlight) sections.push(`   ${highlight}`);
			sections.push("");
		}
	}
	return sections.join("\n").trim();
}
