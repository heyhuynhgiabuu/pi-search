import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeExaParams } from "../../src/exa/params.js";
import { runWebsearchQueries } from "../../src/search/run-websearch.js";
import type { ResolvedConfig } from "../../src/types.js";

const originalFetch = globalThis.fetch;

describe("runWebsearchQueries brave failover", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("uses Brave when Exa REST fails and BRAVE_API_KEY is set", async () => {
		const mockFetch = vi.fn<typeof fetch>(async (input) => {
			const url = String(input);

			if (url.includes("api.exa.ai")) {
				return new Response("error", { status: 500 });
			}

			if (url.includes("api.search.brave.com")) {
				return new Response(
					JSON.stringify({
						web: { results: [{ title: "Brave hit", url: "https://brave.example", description: "d" }] },
					}),
					{ status: 200 },
				);
			}

			return new Response("not found", { status: 404 });
		});

		globalThis.fetch = mockFetch;

		const config: ResolvedConfig = {
			exaApiKey: "exa-key",
			braveApiKey: "brave-key",
			disabledTools: new Set(),
			useRestForExa: true,
			mcpTimeoutMs: 5000,
			ssrf: { allowRanges: [] },
			urlRewrites: [],
		};

		const params = normalizeExaParams({ query: "failover test" });
		const { runs, provider } = await runWebsearchQueries(config, params, undefined, undefined);
		expect(provider).toBe("brave");
		expect(runs[0]?.results[0]?.url).toBe("https://brave.example");
	});

	it("still fails over to Brave when Exa returns schema-invalid JSON", async () => {
		globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
			const url = String(input);

			if (url.includes("api.exa.ai")) {
				return new Response(JSON.stringify({ results: "bad" }), { status: 200 });
			}

			if (url.includes("api.search.brave.com")) {
				return new Response(
					JSON.stringify({
						web: { results: [{ title: "Brave fallback", url: "https://brave.example" }] },
					}),
					{ status: 200 },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const config: ResolvedConfig = {
			exaApiKey: "exa-key",
			braveApiKey: "brave-key",
			disabledTools: new Set(),
			useRestForExa: true,
			mcpTimeoutMs: 5000,
			ssrf: { allowRanges: [] },
			urlRewrites: [],
		};

		const params = normalizeExaParams({ query: "failover test" });
		const { runs, provider } = await runWebsearchQueries(config, params, undefined, undefined);
		expect(provider).toBe("brave");
		expect(runs[0]?.results[0]?.url).toBe("https://brave.example");
	});
});
