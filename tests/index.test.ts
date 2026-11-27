import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, validateDisabledTools } from "../src/config.js";
import piSearchExtension, {
	type ErrorDetails,
	type McpToolArguments,
	TOOL_NAMES,
	type ToolDetails,
} from "../src/index.js";

// Never read the real user config (~/.pi/pi-search.json) during tests.
const HERMETIC_CONFIG = join(tmpdir(), "pi-search-test-absent.json");

const originalConfigPath = process.env.PI_SEARCH_CONFIG_PATH;

function asExtensionApi(stub: {
	registerTool?: (tool: { name: string; label: string }) => void;
	on?: () => void;
}): ExtensionAPI {
	// SAFETY: Minimal ExtensionAPI test stub recording registerTool/on calls.
	return stub as never;
}

describe("pi-search extension", () => {
	beforeEach(() => {
		process.env.PI_SEARCH_CONFIG_PATH = HERMETIC_CONFIG;
	});
	afterEach(() => {
		if (originalConfigPath === undefined) delete process.env.PI_SEARCH_CONFIG_PATH;
		else process.env.PI_SEARCH_CONFIG_PATH = originalConfigPath;
	});
	it("exports tool names", () => {
		expect(TOOL_NAMES).toEqual([
			"websearch",
			"codesearch",
			"context7",
			"deepwiki",
			"web_fetch",
			"get_fetch_content",
			"firecrawl_scrape",
			"firecrawl_crawl",
		]);
	});

	it("extension registers all tools with the pi-search title icon", () => {
		const registered: Array<{ name: string; label: string }> = [];

		const fakePi = {
			registerTool(tool: { name: string; label: string }) {
				registered.push(tool);
			},
			on() {},
		};

		piSearchExtension(asExtensionApi(fakePi));
		expect(registered.map((tool) => tool.name).sort()).toEqual([
			"codesearch",
			"context7",
			"deepwiki",
			"firecrawl_crawl",
			"firecrawl_scrape",
			"get_fetch_content",
			"web_fetch",
			"websearch",
		]);
		expect(registered.every((tool) => tool.label.startsWith("⚙ "))).toBe(true);
		expect(Object.fromEntries(registered.map((tool) => [tool.name, tool.label]))).toEqual({
			websearch: "⚙ websearch",
			codesearch: "⚙ codesearch",
			context7: "⚙ context7",
			deepwiki: "⚙ deepwiki",
			web_fetch: "⚙ web_fetch",
			get_fetch_content: "⚙ get_fetch_content",
			firecrawl_scrape: "⚙ firecrawl_scrape",
			firecrawl_crawl: "⚙ firecrawl_crawl",
		});
		expect(fakePi.on).toEqual(expect.any(Function));
	});

	it("extension skips disabled tools", () => {
		const registered: string[] = [];

		const fakePi = {
			registerTool(tool: { name: string }) {
				registered.push(tool.name);
			},
			on() {},
		};

		// Force config to mark some tools as disabled by mutating the resolved config via env
		const original = process.env.PI_SEARCH_DISABLED_TOOLS;
		process.env.PI_SEARCH_DISABLED_TOOLS = "codesearch,deepwiki";

		try {
			piSearchExtension(asExtensionApi(fakePi));
			expect(registered.sort()).toEqual([
				"context7",
				"firecrawl_crawl",
				"firecrawl_scrape",
				"get_fetch_content",
				"web_fetch",
				"websearch",
			]);
		} finally {
			if (original === undefined) delete process.env.PI_SEARCH_DISABLED_TOOLS;
			else process.env.PI_SEARCH_DISABLED_TOOLS = original;
		}
	});

	it("extension throws on unknown disabled tool", () => {
		const original = process.env.PI_SEARCH_DISABLED_TOOLS;
		process.env.PI_SEARCH_DISABLED_TOOLS = "totally-bogus";

		try {
			expect(() => piSearchExtension(asExtensionApi({}))).toThrowError(/Unknown tool/);
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

	it("exports McpToolArguments, ErrorDetails, and ToolDetails types", () => {
		const args: McpToolArguments = { query: "react", nested: { opt: undefined } };
		const errDetails: ErrorDetails = { param: "numResults", nested: { value: 99 } };
		const toolDetails: ToolDetails = { provider: "exa", extra: [1, "a"] };
		expect(args.query).toBe("react");
		expect(errDetails.param).toBe("numResults");
		expect(toolDetails.provider).toBe("exa");
	});
});
