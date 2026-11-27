import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContext7Tool } from "../../src/tools/context7.js";

const originalFetch = globalThis.fetch;

const originalEnv = { ...process.env };

// Never read the real user config (~/.pi/pi-search.json) during tests.
const HERMETIC_CONFIG = join(tmpdir(), "pi-search-test-absent.json");

function makePi(): ExtensionAPI {
	// SAFETY: Minimal ExtensionAPI stub; createContext7Tool does not invoke ExtensionAPI methods.
	return {} as never;
}

function makeCtx(): ExtensionContext {
	// SAFETY: Minimal ExtensionContext stub; context7 execute does not read ctx.
	return {} as never;
}

describe("context7 tool", () => {
	beforeEach(() => {
		for (const key of Object.keys(process.env)) delete process.env[key];
		process.env.PI_SEARCH_CONFIG_PATH = HERMETIC_CONFIG;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;

		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, originalEnv);
	});

	it("has the expected schema and label", () => {
		const tool = createContext7Tool(makePi());
		expect(tool.name).toBe("context7");
		expect(tool.label).toBe("⚙ context7");
		expect(tool.parameters).toMatchObject({ required: expect.arrayContaining(["libraryName"]) });
	});

	it("rejects missing libraryName with validation_error", async () => {
		const tool = createContext7Tool(makePi());
		const result = await tool.execute("id", {}, undefined, undefined, makeCtx());
		expect(result.details).toMatchObject({
			error: {
				code: "validation_error",
				message: expect.stringMatching(/libraryName/),
			},
		});
	});

	it("resolves library ID then fetches docs", async () => {
		const mockFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ results: [{ id: "/reactjs/react.dev", title: "React" }] }), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response("### Hooks\nuseState...", { status: 200, headers: { "content-type": "text/plain" } }),
			);

		globalThis.fetch = mockFetch;

		const tool = createContext7Tool(makePi());
		const result = await tool.execute("id", { libraryName: "react", topic: "hooks" }, undefined, undefined, makeCtx());
		expect(result.content[0].text).toContain("useState");
		expect(result.details).toMatchObject({ libraryId: "/reactjs/react.dev" });
	});

	it("respects context7 disabledTools", async () => {
		process.env.PI_SEARCH_DISABLED_TOOLS = "context7";
		const tool = createContext7Tool(makePi());
		const result = await tool.execute("id", { libraryName: "react" }, undefined, undefined, makeCtx());
		expect(result.details).toMatchObject({ error: { code: "validation_error" } });
	});

	it("accepts search response with missing title and malformed non-first results", async () => {
		const mockFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						results: [{ id: "/reactjs/react.dev" }, { totallyMalformed: 123 }, null, "bad"],
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						content: "useEffect docs",
						metadata: { title: 42, extra: true },
						unreadField: { nested: "ok" },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

		globalThis.fetch = mockFetch;

		const tool = createContext7Tool(makePi());
		const result = await tool.execute("id", { libraryName: "react" }, undefined, undefined, makeCtx());
		expect(result.content[0].text).toContain("useEffect docs");
		expect(result.details).toMatchObject({ libraryId: "/reactjs/react.dev" });
	});

	it("accepts null optionals, out-of-bound maxTokens, and extra keys in execute()", async () => {
		const mockFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ id: "/reactjs/react.dev" }] }), { status: 200 }))
			.mockResolvedValueOnce(new Response("### Hooks", { status: 200, headers: { "content-type": "text/plain" } }));

		globalThis.fetch = mockFetch;

		const tool = createContext7Tool(makePi());

		const result = await tool.execute(
			"id",
			{ libraryName: "react", topic: null, maxTokens: 500.5, extraKey: "ignored" },
			undefined,
			undefined,
			makeCtx(),
		);

		expect(result.content[0].text).toContain("Hooks");
		expect(String(mockFetch.mock.calls[1]?.[0])).toContain("tokens=500.5");
	});
});
