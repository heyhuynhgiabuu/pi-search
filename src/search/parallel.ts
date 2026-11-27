import { arr, compile, nullable, obj, opt, str, unknown } from "@earendil-works/pi-schema";
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

const ParallelResultSchema = obj(
	{
		url: opt(unknown()),
		title: opt(unknown()),
		publish_date: opt(unknown()),
		excerpts: opt(unknown()),
	},
	{ open: true },
);

const ParallelResponseSchema = obj(
	{
		search_id: opt(unknown()),
		results: opt(nullable(arr(ParallelResultSchema))),
	},
	{ open: true },
);

const parallelResponseValidator = compile(ParallelResponseSchema);

const stringValidator = compile(str());

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

	let parsed: ReturnType<typeof parallelResponseValidator.validate>;

	try {
		parsed = parallelResponseValidator.validate(await response.json());
	} catch {
		throw new ProviderError("Parallel API returned invalid JSON.", { provider: "parallel" });
	}

	if (!parsed.ok) {
		const first = parsed.errors[0];
		const detail = first ? `${first.path || "/"}: ${first.message}` : "schema validation failed";
		throw new ProviderError(`Parallel API returned invalid JSON (${detail}).`, { provider: "parallel" });
	}

	const data = parsed.value;
	const results: NormalizedExaResult[] = [];

	for (const r of data.results ?? []) {
		if (!stringValidator.check(r.url) || !r.url) continue;

		const title = stringValidator.check(r.title) && r.title ? r.title : r.url;
		const excerpts = Array.isArray(r.excerpts) ? r.excerpts.filter((e): e is string => stringValidator.check(e)) : [];

		const item: NormalizedExaResult = {
			title,
			url: r.url,
			highlights: excerpts.map((e) => e.slice(0, params.highlightsMaxCharacters)),
		};

		if (stringValidator.check(r.publish_date) && r.publish_date) {
			item.publishedDate = r.publish_date;
		}

		results.push(item);
	}

	return {
		requestId: stringValidator.check(data.search_id) ? data.search_id : undefined,
		results,
	};
}

type ParallelSourcePolicy = {
	include_domains?: string[];
	exclude_domains?: string[];
	after_date?: string;
};

type ParallelRequestBody = {
	search_queries: [string];
	mode: ParallelMode;
	advanced_settings: {
		max_results: number;
		source_policy?: ParallelSourcePolicy;
	};
};

/** Parallel has no end-date bound, so `endPublishedDate` is intentionally dropped. */
function buildRequestBody(query: string, p: EffectiveExaParams): ParallelRequestBody {
	const sourcePolicy: ParallelSourcePolicy = {};

	if (p.includeDomains.length > 0) sourcePolicy.include_domains = p.includeDomains;

	if (p.excludeDomains.length > 0) sourcePolicy.exclude_domains = p.excludeDomains;

	if (p.startPublishedDate) sourcePolicy.after_date = p.startPublishedDate.slice(0, 10);

	const advancedSettings: ParallelRequestBody["advanced_settings"] = {
		max_results: Math.min(20, Math.max(1, p.numResults)),
	};

	if (Object.keys(sourcePolicy).length > 0) {
		advancedSettings.source_policy = sourcePolicy;
	}

	return {
		search_queries: [query],
		mode: MODE_BY_SEARCH_TYPE[p.searchType],
		advanced_settings: advancedSettings,
	};
}
