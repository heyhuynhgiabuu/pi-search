import { describe, expect, it } from "vitest";
import { resolveConfig, validateDisabledTools } from "../src/config.js";
import piSearchExtension, { TOOL_NAMES } from "../src/index.js";

describe("pi-search extension", () => {
	it("exports tool names", () => {
		expect(TOOL_NAMES).toEqual(["websearch", "codesearch", "context7", "deepwiki", "web_fetch", "get_fetch_content"]);
	});

	it("extension registers all tools by default", () => {
		const registered: string[] = [];
		const fakePi = {
			registerTool(tool: { name: string }) {
				registered.push(tool.name);
			},
			on() {},
		} as never;
		piSearchExtension(fakePi);
		expect(registered.sort()).toEqual([
			"codesearch",
			"context7",
			"deepwiki",
			"get_fetch_content",
			"web_fetch",
			"websearch",
		]);
		expect(typeof (fakePi as { on?: unknown }).on).toBe("function");
	});

	it("extension skips disabled tools", () => {
		const registered: string[] = [];
		const fakePi = {
			registerTool(tool: { name: string }) {
				registered.push(tool.name);
			},
			on() {},
		} as never;
		// Force config to mark some tools as disabled by mutating the resolved config via env
		const original = process.env.PI_SEARCH_DISABLED_TOOLS;
		process.env.PI_SEARCH_DISABLED_TOOLS = "codesearch,deepwiki";
		try {
			piSearchExtension(fakePi);
			expect(registered.sort()).toEqual(["context7", "get_fetch_content", "web_fetch", "websearch"]);
		} finally {
			if (original === undefined) delete process.env.PI_SEARCH_DISABLED_TOOLS;
			else process.env.PI_SEARCH_DISABLED_TOOLS = original;
		}
	});

	it("extension throws on unknown disabled tool", () => {
		const original = process.env.PI_SEARCH_DISABLED_TOOLS;
		process.env.PI_SEARCH_DISABLED_TOOLS = "totally-bogus";
		try {
			expect(() => piSearchExtension({} as never)).toThrowError(/Unknown tool/);
		} finally {
			if (original === undefined) delete process.env.PI_SEARCH_DISABLED_TOOLS;
			else process.env.PI_SEARCH_DISABLED_TOOLS = original;
		}
	});

	it("resolveConfig is re-exported and works", () => {
		const config = resolveConfig({ env: {}, homeDir: "/tmp/pi-search-nonexistent" });
		expect(config.disabledTools).toBeInstanceOf(Set);
	});

	it("validateDisabledTools is re-exported and works", () => {
		expect(() => validateDisabledTools(new Set(["websearch"]), TOOL_NAMES)).not.toThrow();
		expect(() => validateDisabledTools(new Set(["bogus"]), TOOL_NAMES)).toThrowError(/Unknown tool/);
	});
});
