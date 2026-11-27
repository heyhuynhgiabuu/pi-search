import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeExaParams } from "../../src/exa/params.js";
import { parallelWebSearch } from "../../src/search/parallel.js";
import { runWebsearchQueries } from "../../src/search/run-websearch.js";
import type { ResolvedConfig } from "../../src/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function baseConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		disabledTools: new Set(),
		useRestForExa: false,
		mcpTimeoutMs: 5000,
		ssrf: { allowRanges: [] },
		urlRewrites: [],
		...overrides,
	};
}

function mockFetch(body: unknown, status = 200) {
	const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
	globalThis.fetch = fn as unknown as typeof fetch;
	return fn;
}

describe("parallelWebSearch", () => {
	it("maps params to the v1 request body and normalizes results", async () => {
		const fetchMock = mockFetch({
			search_id: "search_1",
			results: [
				{ url: "https://a.example", title: "A", publish_date: "2026-01-02", excerpts: ["x".repeat(500)] },
				{ title: "no url" },
			],
		});
		const params = normalizeExaParams({
			query: "q",
			searchType: "deep",
			numResults: 10,
			includeDomains: ["a.example"],
			excludeDomains: ["b.example"],
			startPublishedDate: "2026-01-01",
			endPublishedDate: "2026-02-01",
			highlightsMaxCharacters: 200,
		});
		const out = await parallelWebSearch("q", { apiKey: "k", params });

		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://api.parallel.ai/v1/search");
		expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");
		expect(JSON.parse(init.body as string)).toEqual({
			search_queries: ["q"],
			mode: "advanced",
			advanced_settings: {
				max_results: 10,
				source_policy: { include_domains: ["a.example"], exclude_domains: ["b.example"], after_date: "2026-01-01" },
			},
		});
		expect(out.requestId).toBe("search_1");
		expect(out.results).toHaveLength(1);
		expect(out.results[0]?.highlights[0]).toHaveLength(200);
		expect(out.results[0]?.publishedDate).toBe("2026-01-02");
	});

	it("maps auto to fast and instant to turbo, omitting empty source_policy", async () => {
		const fetchMock = mockFetch({ results: [] });
		await parallelWebSearch("q", { apiKey: "k", params: normalizeExaParams({ query: "q" }) });
		await parallelWebSearch("q", { apiKey: "k", params: normalizeExaParams({ query: "q", searchType: "instant" }) });
		const bodies = fetchMock.mock.calls.map((c) =>
			JSON.parse((c as unknown as [string, RequestInit])[1].body as string),
		);
		expect(bodies[0].mode).toBe("fast");
		expect(bodies[1].mode).toBe("turbo");
		expect(bodies[0].advanced_settings.source_policy).toBeUndefined();
	});

	it("throws coded provider errors on 401 and 429", async () => {
		const params = normalizeExaParams({ query: "q" });
		mockFetch({}, 401);
		await expect(parallelWebSearch("q", { apiKey: "k", params })).rejects.toThrow(/unauthorized/);
		mockFetch({}, 429);
		await expect(parallelWebSearch("q", { apiKey: "k", params })).rejects.toThrow(/rate limited/);
	});
});

describe("parallelWebSearch edge cases", () => {
	it("falls back to the url when title is null and sends recencyFilter as after_date", async () => {
		const fetchMock = mockFetch({ results: [{ url: "https://a.example", title: null, excerpts: [] }] });
		const params = normalizeExaParams({ query: "q", recencyFilter: "week" });
		const out = await parallelWebSearch("q", { apiKey: "k", params });
		expect(out.results[0]?.title).toBe("https://a.example");
		const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
		expect(body.advanced_settings.source_policy.after_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("wraps non-2xx bodies and invalid JSON in ProviderError", async () => {
		const params = normalizeExaParams({ query: "q" });
		mockFetch({ error: "x".repeat(1000) }, 500);
		await expect(parallelWebSearch("q", { apiKey: "k", params })).rejects.toThrow(/Parallel API error 500/);
		globalThis.fetch = vi.fn(async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
		await expect(parallelWebSearch("q", { apiKey: "k", params })).rejects.toThrow(/invalid JSON/);
	});
});

describe("runWebsearchQueries provider selection", () => {
	const ok = { results: [{ url: "https://p.example", title: "P", excerpts: ["e"] }] };

	it("uses Parallel when only a Parallel key is set", async () => {
		const fetchMock = mockFetch(ok);
		const { provider, runs } = await runWebsearchQueries(
			baseConfig({ parallelApiKey: "pk" }),
			normalizeExaParams({ query: "q" }),
			undefined,
			undefined,
		);
		expect(provider).toBe("parallel");
		expect(runs[0]?.results[0]?.url).toBe("https://p.example");
		expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("api.parallel.ai");
	});

	it("honors searchProvider=exa even when a Parallel key exists", async () => {
		const fetchMock = mockFetch({ results: [{ url: "https://e.example", title: "E" }] });
		const { provider } = await runWebsearchQueries(
			baseConfig({ exaApiKey: "ek", parallelApiKey: "pk", searchProvider: "exa" }),
			normalizeExaParams({ query: "q" }),
			undefined,
			undefined,
		);
		expect(provider).toBe("exa-rest");
		expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("api.exa.ai");
	});

	it("prefers Exa over Parallel by default when both keys are set", async () => {
		const fetchMock = mockFetch({ results: [{ url: "https://e.example", title: "E" }] });
		const { provider } = await runWebsearchQueries(
			baseConfig({ exaApiKey: "ek", parallelApiKey: "pk" }),
			normalizeExaParams({ query: "q" }),
			undefined,
			undefined,
		);
		expect(provider).toBe("exa-rest");
		expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("api.exa.ai");
	});

	it("fails over to Brave when Parallel errors", async () => {
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
			String(input).includes("parallel.ai")
				? new Response("boom", { status: 500 })
				: new Response(JSON.stringify({ web: { results: [{ title: "B", url: "https://b.example" }] } }), {
						status: 200,
					}),
		) as unknown as typeof fetch;
		const { provider } = await runWebsearchQueries(
			baseConfig({ parallelApiKey: "pk", braveApiKey: "bk" }),
			normalizeExaParams({ query: "q" }),
			undefined,
			undefined,
		);
		expect(provider).toBe("brave");
	});
});
