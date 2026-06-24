import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebFetchTool } from "../../src/tools/webfetch.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

describe("web_fetch tool", () => {
	beforeEach(() => {
		for (const key of Object.keys(process.env)) delete process.env[key];
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, originalEnv);
	});

	it("has the expected schema and label", () => {
		const tool = createWebFetchTool({} as never);
		expect(tool.name).toBe("web_fetch");
		expect(tool.label).toBe("Web Fetch");
	});

	it("rejects non-http URLs with validation_error", async () => {
		const tool = createWebFetchTool({} as never);
		const result = await tool.execute("id", { url: "ftp://example.com" }, undefined, undefined);
		expect((result.details as { error: { code: string } }).error.code).toBe("validation_error");
	});

	it("strips HTML and returns clean text", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(
				new Response(
					`<html><head><title>X</title></head><body><h1>Hello</h1><script>bad()</script><p>World</p></body></html>`,
					{ status: 200, headers: { "content-type": "text/html" } },
				),
			) as unknown as typeof fetch;

		const tool = createWebFetchTool({} as never);
		const result = await tool.execute("id", { url: "https://example.com" }, undefined, undefined);
		expect(result.content[0].text).toContain("Hello");
		expect(result.content[0].text).toContain("World");
		expect(result.content[0].text).not.toContain("bad()");
	});

	it("returns fetch_error code on HTTP error", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(new Response("not found", { status: 404 })) as unknown as typeof fetch;
		const tool = createWebFetchTool({} as never);
		const result = await tool.execute("id", { url: "https://example.com/missing" }, undefined, undefined);
		expect((result.details as { error: { code: string } }).error.code).toBe("fetch_error");
	});
});
