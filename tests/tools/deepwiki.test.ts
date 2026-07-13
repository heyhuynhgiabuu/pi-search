import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeepwikiTool } from "../../src/tools/deepwiki.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

describe("deepwiki tool", () => {
	beforeEach(() => {
		for (const key of Object.keys(process.env)) delete process.env[key];
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, originalEnv);
	});

	it("has the expected schema and label", () => {
		const tool = createDeepwikiTool({} as never);
		expect(tool.name).toBe("deepwiki");
		expect(tool.label).toBe("⚙ deepwiki");
		expect(tool.parameters).toMatchObject({
			required: ["repoName", "question"],
			properties: { repoName: expect.any(Object), question: expect.any(Object) },
		});
		expect(tool.parameters.properties).not.toHaveProperty("repo");
	});

	it("rejects missing repoName with validation_error", async () => {
		const tool = createDeepwikiTool({} as never);
		const result = await tool.execute("id", { question: "what is X?" }, undefined, undefined);
		expect((result.details as { error: { code: string } }).error.code).toBe("validation_error");
		expect((result.details as { error: { message: string } }).error.message).toMatch(/repoName/);
	});

	it("rejects missing question with validation_error", async () => {
		const tool = createDeepwikiTool({} as never);
		const result = await tool.execute("id", { repoName: "facebook/react" }, undefined, undefined);
		expect((result.details as { error: { code: string } }).error.code).toBe("validation_error");
		expect((result.details as { error: { message: string } }).error.message).toMatch(/question/);
	});

	it("calls the deepwiki MCP server with repoName + question", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(
				new Response(
					JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Hooks are..." }] } }),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			) as unknown as typeof fetch;

		const tool = createDeepwikiTool({} as never);
		const result = await tool.execute(
			"id",
			{ repoName: "facebook/react", question: "How do hooks work?" },
			undefined,
			undefined,
		);
		expect(result.content[0].text).toBe("Hooks are...");
		const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://mcp.deepwiki.com/mcp");
		const body = JSON.parse(init.body as string);
		expect(body.method).toBe("tools/call");
		expect(body.params).toEqual({
			name: "ask_question",
			arguments: { repoName: "facebook/react", question: "How do hooks work?" },
		});
	});

	it("returns a coded error envelope on HTTP failure", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(new Response("server error", { status: 503 })) as unknown as typeof fetch;
		const tool = createDeepwikiTool({} as never);
		const result = await tool.execute("id", { repoName: "facebook/react", question: "x" }, undefined, undefined);
		expect((result.details as { error: { code: string } }).error.code).toBe("mcp_unavailable");
	});

	it("respects deepwiki disabledTools", async () => {
		process.env.PI_SEARCH_DISABLED_TOOLS = "deepwiki";
		const tool = createDeepwikiTool({} as never);
		const result = await tool.execute("id", { repoName: "facebook/react", question: "x" }, undefined, undefined);
		expect((result.details as { error: { code: string } }).error.code).toBe("validation_error");
	});
});
