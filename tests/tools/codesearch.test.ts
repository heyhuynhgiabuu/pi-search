import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodesearchTool } from "../../src/tools/codesearch.js";

const originalFetch = globalThis.fetch;

const originalEnv = { ...process.env };

// Never read the real user config (~/.pi/pi-search.json) during tests.
const HERMETIC_CONFIG = join(tmpdir(), "pi-search-codesearch-test-absent.json");

function makePi(): ExtensionAPI {
	// SAFETY: Minimal ExtensionAPI stub; createCodesearchTool does not invoke ExtensionAPI methods.
	return {} as never;
}

function makeCtx(): ExtensionContext {
	// SAFETY: Minimal ExtensionContext stub; codesearch execute does not read ctx.
	return {} as never;
}

describe("codesearch tool", () => {
	beforeEach(() => {
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, {
			PI_SEARCH_CONFIG_PATH: HERMETIC_CONFIG,
			PI_SEARCH_USE_REST: "true",
			EXA_API_KEY: "test-key",
		});
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;

		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, originalEnv);
	});

	it("has the expected schema and label", () => {
		const tool = createCodesearchTool(makePi());
		expect(tool.name).toBe("codesearch");
		expect(tool.label).toBe("⚙ codesearch");
	});

	it("calls the direct REST endpoint with default searchType=neural", async () => {
		const mockFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response(JSON.stringify({ results: [{ title: "Code", url: "https://x.com" }] }), { status: 200 }),
			);

		globalThis.fetch = mockFetch;

		const tool = createCodesearchTool(makePi());
		await tool.execute("id", { query: "react hooks" }, undefined, undefined, makeCtx());

		const body = JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body ?? ""));
		expect(body.type).toBe("neural");
	});

	it("respects codesearch disabledTools via env", async () => {
		process.env.PI_SEARCH_DISABLED_TOOLS = "codesearch";
		const tool = createCodesearchTool(makePi());
		const result = await tool.execute("id", { query: "x" }, undefined, undefined, makeCtx());
		expect(result.details).toMatchObject({ error: { code: "validation_error" } });
	});

	it("preserves normalizeExaParams error details and passes extra RawExaParams and unknown fields", async () => {
		const tool = createCodesearchTool(makePi());

		const badNum = await tool.execute("id", { query: "x", numResults: 99 }, undefined, undefined, makeCtx());
		expect(badNum.details).toMatchObject({
			error: {
				code: "validation_error",
				message: "numResults must be an integer between 1 and 10.",
				details: { param: "numResults", value: 99 },
			},
		});

		const mockFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));

		globalThis.fetch = mockFetch;

		const result = await tool.execute(
			"id",
			{ query: "react", domainFilter: ["react.dev"], searchType: null, extraField: true },
			undefined,
			undefined,
			makeCtx(),
		);

		expect(result.details).toMatchObject({ provider: "exa-rest" });
		const body = JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body ?? ""));
		expect(body.includeDomains).toEqual(["react.dev"]);
		expect(body.type).toBe("neural");
	});
});
