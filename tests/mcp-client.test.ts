import { afterEach, describe, expect, it, vi } from "vitest";
import { McpError } from "../src/errors.js";
import { createDefaultMcpClient, parseMcpMessages, textFromMcpContent } from "../src/mcp/client.js";

const ORIGINAL_FETCH = globalThis.fetch;

describe("mcp/client", () => {
	afterEach(() => {
		globalThis.fetch = ORIGINAL_FETCH;
	});

	describe("parseMcpMessages", () => {
		it("parses JSON responses", () => {
			const out = parseMcpMessages('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}', "application/json");
			expect(out).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
		});

		it("parses SSE responses", () => {
			const sse = `event: message
data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}

`;
			const out = parseMcpMessages(sse, "text/event-stream");
			expect(out).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
		});

		it("skips invalid JSON lines", () => {
			const sse = `data: not-json
data: {"ok":true}`;
			const out = parseMcpMessages(sse, "text/event-stream");
			expect(out).toEqual([{ ok: true }]);
		});
	});

	describe("textFromMcpContent", () => {
		it("joins all text parts with newlines", () => {
			const out = textFromMcpContent([
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
				{ type: "image", data: "..." },
			]);
			expect(out).toBe("a\nb");
		});
		it("returns '' for non-array content", () => {
			expect(textFromMcpContent("nope")).toBe("");
			expect(textFromMcpContent(null)).toBe("");
		});
	});

	describe("JsonRpcHttpMcpClient", () => {
		it("invokes a tool and returns normalized content", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "hi" }] } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			) as unknown as typeof fetch;

			const client = createDefaultMcpClient();
			const out = await client.invoke({
				server: "exa",
				toolName: "web_search_exa",
				arguments: { query: "x" },
			});
			expect(out.content).toEqual([{ type: "text", text: "hi" }]);
		});

		it("throws McpError on HTTP errors", async () => {
			globalThis.fetch = vi
				.fn()
				.mockResolvedValue(new Response("server error", { status: 503 })) as unknown as typeof fetch;
			const client = createDefaultMcpClient();
			await expect(client.invoke({ server: "exa", toolName: "x", arguments: {} })).rejects.toThrowError(McpError);
		});

		it("times out via AbortController", async () => {
			globalThis.fetch = vi.fn().mockImplementation(
				(_url: string, init?: RequestInit) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
					}),
			) as unknown as typeof fetch;
			const client = createDefaultMcpClient();
			await expect(
				client.invoke({ server: "exa", toolName: "x", arguments: {}, options: { timeoutMs: 10 } }),
			).rejects.toThrowError(/timed out/);
		});
	});
});
