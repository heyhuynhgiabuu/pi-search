import { describe, expect, it, vi } from "vitest";
import { createWebFetchTool } from "../../src/tools/webfetch.js";
import type { ResolvedConfig } from "../../src/types.js";

const baseConfig: ResolvedConfig = {
	disabledTools: new Set(),
	useRestForExa: true,
	mcpTimeoutMs: 5000,
	ssrf: { allowRanges: [] },
	urlRewrites: [],
};

describe("web_fetch tool", () => {
	it("has correct name and parameters", () => {
		const appendEntry = vi.fn();
		const tool = createWebFetchTool({ appendEntry } as never, baseConfig);
		expect(tool.name).toBe("web_fetch");
		expect(tool.parameters).toBeDefined();
	});

	it("returns fetch_blocked for localhost", async () => {
		const tool = createWebFetchTool({ appendEntry: vi.fn() } as never, baseConfig);
		const result = await tool.execute("id", { url: "http://127.0.0.1/secret" }, undefined);
		const err = result.details?.error as { message?: string; code?: string } | undefined;
		expect(err?.code).toBe("fetch_blocked");
		expect(err?.message).toMatch(/SSRF/i);
	});

	it("fetches HTML via mocked resolve pipeline", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				headers: { get: () => "text/html" },
				text: async () => `<html><head><title>Hi</title></head><body><p>${"content ".repeat(80)}</p></body></html>`,
			})),
		);

		const appendEntry = vi.fn();
		const tool = createWebFetchTool({ appendEntry } as never, baseConfig);
		const result = await tool.execute("id", { url: "https://example.com/page" }, undefined);
		expect(appendEntry).toHaveBeenCalledWith(
			"pi-search-fetch-content",
			expect.objectContaining({ url: "https://example.com/page" }),
		);
		expect(result.content[0]?.text).toMatch(/content/);
		expect(result.details?.extraction).toBeDefined();
		expect(result.details?.fetchId).toBeDefined();

		vi.unstubAllGlobals();
	});
});
