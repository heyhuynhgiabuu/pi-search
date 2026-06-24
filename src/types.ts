/**
 * Shared types and tool contracts for pi-search.
 *
 * Keeping all cross-module types in one place so:
 *  - tests can import them without circular deps
 *  - tools share the same return-shape contract
 *  - the public API is documented in one location
 */

/** Result returned by a single tool execution. Mirrors AgentToolResult. */
export type ToolExecuteResult = {
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
};

/** Update emitted mid-execution (streaming progress). */
export type ToolUpdate = {
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
};

/** Per-tool factory options (DI). */
export type ToolDeps = {
	/** Override current time (defaults to new Date). */
	now?: () => Date;
	/** Override abort signal in tests. */
	defaultSignal?: AbortSignal;
};

/** Tool factory signature used by index.ts to wire each tool. */
export type ToolFactory = (deps?: ToolDeps) => Parameters<typeof console.log>[0] extends never ? never : never;

/** Result from the Exa search API. */
export type ExaApiResult = {
	title?: string;
	url?: string;
	publishedDate?: string;
	author?: string;
	text?: string;
	highlights?: string[];
	summary?: string;
	score?: number;
	id?: string;
	image?: string;
};

export type ExaApiResponse = {
	requestId?: string;
	costDollars?: number | { total?: number };
	results?: ExaApiResult[];
};

/** Exa search modes. */
export type ExaSearchType = "auto" | "neural" | "instant" | "deep" | "deep-reasoning" | "deep-max";

export const EXA_SEARCH_TYPES: readonly ExaSearchType[] = [
	"auto",
	"neural",
	"instant",
	"deep",
	"deep-reasoning",
	"deep-max",
] as const;

/** Exa recency filter values. */
export type ExaRecencyFilter = "day" | "week" | "month" | "year";

export const EXA_RECENCY_FILTERS: readonly ExaRecencyFilter[] = ["day", "week", "month", "year"] as const;

/** Effective (normalized) Exa search parameters. */
export type EffectiveExaParams = {
	queries: string[];
	numResults: number;
	searchType: ExaSearchType;
	recencyFilter?: ExaRecencyFilter;
	includeDomains: string[];
	excludeDomains: string[];
	startPublishedDate?: string;
	endPublishedDate?: string;
	highlightsMaxCharacters: number;
};

/** A normalized search result shared across websearch/codesearch. */
export type NormalizedExaResult = {
	title: string;
	url: string;
	publishedDate?: string;
	author?: string;
	highlights: string[];
	summary?: string;
	text?: string;
	score?: number;
	id?: string;
};

/** A single query run within a multi-query search. */
export type ExaQueryRun = {
	query: string;
	requestId?: string;
	costDollars?: number;
	results: NormalizedExaResult[];
};

/** Exa client contract — kept narrow so tests can mock it. */
export interface ExaSearchClient {
	search(params: { query: string; effectiveParams: EffectiveExaParams; signal?: AbortSignal }): Promise<{
		requestId?: string;
		costDollars?: number;
		results: ExaApiResult[];
	}>;
}

/** Citation extracted from tool output. */
export type Citation = {
	index: number;
	url: string;
	title: string;
	source: "exa" | "context7" | "deepwiki" | "web" | "github";
};

/** Effective config resolved at extension load time. */
export type ResolvedConfig = {
	exaApiKey?: string;
	disabledTools: Set<string>;
	useRestForExa: boolean;
	mcpTimeoutMs: number;
};
