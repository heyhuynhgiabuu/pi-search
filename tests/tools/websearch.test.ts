import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebsearchTool } from "../../src/tools/websearch.js";
import type { ResolvedConfig } from "../../src/types.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function baseConfig(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
	return {
		exaApiKey: "test-key",
		disabledTools: new Set(),
		useRestForExa: true,
		mcpTimeoutMs: 5000,
		ssrf: { allowRanges: [] },
		urlRewrites: [],
		...overrides,
	};
}

describe("websearch tool", () => {
	beforeEach(() => {
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, { PI_SEARCH_USE_REST: "true", EXA_API_KEY: "test-key" });
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, originalEnv);
	});

	it("returns the expected schema name and label", () => {
		const tool = createWebsearchTool({ appendEntry: vi.fn(), on: vi.fn() } as never, baseConfig());
		expect(tool.name).toBe("websearch");
		expect(tool.label).toBe("⚙ websearch");
	});

	it("calls the direct REST Exa endpoint with effective params", async () => {
		const mockFetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					requestId: "r",
					results: [
						{
							title: "Example",
							url: "https://example.com",
							highlights: ["h"],
							publishedDate: "2026-01-01",
							score: 0.9,
						},
					],
				}),
				{ status: 200 },
			),
		);
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const tool = createWebsearchTool({ appendEntry: vi.fn(), on: vi.fn() } as never, baseConfig());
		const result = await tool.execute(
			"id",
			{
				query: "test",
				numResults: 3,
				recencyFilter: "week",
			},
			undefined,
			undefined,
		);

		const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.exa.ai/search");
		const body = JSON.parse(init.body as string);
		expect(body.query).toBe("test");
		expect(body.numResults).toBe(3);
		expect(body.startPublishedDate).toBeDefined();

		expect(result.content[0].text).toContain("Example");
		expect(result.content[0].text).toContain("https://example.com");
		expect((result.details as { provider: string }).provider).toBe("exa-rest");
	});

	it("returns a coded error envelope when the API key is bad", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

		const tool = createWebsearchTool({ appendEntry: vi.fn(), on: vi.fn() } as never, baseConfig());
		const result = await tool.execute("id", { query: "x" }, undefined, undefined);
		expect((result.details as { error: { code: string } }).error.code).toBe("provider_error");
	});

	it("rejects both query and queries with validation_error", async () => {
		const tool = createWebsearchTool({ appendEntry: vi.fn(), on: vi.fn() } as never, baseConfig());
		const result = await tool.execute("id", { query: "a", queries: ["b"] }, undefined, undefined);
		expect((result.details as { error: { code: string } }).error.code).toBe("validation_error");
	});

	it("returns validation_error when signal is already aborted", async () => {
		const tool = createWebsearchTool({ appendEntry: vi.fn(), on: vi.fn() } as never, baseConfig());
		const controller = new AbortController();
		controller.abort();
		const result = await tool.execute("id", { query: "x" }, controller.signal, undefined);
		expect((result.details as { error: { code: string } }).error.code).toBe("validation_error");
	});

	it("respects disabledTools in config", async () => {
		const tool = createWebsearchTool(
			{ appendEntry: vi.fn(), on: vi.fn() } as never,
			baseConfig({ disabledTools: new Set(["websearch"]) }),
		);
		const result = await tool.execute("id", { query: "x" }, undefined, undefined);
		expect((result.details as { error: { code: string } }).error.code).toBe("validation_error");
		expect((result.details as { error: { message: string } }).error.message).toMatch(/disabled/);
	});

	it("streams onUpdate progress for multi-query searches", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const updates: string[] = [];
		const tool = createWebsearchTool({ appendEntry: vi.fn(), on: vi.fn() } as never, baseConfig());
		await tool.execute("id", { queries: ["a", "b"] }, undefined, (u) => {
			updates.push(u.content[0].text);
		});
		expect(updates.length).toBeGreaterThanOrEqual(2);
		expect(updates[0]).toMatch(/1\/2: a/);
		expect(updates[1]).toMatch(/2\/2: b/);
	});
});
