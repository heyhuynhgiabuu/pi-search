import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { arr, bool, compile, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { buildErrorResult, toPiSearchError, ValidationError } from "../errors.js";
import {
	DEFAULT_HIGHLIGHTS_MAX_CHARACTERS,
	DEFAULT_NUM_RESULTS,
	ExaExecuteParamsSchema,
	MAX_HIGHLIGHTS_MAX_CHARACTERS,
	MIN_HIGHLIGHTS_MAX_CHARACTERS,
	normalizeExaParams,
} from "../exa/params.js";
import { fetchSearchResultUrlsInBackground } from "../fetch/search-content.js";
import { runWebsearchQueries } from "../search/run-websearch.js";
import type { ExaQueryRun, ResolvedConfig, ToolDetails } from "../types.js";
import { renderToolCall, renderWebsearchResult } from "./render.js";

const validateWebsearchExecuteParams = compile(ExaExecuteParamsSchema);

export function createWebsearchTool(pi: ExtensionAPI, config: ResolvedConfig): ToolDefinition {
	const canRetrieveStoredContent = !config.disabledTools.has("get_fetch_content");

	const baseProperties = {
		query: opt(str({ description: "Single search query." })),
		queries: opt(arr(str(), { description: "Multiple queries searched sequentially." })),
		numResults: opt(
			int({
				description: `Results per query (default ${DEFAULT_NUM_RESULTS}, max 10).`,
				minimum: 1,
				maximum: 10,
			}),
		),
		searchType: opt(
			oneOf(["auto", "neural", "instant", "deep", "deep-reasoning", "deep-max"], {
				description: "Exa search mode (default auto). Use 'deep' or 'deep-reasoning' for sitreps.",
			}),
		),
		recencyFilter: opt(
			oneOf(["day", "week", "month", "year"], {
				description:
					"Filter for fresh results by relative time window. Mutually exclusive with startPublishedDate/endPublishedDate.",
			}),
		),
		startPublishedDate: opt(
			str({ description: "ISO date or datetime lower bound, e.g. 2026-03-01 or 2026-03-01T00:00:00Z." }),
		),
		endPublishedDate: opt(str({ description: "ISO date or datetime upper bound." })),
		domainFilter: opt(
			arr(str(), {
				description:
					"Domain shortcuts: use domain names to include them or prefix with - to exclude, e.g. ['reuters.com', '-reddit.com'].",
			}),
		),
		includeDomains: opt(arr(str(), { description: "Explicit domains to include." })),
		excludeDomains: opt(arr(str(), { description: "Explicit domains to exclude." })),
		highlightsMaxCharacters: opt(
			int({
				description: `Maximum characters for highlights (default ${DEFAULT_HIGHLIGHTS_MAX_CHARACTERS}, ${MIN_HIGHLIGHTS_MAX_CHARACTERS}-${MAX_HIGHLIGHTS_MAX_CHARACTERS}).`,
				minimum: MIN_HIGHLIGHTS_MAX_CHARACTERS,
				maximum: MAX_HIGHLIGHTS_MAX_CHARACTERS,
			}),
		),
	};

	const parameters = canRetrieveStoredContent
		? obj({
				...baseProperties,
				includeContent: opt(
					bool({
						description:
							"When true, fetches full page content for up to 5 result URLs in the background for get_fetch_content.",
					}),
				),
			})
		: obj(baseProperties);

	return {
		name: "websearch",
		label: "⚙ websearch",
		description:
			"Search the external web (Exa or Parallel) for current facts, source URLs, and external references. Use only for web research or citations. Do not use for greetings, local files, or local repository work. Use web_fetch for a specific URL.",
		promptSnippet: "Search external web sources for current facts and citations",
		promptGuidelines: [
			"Use websearch only for external or current information; do not use it for greetings or local repository search.",
			"Use web_fetch when the user provides or selects a specific URL.",
		],
		parameters,
		async execute(_id, params, signal, onUpdate) {
			try {
				if (signal?.aborted) {
					throw new ValidationError("Search aborted.");
				}

				const parsed = validateWebsearchExecuteParams.validate(params);

				if (!parsed.ok) {
					const first = parsed.errors[0];
					throw new ValidationError(
						first ? `${first.path || "params"}: ${first.message}` : "Invalid websearch parameters.",
					);
				}

				const effectiveParams = normalizeExaParams(parsed.value);

				if (config.disabledTools.has("websearch")) {
					throw new ValidationError("websearch is disabled in config.");
				}

				const onProgress = onUpdate
					? (update: { content: Array<{ type: "text"; text: string }>; details: ToolDetails }) =>
							onUpdate({ content: update.content, details: update.details })
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

				const includeContent = canRetrieveStoredContent && effectiveParams.includeContent;
				let includeContentNote = "";

				if (includeContent && urls.length > 0) {
					const slice = urls.slice(0, 5);
					void fetchSearchResultUrlsInBackground(pi, config, slice, signal).catch(() => {});
					includeContentNote = `\n\n---\nFetching full content for ${slice.length} URL(s) in background. Use get_fetch_content with list=true shortly.`;
				}

				const text = `${renderOutput(queryRuns)}${includeContentNote}`.trim();

				return {
					content: [{ type: "text", text }],
					details: {
						provider,
						effectiveParams: { ...effectiveParams, includeContent },
						queries: queryRuns,
						failover: provider === "brave",
						includeContent,
						backgroundFetchUrls: includeContent ? urls.slice(0, 5) : undefined,
					},
				};
			} catch (error) {
				return buildErrorResult(toPiSearchError(error));
			}
		},
		renderCall: renderToolCall("websearch"),
		renderResult: renderWebsearchResult,
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
