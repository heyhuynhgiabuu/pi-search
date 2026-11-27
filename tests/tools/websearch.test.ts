import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebsearchTool } from "../../src/tools/websearch.js";
import type { ResolvedConfig } from "../../src/types.js";

const originalFetch = globalThis.fetch;

const originalEnv = { ...process.env };

function makePi(): ExtensionAPI {
	// SAFETY: Test stub providing only the ExtensionAPI methods exercised by websearch.
	return { appendEntry: vi.fn(), on: vi.fn() } as never;
}

function makeCtx(): ExtensionContext {
	// SAFETY: Minimal ExtensionContext stub; websearch execute does not read ctx.
	return {} as never;
}

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

	it("returns a scoped web tool definition", () => {
		const tool = createWebsearchTool(makePi(), baseConfig());
		expect(tool.name).toBe("websearch");
		expect(tool.label).toBe("⚙ websearch");
		expect(tool.description).toContain("external");
		expect(tool.description).toContain("Do not use for greetings");
	});

	it("hides stored-content fetching when get_fetch_content is disabled", () => {
		const tool = createWebsearchTool(makePi(), baseConfig({ disabledTools: new Set(["get_fetch_content"]) }));

		expect(tool.parameters).not.toHaveProperty("properties.includeContent");
	});

	it("ignores stored-content fetching when get_fetch_content is disabled", async () => {
		const mockFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response(
					JSON.stringify({ results: [{ title: "Example", url: "https://example.com/page", highlights: ["h"] }] }),
					{ status: 200 },
				),
			);

		globalThis.fetch = mockFetch;

		const tool = createWebsearchTool(makePi(), baseConfig({ disabledTools: new Set(["get_fetch_content"]) }));

		const result = await tool.execute("id", { query: "test", includeContent: true }, undefined, undefined, makeCtx());

		expect(result.content[0].text).not.toContain("get_fetch_content");
		expect(result.details).toMatchObject({ includeContent: false });
	});

	it("calls the direct REST Exa endpoint with effective params", async () => {
		const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
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

		globalThis.fetch = mockFetch;

		const tool = createWebsearchTool(makePi(), baseConfig());

		const result = await tool.execute(
			"id",
			{
				query: "test",
				numResults: 3,
				recencyFilter: "week",
			},
			undefined,
			undefined,
			makeCtx(),
		);

		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toBe("https://api.exa.ai/search");
		const body = JSON.parse(String(init?.body ?? ""));
		expect(body.query).toBe("test");
		expect(body.numResults).toBe(3);
		expect(body.startPublishedDate).toBeDefined();

		expect(result.content[0].text).toContain("Example");
		expect(result.content[0].text).toContain("https://example.com");
		expect(result.details).toMatchObject({ provider: "exa-rest" });
	});

	it("returns a coded error envelope when the API key is bad", async () => {
		globalThis.fetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("unauthorized", { status: 401 }));

		const tool = createWebsearchTool(makePi(), baseConfig());
		const result = await tool.execute("id", { query: "x" }, undefined, undefined, makeCtx());
		expect(result.details).toMatchObject({ error: { code: "provider_error" } });
	});

	it("rejects both query and queries with validation_error", async () => {
		const tool = createWebsearchTool(makePi(), baseConfig());
		const result = await tool.execute("id", { query: "a", queries: ["b"] }, undefined, undefined, makeCtx());
		expect(result.details).toMatchObject({ error: { code: "validation_error" } });
	});

	it("returns validation_error when signal is already aborted", async () => {
		const tool = createWebsearchTool(makePi(), baseConfig());
		const controller = new AbortController();
		controller.abort();
		const result = await tool.execute("id", { query: "x" }, controller.signal, undefined, makeCtx());
		expect(result.details).toMatchObject({ error: { code: "validation_error" } });
	});

	it("respects disabledTools in config", async () => {
		const tool = createWebsearchTool(makePi(), baseConfig({ disabledTools: new Set(["websearch"]) }));

		const result = await tool.execute("id", { query: "x" }, undefined, undefined, makeCtx());
		expect(result.details).toMatchObject({
			error: {
				code: "validation_error",
				message: expect.stringMatching(/disabled/),
			},
		});
	});

	it("streams onUpdate progress for multi-query searches", async () => {
		const mockFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));

		globalThis.fetch = mockFetch;

		const updates: string[] = [];
		const tool = createWebsearchTool(makePi(), baseConfig());
		await tool.execute(
			"id",
			{ queries: ["a", "b"] },
			undefined,
			(u) => {
				const first = u.content[0];

				if (first?.type === "text") updates.push(first.text);
			},
			makeCtx(),
		);
		expect(updates.length).toBeGreaterThanOrEqual(2);
		expect(updates[0]).toMatch(/1\/2: a/);
		expect(updates[1]).toMatch(/2\/2: b/);
	});

	it("preserves normalizeExaParams error details for out-of-bound numResults and invalid searchType", async () => {
		const tool = createWebsearchTool(makePi(), baseConfig());

		const badNum = await tool.execute("id", { query: "x", numResults: 99 }, undefined, undefined, makeCtx());
		expect(badNum.details).toMatchObject({
			error: {
				code: "validation_error",
				message: "numResults must be an integer between 1 and 10.",
				details: { param: "numResults", value: 99 },
			},
		});

		const badType = await tool.execute("id", { query: "x", searchType: "bogus" }, undefined, undefined, makeCtx());
		expect(badType.details).toMatchObject({
			error: {
				code: "validation_error",
				message: "Invalid searchType: bogus",
				details: { allowed: expect.arrayContaining(["auto", "neural"]) },
			},
		});
	});

	it("allows null optionals and unknown extra keys in execute()", async () => {
		const mockFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response(JSON.stringify({ results: [{ title: "Ex", url: "https://example.com" }] }), { status: 200 }),
			);

		globalThis.fetch = mockFetch;

		const tool = createWebsearchTool(makePi(), baseConfig());

		const result = await tool.execute(
			"id",
			{ query: "test", numResults: null, recencyFilter: null, extraField: "ignored" },
			undefined,
			undefined,
			makeCtx(),
		);

		expect(result.details).toMatchObject({ provider: "exa-rest" });
	});
});
