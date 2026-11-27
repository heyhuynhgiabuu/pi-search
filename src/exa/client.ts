/**
 * Direct REST client for https://api.exa.ai/search.
 *
 * P3 of the pi-exa-search review: switch websearch (and codesearch)
 * to direct REST for full feature access (searchType, recencyFilter,
 * domainFilter, highlights, etc.) while keeping the existing MCP
 * path as a zero-config fallback.
 *
 * Code adapted from najibninaba/pi-exa-search's exa-client.ts,
 * re-typed against our shared `types.ts`.
 */

import { arr, compile, nullable, num, obj, opt, type Static, str, unknown } from "@earendil-works/pi-schema";
import { ProviderError } from "../errors.js";
import type {
	EffectiveExaParams,
	ExaApiResult,
	ExaSearchClient,
	ExaSearchType,
	NormalizedExaResult,
} from "../types.js";

const EXA_SEARCH_URL = "https://api.exa.ai/search";

const ExaApiResultSchema = obj(
	{
		title: opt(unknown()),
		url: opt(unknown()),
		publishedDate: opt(unknown()),
		author: opt(unknown()),
		text: opt(unknown()),
		highlights: opt(unknown()),
		summary: opt(unknown()),
		score: opt(unknown()),
		id: opt(unknown()),
	},
	{ open: true },
);

const ExaApiResponseSchema = obj(
	{
		requestId: opt(unknown()),
		costDollars: opt(unknown()),
		results: opt(nullable(arr(ExaApiResultSchema))),
	},
	{ open: true },
);

type ParsedExaResponse = Static<typeof ExaApiResponseSchema>;

type ParsedExaResult = Static<typeof ExaApiResultSchema>;

const exaApiResponseValidator = compile(ExaApiResponseSchema);

const stringValidator = compile(str());

const numberValidator = compile(num());

const costObjectValidator = compile(obj({ total: num() }, { open: true }));

function normalizeCost(data: ParsedExaResponse): number | undefined {
	const cost = data.costDollars;

	if (numberValidator.check(cost)) return cost;

	if (costObjectValidator.check(cost)) return cost.total;

	return undefined;
}

function toExaApiResult(raw: ParsedExaResult): ExaApiResult {
	const result: ExaApiResult = {};

	if (stringValidator.check(raw.title)) result.title = raw.title;

	if (stringValidator.check(raw.url)) result.url = raw.url;

	if (stringValidator.check(raw.publishedDate)) result.publishedDate = raw.publishedDate;

	if (stringValidator.check(raw.author)) result.author = raw.author;

	if (stringValidator.check(raw.text)) result.text = raw.text;

	if (Array.isArray(raw.highlights)) {
		result.highlights = raw.highlights.filter((item): item is string => stringValidator.check(item));
	}

	if (stringValidator.check(raw.summary)) result.summary = raw.summary;

	if (numberValidator.check(raw.score)) result.score = raw.score;

	if (stringValidator.check(raw.id)) result.id = raw.id;

	return result;
}

export function createExaRestClient(apiKey: string): ExaSearchClient {
	return {
		async search({ query, effectiveParams, signal }) {
			const response = await fetch(EXA_SEARCH_URL, {
				method: "POST",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					"x-api-key": apiKey,
				},
				body: JSON.stringify(buildRequestBody(query, effectiveParams)),
				signal,
			});

			if (!response.ok) {
				const text = await response.text();

				if (response.status === 401 || response.status === 403) {
					throw new ProviderError(`Exa API unauthorized (${response.status}). Check your API key.`);
				}

				if (response.status === 429) {
					throw new ProviderError(`Exa API rate limited (${response.status}). Try again later.`);
				}

				throw new ProviderError(`Exa API error ${response.status}: ${text.slice(0, 300)}`);
			}

			let parsed: ReturnType<typeof exaApiResponseValidator.validate>;

			try {
				parsed = exaApiResponseValidator.validate(await response.json());
			} catch {
				throw new ProviderError("Exa API returned invalid JSON.");
			}

			if (!parsed.ok) {
				const first = parsed.errors[0];
				const detail = first ? `${first.path || "/"}: ${first.message}` : "schema validation failed";
				throw new ProviderError(`Exa API returned invalid JSON (${detail}).`);
			}

			const data = parsed.value;

			return {
				requestId: stringValidator.check(data.requestId) ? data.requestId : undefined,
				costDollars: normalizeCost(data),
				results: (data.results ?? []).map(toExaApiResult),
			};
		},
	};
}

type ExaSearchRequestBody = {
	query: string;
	type: ExaSearchType;
	numResults: number;
	includeDomains?: string[];
	excludeDomains?: string[];
	startPublishedDate?: string;
	endPublishedDate?: string;
	contents: {
		highlights: {
			maxCharacters: number;
		};
	};
};

function buildRequestBody(query: string, p: EffectiveExaParams): ExaSearchRequestBody {
	const body: ExaSearchRequestBody = {
		query,
		type: p.searchType,
		numResults: p.numResults,
		contents: {
			highlights: {
				maxCharacters: p.highlightsMaxCharacters,
			},
		},
	};

	if (p.includeDomains.length > 0) body.includeDomains = p.includeDomains;

	if (p.excludeDomains.length > 0) body.excludeDomains = p.excludeDomains;

	if (p.startPublishedDate) body.startPublishedDate = p.startPublishedDate;

	if (p.endPublishedDate) body.endPublishedDate = p.endPublishedDate;

	return body;
}

/** Normalize Exa results to our shared shape. */
export function normalizeExaResults(results: ExaApiResult[]): NormalizedExaResult[] {
	const normalized: NormalizedExaResult[] = [];

	for (const result of results) {
		if (!result.url) continue;

		const index = normalized.length;

		normalized.push({
			title: normalizeWhitespace(result.title || "") || `Result ${index + 1}`,
			url: result.url,
			publishedDate: result.publishedDate,
			author: result.author ? normalizeWhitespace(result.author) : undefined,
			highlights: Array.isArray(result.highlights)
				? result.highlights.map(normalizeWhitespace).filter(Boolean).slice(0, 3)
				: [],
			summary: result.summary ? normalizeWhitespace(result.summary) : undefined,
			text: result.text,
			score: result.score !== undefined && Number.isFinite(result.score) ? result.score : undefined,
			id: result.id,
		});
	}

	return normalized;
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** Format a normalized result for human/model consumption. */
export function formatExaResult(result: NormalizedExaResult, index: number): string {
	const lines: string[] = [`${index + 1}. ${result.title}`, `   ${result.url}`];
	const meta: string[] = [];

	if (result.publishedDate) meta.push(`published ${result.publishedDate}`);

	if (result.author) meta.push(`author ${result.author}`);

	if (result.score !== undefined) meta.push(`score ${result.score.toFixed(3)}`);

	if (meta.length > 0) lines.push(`   - ${meta.join(" · ")}`);

	for (const h of result.highlights) lines.push(`   - ${h}`);

	if (result.highlights.length === 0 && result.summary) lines.push(`   - ${result.summary}`);

	return lines.join("\n");
}
