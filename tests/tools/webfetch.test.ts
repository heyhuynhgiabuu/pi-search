import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compile, obj, str } from "@earendil-works/pi-schema";
import { describe, expect, it, vi } from "vitest";
import { createWebFetchTool } from "../../src/tools/webfetch.js";
import type { ResolvedConfig } from "../../src/types.js";

const ErrorDetailsSchema = obj(
	{
		error: obj({ code: str(), message: str() }, { open: true }),
	},
	{ open: true },
);

const errorDetailsValidator = compile(ErrorDetailsSchema);

function createStubExtensionApi(appendEntry: ExtensionAPI["appendEntry"] = vi.fn()): ExtensionAPI {
	const partial: Pick<ExtensionAPI, "appendEntry"> = { appendEntry };

	// SAFETY: createWebFetchTool only invokes `pi.appendEntry` on the ExtensionAPI surface.
	return partial as ExtensionAPI;
}

const baseConfig: ResolvedConfig = {
	disabledTools: new Set(),
	useRestForExa: true,
	mcpTimeoutMs: 5000,
	ssrf: { allowRanges: [] },
	urlRewrites: [],
};

describe("web_fetch tool", () => {
	it("has a scoped definition and parameters", () => {
		const appendEntry = vi.fn();
		const tool = createWebFetchTool(createStubExtensionApi(appendEntry), baseConfig);
		expect(tool.name).toBe("web_fetch");
		expect(tool.parameters).toBeDefined();
		expect(tool.description).toContain("specific public URL");
		expect(tool.description).toContain("Do not use for greetings");
	});

	it("does not advertise get_fetch_content when it is disabled", () => {
		const tool = createWebFetchTool(createStubExtensionApi(), {
			...baseConfig,
			disabledTools: new Set(["get_fetch_content"]),
		});

		expect(tool.description).not.toContain("get_fetch_content");
	});

	it("returns fetch_blocked for localhost", async () => {
		const tool = createWebFetchTool(createStubExtensionApi(), baseConfig);
		const result = await tool.execute("id", { url: "http://127.0.0.1/secret" }, undefined);
		expect(errorDetailsValidator.check(result.details)).toBe(true);

		if (errorDetailsValidator.check(result.details)) {
			expect(result.details.error.code).toBe("fetch_blocked");
			expect(result.details.error.message).toMatch(/SSRF/i);
		}
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
		const tool = createWebFetchTool(createStubExtensionApi(appendEntry), baseConfig);
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

	it("does not reference disabled get_fetch_content in truncated output", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				headers: { get: () => "text/html" },
				text: async () => `<html><body><p>${"content ".repeat(1000)}</p></body></html>`,
			})),
		);

		const tool = createWebFetchTool(createStubExtensionApi(), {
			...baseConfig,
			disabledTools: new Set(["get_fetch_content"]),
		});

		const result = await tool.execute("id", { url: "https://example.com/page", maxOutputChars: 1000 }, undefined);
		expect(result.content[0]?.text).not.toContain("get_fetch_content");
		expect(result.content[0]?.text).toContain("chars total]");

		vi.unstubAllGlobals();
	});

	it("returns fetch_error on missing url like HEAD", async () => {
		const tool = createWebFetchTool(createStubExtensionApi(), baseConfig);
		const result = await tool.execute("id", {}, undefined);
		expect(errorDetailsValidator.check(result.details)).toBe(true);

		if (errorDetailsValidator.check(result.details)) {
			expect(result.details.error.code).toBe("fetch_error");
		}
	});

	it("allows out-of-bound maxOutputChars, null optionals, and extra keys", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				headers: { get: () => "text/html" },
				text: async () => `<html><body><p>${"content ".repeat(50)}</p></body></html>`,
			})),
		);

		const tool = createWebFetchTool(createStubExtensionApi(), baseConfig);

		const lowResult = await tool.execute(
			"id",
			{ url: "https://example.com/page", maxOutputChars: 50, extra: true },
			undefined,
		);

		expect(lowResult.content[0]?.text).toContain("[truncated");

		const nullResult = await tool.execute(
			"id",
			{ url: "https://example.com/page", maxOutputChars: null, extra: 1 },
			undefined,
		);

		expect(nullResult.content[0]?.text).toContain("content");

		vi.unstubAllGlobals();
	});
});
