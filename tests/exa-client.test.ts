import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../src/errors.js";
import { createExaRestClient, formatExaResult, normalizeExaResults } from "../src/exa/client.js";
import type { ExaApiResult } from "../src/types.js";

const _NOW = new Date("2026-06-15T12:00:00Z");

describe("exa/client", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	describe("createExaRestClient", () => {
		it("posts to api.exa.ai/search and returns normalized shape", async () => {
			const mockFetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						requestId: "req_1",
						costDollars: { total: 0.0025 },
						results: [
							{
								title: "Hello",
								url: "https://example.com",
								publishedDate: "2026-01-01",
								author: "Alice",
								highlights: ["hi there"],
								summary: "x",
								score: 0.9,
								id: "id_1",
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);
			globalThis.fetch = mockFetch as unknown as typeof fetch;

			const client = createExaRestClient("test-key");
			const out = await client.search({
				query: "x",
				effectiveParams: {
					queries: ["x"],
					numResults: 5,
					searchType: "auto",
					includeDomains: [],
					excludeDomains: [],
					highlightsMaxCharacters: 800,
				},
			});

			expect(out.requestId).toBe("req_1");
			expect(out.costDollars).toBe(0.0025);
			expect(out.results).toHaveLength(1);
			expect(out.results[0].url).toBe("https://example.com");

			// Verify the outbound request shape
			const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
			expect(url).toBe("https://api.exa.ai/search");
			expect((init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
			const body = JSON.parse(init.body as string);
			expect(body).toMatchObject({ query: "x", type: "auto", numResults: 5 });
			expect(body.contents.highlights.maxCharacters).toBe(800);
		});

		it("throws ProviderError on 401", async () => {
			globalThis.fetch = vi
				.fn()
				.mockResolvedValue(new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
			const client = createExaRestClient("bad-key");
			await expect(
				client.search({
					query: "x",
					effectiveParams: {
						queries: ["x"],
						numResults: 5,
						searchType: "auto",
						includeDomains: [],
						excludeDomains: [],
						highlightsMaxCharacters: 800,
					},
				}),
			).rejects.toThrowError(ProviderError);
		});

		it("throws ProviderError on 429", async () => {
			globalThis.fetch = vi
				.fn()
				.mockResolvedValue(new Response("rate-limited", { status: 429 })) as unknown as typeof fetch;
			const client = createExaRestClient("k");
			await expect(
				client.search({
					query: "x",
					effectiveParams: {
						queries: ["x"],
						numResults: 5,
						searchType: "auto",
						includeDomains: [],
						excludeDomains: [],
						highlightsMaxCharacters: 800,
					},
				}),
			).rejects.toThrowError(/rate limited/);
		});

		it("throws ProviderError on invalid JSON response", async () => {
			globalThis.fetch = vi
				.fn()
				.mockResolvedValue(new Response("not-json", { status: 200 })) as unknown as typeof fetch;
			const client = createExaRestClient("k");
			await expect(
				client.search({
					query: "x",
					effectiveParams: {
						queries: ["x"],
						numResults: 5,
						searchType: "auto",
						includeDomains: [],
						excludeDomains: [],
						highlightsMaxCharacters: 800,
					},
				}),
			).rejects.toThrowError(/invalid JSON/);
		});
	});

	describe("normalizeExaResults", () => {
		it("drops results without url", () => {
			const out = normalizeExaResults([
				{ title: "no url" } as ExaApiResult,
				{ url: "https://x.com", title: "has url" },
			]);
			expect(out).toHaveLength(1);
			expect(out[0].title).toBe("has url");
		});

		it("synthesizes a title when missing", () => {
			const out = normalizeExaResults([{ url: "https://x.com" }]);
			expect(out[0].title).toBe("Result 1");
		});

		it("normalizes whitespace and caps highlights to 3", () => {
			const out = normalizeExaResults([
				{ url: "https://x.com", title: "  a  b  ", highlights: ["  h ", "h2", "h3", "h4"] },
			]);
			expect(out[0].title).toBe("a b");
			expect(out[0].highlights).toEqual(["h", "h2", "h3"]);
		});
	});

	describe("formatExaResult", () => {
		it("renders title, url, metadata, highlights", () => {
			const text = formatExaResult(
				{
					title: "T",
					url: "https://x.com",
					publishedDate: "2026-01-01",
					author: "Alice",
					score: 0.85,
					highlights: ["h1", "h2"],
				},
				0,
			);
			expect(text).toContain("1. T");
			expect(text).toContain("https://x.com");
			expect(text).toContain("published 2026-01-01");
			expect(text).toContain("author Alice");
			expect(text).toContain("score 0.850");
			expect(text).toContain("- h1");
			expect(text).toContain("- h2");
		});

		it("falls back to summary when no highlights", () => {
			const text = formatExaResult({ title: "T", url: "https://x.com", highlights: [], summary: "summary text" }, 0);
			expect(text).toContain("- summary text");
		});
	});
});
