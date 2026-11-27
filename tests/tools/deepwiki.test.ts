import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeepwikiTool } from "../../src/tools/deepwiki.js";

const originalFetch = globalThis.fetch;

const originalEnv = { ...process.env };

// Never read the real user config (~/.pi/pi-search.json) during tests.
const HERMETIC_CONFIG = join(tmpdir(), "pi-search-test-absent.json");

function makePi(): ExtensionAPI {
	// SAFETY: Minimal ExtensionAPI stub; createDeepwikiTool does not invoke ExtensionAPI methods.
	return {} as never;
}

function makeCtx(): ExtensionContext {
	// SAFETY: Minimal ExtensionContext stub; deepwiki execute does not read ctx.
	return {} as never;
}

describe("deepwiki tool", () => {
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
		const tool = createDeepwikiTool(makePi());
		expect(tool.name).toBe("deepwiki");
		expect(tool.label).toBe("⚙ deepwiki");
		expect(tool.parameters).toMatchObject({
			required: ["repoName", "question"],
			properties: { repoName: expect.any(Object), question: expect.any(Object) },
		});
		expect(tool.parameters).not.toHaveProperty("properties.repo");
	});

	it("rejects missing repoName with validation_error", async () => {
		const tool = createDeepwikiTool(makePi());
		const result = await tool.execute("id", { question: "what is X?" }, undefined, undefined, makeCtx());
		expect(result.details).toMatchObject({
			error: {
				code: "validation_error",
				message: expect.stringMatching(/repoName/),
			},
		});
	});

	it("rejects missing question with validation_error", async () => {
		const tool = createDeepwikiTool(makePi());
		const result = await tool.execute("id", { repoName: "facebook/react" }, undefined, undefined, makeCtx());
		expect(result.details).toMatchObject({
			error: {
				code: "validation_error",
				message: expect.stringMatching(/question/),
			},
		});
	});

	it("calls the deepwiki MCP server with repoName + question", async () => {
		const mockFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response(
					JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Hooks are..." }] } }),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

		globalThis.fetch = mockFetch;

		const tool = createDeepwikiTool(makePi());

		const result = await tool.execute(
			"id",
			{ repoName: "facebook/react", question: "How do hooks work?" },
			undefined,
			undefined,
			makeCtx(),
		);

		expect(result.content[0].text).toBe("Hooks are...");
		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toBe("https://mcp.deepwiki.com/mcp");
		const body = JSON.parse(String(init?.body ?? ""));
		expect(body.method).toBe("tools/call");
		expect(body.params).toEqual({
			name: "ask_question",
			arguments: { repoName: "facebook/react", question: "How do hooks work?" },
		});
	});

	it("returns a coded error envelope on HTTP failure", async () => {
		globalThis.fetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("server error", { status: 503 }));
		const tool = createDeepwikiTool(makePi());

		const result = await tool.execute(
			"id",
			{ repoName: "facebook/react", question: "x" },
			undefined,
			undefined,
			makeCtx(),
		);

		expect(result.details).toMatchObject({ error: { code: "mcp_unavailable" } });
	});

	it("respects deepwiki disabledTools", async () => {
		process.env.PI_SEARCH_DISABLED_TOOLS = "deepwiki";
		const tool = createDeepwikiTool(makePi());

		const result = await tool.execute(
			"id",
			{ repoName: "facebook/react", question: "x" },
			undefined,
			undefined,
			makeCtx(),
		);

		expect(result.details).toMatchObject({ error: { code: "validation_error" } });
	});

	it("trims padded repoName and preserves HEAD empty repoName message", async () => {
		const tool = createDeepwikiTool(makePi());

		const emptyRes = await tool.execute("id", { repoName: "   ", question: "x" }, undefined, undefined, makeCtx());
		expect(emptyRes.details).toMatchObject({
			error: { code: "validation_error", message: "repoName is required (e.g. 'facebook/react')." },
		});

		const mockFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response(
					JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Answer" }] } }),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

		globalThis.fetch = mockFetch;

		const paddedRes = await tool.execute(
			"id",
			{ repoName: "  facebook/react  ", question: "  How?  ", extra: 1 },
			undefined,
			undefined,
			makeCtx(),
		);

		expect(paddedRes.content[0].text).toBe("Answer");
		const body = JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body ?? ""));
		expect(body.params.arguments).toEqual({ repoName: "facebook/react", question: "How?" });
	});
});
