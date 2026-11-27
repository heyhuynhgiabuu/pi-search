import { ProviderError, ValidationError } from "../errors.js";
import { createExaRestClient, normalizeExaResults } from "../exa/client.js";
import { parseExaMcpTextToResults } from "../exa/mcp-blocks.js";
import type { normalizeExaParams } from "../exa/params.js";
import { dedupeCitations, extractCitationsFromMcpText } from "../tools/citations.js";
import type { ResolvedConfig, ToolDetails } from "../types.js";
import { braveWebSearch } from "./brave.js";
import { parallelWebSearch } from "./parallel.js";

export type WebsearchQueryRun = {
	query: string;
	requestId?: string;
	costDollars?: number;
	provider: "exa-rest" | "exa-mcp" | "parallel" | "brave";
	results: import("../types.js").NormalizedExaResult[];
};

type EffectiveParams = ReturnType<typeof normalizeExaParams>;

export async function runWebsearchQueries(
	config: ResolvedConfig,
	effectiveParams: EffectiveParams,
	signal: AbortSignal | undefined,
	onUpdate: ((update: { content: Array<{ type: "text"; text: string }>; details: ToolDetails }) => void) | undefined,
): Promise<{ runs: WebsearchQueryRun[]; provider: WebsearchQueryRun["provider"] }> {
	const primaryErrors: string[] = [];

	try {
		const primary = pickPrimaryProvider(config);

		const runs =
			primary.provider === "parallel"
				? await runParallel(primary.apiKey, effectiveParams, signal, onUpdate)
				: primary.provider === "exa-rest"
					? await runExaRest(primary.apiKey, effectiveParams, signal, onUpdate)
					: await runExaMcp(effectiveParams, signal, onUpdate, config.mcpTimeoutMs);

		if (runsHaveResults(runs)) {
			return { runs, provider: primary.provider };
		}

		primaryErrors.push(`${primary.provider === "parallel" ? "Parallel" : "Exa"} returned no results`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		primaryErrors.push(message);
	}

	if (!config.braveApiKey) {
		if (primaryErrors.length > 0) {
			throw new ProviderError(`Web search failed: ${primaryErrors.join("; ")}`, { attempts: primaryErrors });
		}

		throw new ValidationError("No search results.");
	}

	onUpdate?.({
		content: [{ type: "text", text: "Primary search unavailable or empty — trying Brave Search fallback..." }],
		details: { phase: "failover", provider: "brave" },
	});

	const runs = await runBrave(config.braveApiKey, effectiveParams, signal, onUpdate);

	if (!runsHaveResults(runs)) {
		throw new ProviderError(`Web search failed: ${primaryErrors.join("; ")}; Brave returned no results`, {
			attempts: primaryErrors,
		});
	}

	return { runs, provider: "brave" };
}

type PrimaryProvider = { provider: "parallel" | "exa-rest"; apiKey: string } | { provider: "exa-mcp" };

function pickPrimaryProvider({ searchProvider, parallelApiKey, exaApiKey }: ResolvedConfig): PrimaryProvider {
	const parallel = parallelApiKey ? ({ provider: "parallel", apiKey: parallelApiKey } as const) : undefined;
	const exa = exaApiKey ? ({ provider: "exa-rest", apiKey: exaApiKey } as const) : undefined;

	if (searchProvider === "parallel") return parallel ?? { provider: "exa-mcp" };

	if (searchProvider === "exa") return exa ?? { provider: "exa-mcp" };

	return exa ?? parallel ?? { provider: "exa-mcp" };
}

function runsHaveResults(runs: WebsearchQueryRun[]): boolean {
	return runs.some((r) => r.results.length > 0);
}

async function runExaRest(
	apiKey: string,
	effectiveParams: EffectiveParams,
	signal: AbortSignal | undefined,
	onUpdate: Parameters<typeof runWebsearchQueries>[3],
): Promise<WebsearchQueryRun[]> {
	const client = createExaRestClient(apiKey);
	const runs: WebsearchQueryRun[] = [];

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
			provider: "exa-rest",
			results: normalizeExaResults(response.results),
		});
	}

	return runs;
}

async function runParallel(
	apiKey: string,
	effectiveParams: EffectiveParams,
	signal: AbortSignal | undefined,
	onUpdate: Parameters<typeof runWebsearchQueries>[3],
): Promise<WebsearchQueryRun[]> {
	const runs: WebsearchQueryRun[] = [];

	for (const [index, query] of effectiveParams.queries.entries()) {
		if (signal?.aborted) throw new ValidationError("Search aborted.");
		onUpdate?.({
			content: [{ type: "text", text: `Parallel searching ${index + 1}/${effectiveParams.queries.length}: ${query}` }],
			details: { phase: "searching", currentQuery: query, progress: index / effectiveParams.queries.length },
		});
		const { requestId, results } = await parallelWebSearch(query, { apiKey, params: effectiveParams, signal });
		runs.push({ query, requestId, provider: "parallel", results });
	}

	return runs;
}

async function runExaMcp(
	effectiveParams: EffectiveParams,
	signal: AbortSignal | undefined,
	onUpdate: Parameters<typeof runWebsearchQueries>[3],
	timeoutMs: number,
): Promise<WebsearchQueryRun[]> {
	const { createDefaultMcpClient } = await import("../mcp/client.js");
	const client = createDefaultMcpClient();
	const names = await client.listToolNames("exa");
	const toolName = pickWebsearchToolName(names);

	if (!toolName) {
		throw new ValidationError("Could not find a web_search Exa MCP tool. Set EXA_API_KEY to use direct REST.");
	}

	const runs: WebsearchQueryRun[] = [];

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
				livecrawl: "fallback",
				contextMaxCharacters: effectiveParams.highlightsMaxCharacters,
			},
			options: { signal, timeoutMs },
		});

		const text = response.content.map((c) => c.text).join("\n");
		let results = parseExaMcpTextToResults(text, effectiveParams.numResults);

		if (results.length === 0) {
			const citations = dedupeCitations(extractCitationsFromMcpText(text, "exa"));
			results = citations.map((c) => ({
				title: c.title,
				url: c.url,
				highlights: [],
				summary: text,
			}));
		}

		runs.push({
			query,
			provider: "exa-mcp",
			results,
		});
	}

	return runs;
}

async function runBrave(
	apiKey: string,
	effectiveParams: EffectiveParams,
	signal: AbortSignal | undefined,
	onUpdate: Parameters<typeof runWebsearchQueries>[3],
): Promise<WebsearchQueryRun[]> {
	const runs: WebsearchQueryRun[] = [];

	for (const [index, query] of effectiveParams.queries.entries()) {
		if (signal?.aborted) throw new ValidationError("Search aborted.");
		onUpdate?.({
			content: [{ type: "text", text: `Brave searching ${index + 1}/${effectiveParams.queries.length}: ${query}` }],
			details: { phase: "searching", provider: "brave", currentQuery: query },
		});

		const results = await braveWebSearch(query, {
			apiKey,
			numResults: effectiveParams.numResults,
			signal,
		});

		runs.push({ query, provider: "brave", results });
	}

	return runs;
}

function pickWebsearchToolName(names: string[]): string | null {
	const candidates = ["web_search_exa", "web_search", "exa_web_search", "search_web", "web-search"];

	for (const c of candidates) if (names.includes(c)) return c;

	return names.find((n) => n.includes("web_search")) ?? null;
}
