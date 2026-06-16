import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
	readFileSync: vi.fn(() => {
		throw new Error("No test config file");
	}),
}));

interface RegisteredTool {
	name: string;
	execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
}

async function registerTools(): Promise<RegisteredTool[]> {
	vi.resetModules();
	const { default: piSearchExtension } = await import("../src/index");
	const tools: RegisteredTool[] = [];
	piSearchExtension({
		registerTool(tool) {
			tools.push(tool as unknown as RegisteredTool);
		},
	});
	return tools;
}

describe("pi-search extension", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("registers codesearch against Exa web search instead of removed code-context tool", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				result: {
					content: [{ type: "text", text: "Title: React docs\nURL: https://react.dev" }],
				},
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const codesearch = (await registerTools()).find((tool) => tool.name === "codesearch");

		expect(codesearch).toBeDefined();
		const result = await codesearch?.execute(
			"tool-call-1",
			{ query: "React useState hook examples", numResults: 3 },
			new AbortController().signal,
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(String(init.body));
		expect(body.params.name).toBe("web_search_exa");
		expect(body.params.name).not.toBe("get_code_context_exa");
		expect(body.params.arguments).toMatchObject({
			numResults: 3,
		});
		expect(body.params.arguments.query).toContain("React useState hook examples");
		expect(result).toMatchObject({
			details: {
				backend: "web_search_exa",
				citations: [{ id: "exa-1", url: "https://react.dev", source: "exa" }],
			},
		});
	});

	it("returns citation metadata on Exa-backed search results", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				result: {
					content: [
						{
							type: "text",
							text: "Title: React useState Reference\nURL: https://react.dev/reference/react/useState\nHighlights:\nuseState is a React Hook.",
						},
					],
				},
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const websearch = (await registerTools()).find((tool) => tool.name === "websearch");

		expect(websearch).toBeDefined();

		const searchResult = await websearch?.execute(
			"tool-call-citations",
			{ query: "React useState", numResults: 1 },
			new AbortController().signal,
		);

		expect(searchResult).toMatchObject({
			details: {
				citations: [
					{
						title: "React useState Reference",
						url: "https://react.dev/reference/react/useState",
						source: "exa",
					},
				],
			},
		});
		expect(JSON.stringify(searchResult)).toContain("## Sources");
	});
	it("surfaces unsupported Exa payload formats as tool errors", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				result: {
					content: { type: "text", text: "unexpected object payload" },
				},
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const websearch = (await registerTools()).find((tool) => tool.name === "websearch");

		expect(websearch).toBeDefined();
		const result = await websearch?.execute(
			"tool-call-bad-payload",
			{ query: "broken payload", numResults: 1 },
			new AbortController().signal,
		);

		expect(result).toMatchObject({
			content: [
				{
					text: expect.stringContaining("Unsupported Exa content format"),
				},
			],
		});
	});

	it("registers deepwiki against the official Streamable HTTP MCP endpoint", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"result":"React docs overview"}}}\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const deepwiki = (await registerTools()).find((tool) => tool.name === "deepwiki");

		expect(deepwiki).toBeDefined();
		const result = await deepwiki?.execute(
			"tool-call-deepwiki",
			{ operation: "ask", repo: "facebook/react", question: "How does reconciliation work?" },
			new AbortController().signal,
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://mcp.deepwiki.com/mcp");
		const body = JSON.parse(String(init.body));
		expect(body).toMatchObject({
			method: "tools/call",
			params: {
				name: "ask_question",
				arguments: {
					repoName: "facebook/react",
					question: "How does reconciliation work?",
				},
			},
		});
		expect(result).toMatchObject({
			content: [{ text: expect.stringContaining("React docs overview") }],
			details: { operation: "ask", repo: "facebook/react", backend: "deepwiki_mcp" },
		});
	});

	it("validates deepwiki repo format before calling the network", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const deepwiki = (await registerTools()).find((tool) => tool.name === "deepwiki");
		const result = await deepwiki?.execute(
			"tool-call-invalid-deepwiki",
			{ operation: "contents", repo: "react" },
			new AbortController().signal,
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			content: [{ text: expect.stringContaining('repo must be in "owner/name" format') }],
		});
	});
});
