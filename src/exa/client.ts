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

import { ProviderError } from "../errors.js";
import type { EffectiveExaParams, ExaApiResponse, ExaApiResult, ExaSearchClient } from "../types.js";

const EXA_SEARCH_URL = "https://api.exa.ai/search";

function normalizeCost(cost: ExaApiResponse["costDollars"]): number | undefined {
	if (typeof cost === "number") return cost;
	if (cost && typeof cost === "object" && typeof cost.total === "number") return cost.total;
	return undefined;
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

			let data: ExaApiResponse;
			try {
				data = (await response.json()) as ExaApiResponse;
			} catch {
				throw new ProviderError("Exa API returned invalid JSON.");
			}

			return {
				requestId: data.requestId,
				costDollars: normalizeCost(data.costDollars),
				results: Array.isArray(data.results) ? data.results : [],
			};
		},
	};
}

function buildRequestBody(query: string, p: EffectiveExaParams): Record<string, unknown> {
	return {
		query,
		type: p.searchType,
		numResults: p.numResults,
		...(p.includeDomains.length > 0 ? { includeDomains: p.includeDomains } : {}),
		...(p.excludeDomains.length > 0 ? { excludeDomains: p.excludeDomains } : {}),
		...(p.startPublishedDate ? { startPublishedDate: p.startPublishedDate } : {}),
		...(p.endPublishedDate ? { endPublishedDate: p.endPublishedDate } : {}),
		contents: {
			highlights: {
				maxCharacters: p.highlightsMaxCharacters,
			},
		},
	};
}

/** Normalize Exa results to our shared shape. */
export function normalizeExaResults(results: ExaApiResult[]) {
	return results
		.filter((r): r is ExaApiResult & { url: string } => typeof r.url === "string" && r.url.length > 0)
		.map((result, index): import("../types.js").NormalizedExaResult => ({
			title: normalizeWhitespace(result.title || "") || `Result ${index + 1}`,
			url: result.url,
			publishedDate: result.publishedDate,
			author: result.author ? normalizeWhitespace(result.author) : undefined,
			highlights: Array.isArray(result.highlights)
				? result.highlights.map(normalizeWhitespace).filter(Boolean).slice(0, 3)
				: [],
			summary: result.summary ? normalizeWhitespace(result.summary) : undefined,
			text: result.text,
			score: typeof result.score === "number" ? result.score : undefined,
			id: result.id,
		}));
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** Format a normalized result for human/model consumption. */
export function formatExaResult(result: import("../types.js").NormalizedExaResult, index: number): string {
	const lines: string[] = [`${index + 1}. ${result.title}`, `   ${result.url}`];
	const meta: string[] = [];
	if (result.publishedDate) meta.push(`published ${result.publishedDate}`);
	if (result.author) meta.push(`author ${result.author}`);
	if (typeof result.score === "number") meta.push(`score ${result.score.toFixed(3)}`);
	if (meta.length > 0) lines.push(`   - ${meta.join(" · ")}`);
	for (const h of result.highlights) lines.push(`   - ${h}`);
	if (result.highlights.length === 0 && result.summary) lines.push(`   - ${result.summary}`);
	return lines.join("\n");
}
