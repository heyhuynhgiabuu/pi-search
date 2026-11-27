import { ProviderError } from "../errors.js";
import type { EffectiveExaParams, ExaSearchType, NormalizedExaResult } from "../types.js";

const PARALLEL_SEARCH_URL = "https://api.parallel.ai/v1/search";

type ParallelMode = "turbo" | "fast" | "advanced";

const MODE_BY_SEARCH_TYPE: Record<ExaSearchType, ParallelMode> = {
	instant: "turbo",
	auto: "fast",
	neural: "fast",
	deep: "advanced",
	"deep-reasoning": "advanced",
	"deep-max": "advanced",
};

type ParallelResponse = {
	search_id?: string;
	results?: Array<{ url?: string; title?: string | null; publish_date?: string | null; excerpts?: string[] }>;
};

export async function parallelWebSearch(
	query: string,
	options: { apiKey: string; params: EffectiveExaParams; signal?: AbortSignal },
): Promise<{ requestId?: string; results: NormalizedExaResult[] }> {
	const { params } = options;
	const response = await fetch(PARALLEL_SEARCH_URL, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": options.apiKey },
		body: JSON.stringify(buildRequestBody(query, params)),
		signal: options.signal,
	});

	if (response.status === 401 || response.status === 403) {
		throw new ProviderError(
			`Parallel: unauthorized (${response.status}). Check PARALLEL_API_KEY or parallelApiKey in ~/.pi/pi-search.json`,
			{ provider: "parallel", status: response.status },
		);
	}
	if (response.status === 429) {
		throw new ProviderError("Parallel: rate limited", { provider: "parallel", status: 429 });
	}
	if (!response.ok) {
		const text = await response.text();
		throw new ProviderError(`Parallel API error ${response.status}: ${text.slice(0, 300)}`, {
			provider: "parallel",
			status: response.status,
		});
	}

	let data: ParallelResponse;
	try {
		data = (await response.json()) as ParallelResponse;
	} catch {
		throw new ProviderError("Parallel API returned invalid JSON.", { provider: "parallel" });
	}

	const results = (Array.isArray(data?.results) ? data.results : [])
		.filter((r) => typeof r.url === "string" && r.url.length > 0)
		.map((r) => ({
			title: r.title || (r.url as string),
			url: r.url as string,
			...(r.publish_date ? { publishedDate: r.publish_date } : {}),
			highlights: (Array.isArray(r.excerpts) ? r.excerpts : []).map((e) => e.slice(0, params.highlightsMaxCharacters)),
		}));
	return { requestId: data?.search_id, results };
}

/** Parallel has no end-date bound, so `endPublishedDate` is intentionally dropped. */
function buildRequestBody(query: string, p: EffectiveExaParams): Record<string, unknown> {
	const sourcePolicy = {
		...(p.includeDomains.length > 0 ? { include_domains: p.includeDomains } : {}),
		...(p.excludeDomains.length > 0 ? { exclude_domains: p.excludeDomains } : {}),
		...(p.startPublishedDate ? { after_date: p.startPublishedDate.slice(0, 10) } : {}),
	};
	return {
		search_queries: [query],
		mode: MODE_BY_SEARCH_TYPE[p.searchType],
		advanced_settings: {
			max_results: Math.min(20, Math.max(1, p.numResults)),
			...(Object.keys(sourcePolicy).length > 0 ? { source_policy: sourcePolicy } : {}),
		},
	};
}
