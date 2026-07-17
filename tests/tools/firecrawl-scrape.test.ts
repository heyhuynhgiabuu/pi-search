import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFirecrawlScrapeTool } from "../../src/tools/firecrawl-scrape.js";
import type { ResolvedConfig } from "../../src/types.js";

function mockPi() {
	return { appendEntry: vi.fn() } as unknown as Parameters<typeof createFirecrawlScrapeTool>[0];
}

function mockConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		exaApiKey: undefined,
		braveApiKey: undefined,
		firecrawlApiKey: "fc-test-key",
		disabledTools: new Set(),
		useRestForExa: false,
		mcpTimeoutMs: 30000,
		ssrf: { allowRanges: [] },
		githubToken: undefined,
		urlRewrites: [],
		...overrides,
	};
}

describe("firecrawl_scrape tool", () => {
	const tool = createFirecrawlScrapeTool(mockPi(), mockConfig());

	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("describes credit consumption in tool description", () => {
		expect(tool.description).toContain("credit");
	});

	it("rejects missing API key", async () => {
		const toolNoKey = createFirecrawlScrapeTool(mockPi(), mockConfig({ firecrawlApiKey: undefined }));
		const result = await toolNoKey.execute("call-1", { url: "https://example.com" }, new AbortController().signal);

		expect(result.details?.error?.code).toBe("config_error");
	});

	it("fetches markdown content for valid URL", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				headers: new Map(),
				json: () =>
					Promise.resolve({
						success: true,
						data: {
							markdown: "# Hello\n\nThis is scraped content.",
							metadata: { title: "Test Page", sourceURL: "https://example.com" },
						},
					}),
			}),
		);

		const result = await tool.execute("call-1", { url: "https://example.com" }, new AbortController().signal);

		expect(result.content?.[0]?.text).toContain("Hello");
		expect(result.details?.sourceURL).toBe("https://example.com");
		expect(result.details?.scrapeMethod).toBe("firecrawl");
	});

	it("includes source metadata in output", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				headers: new Map(),
				json: () =>
					Promise.resolve({
						success: true,
						data: {
							markdown: "Content",
							metadata: { title: "My Page", sourceURL: "https://example.com/page" },
						},
					}),
			}),
		);

		const result = await tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal);

		expect(result.details?.title).toBe("My Page");
		expect(result.content?.[0]?.text).toContain("# My Page");
	});

	it("rejects empty URL", async () => {
		const result = await tool.execute("call-1", { url: "" }, new AbortController().signal);

		expect(result.content?.[0]?.text).toContain("Error:");
		expect(result.details?.error?.code).toBe("validation_error");
	});

	it("rejects non-http/https URL", async () => {
		const result = await tool.execute("call-1", { url: "ftp://evil.com/file" }, new AbortController().signal);

		expect(result.details?.error?.code).toBe("validation_error");
	});

	it("defaults onlyMainContent to true when not specified", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Map(),
			json: () => Promise.resolve({ success: true, data: { markdown: "content" } }),
		});
		vi.stubGlobal("fetch", fetchMock);

		await tool.execute("call-1", { url: "https://example.com" }, new AbortController().signal);

		const calledBody = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(calledBody.onlyMainContent).toBe(true);
	});

	it("always sends formats as ['markdown'] in request body", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Map(),
			json: () => Promise.resolve({ success: true, data: { markdown: "content" } }),
		});
		vi.stubGlobal("fetch", fetchMock);

		await tool.execute("call-1", { url: "https://example.com" }, new AbortController().signal);

		const calledBody = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(calledBody.formats).toEqual(["markdown"]);
	});

	it("narrows non-string metadata.title to empty string", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				headers: new Map(),
				json: () =>
					Promise.resolve({
						success: true,
						data: {
							markdown: "Content",
							metadata: { title: 42 },
						},
					}),
			}),
		);

		const result = await tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal);

		expect(result.details?.title).toBeUndefined();
	});

	it("returns aborted status when signal is aborted before fetch", async () => {
		const ac = new AbortController();
		ac.abort(); // abort BEFORE calling execute
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
				if (opts?.signal?.aborted) {
					throw new DOMException("The operation was aborted", "AbortError");
				}
				return {
					ok: true,
					status: 200,
					headers: new Map(),
					json: () => Promise.resolve({ success: true, data: { markdown: "x" } }),
				};
			}),
		);

		const result = await tool.execute("call-1", { url: "https://example.com" }, ac.signal);
		expect(result.details?.error?.code).toBe("aborted");
	});

	it("returns aborted status when signal is aborted during in-flight fetch", async () => {
		const ac = new AbortController();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
				if (opts?.signal?.aborted) {
					throw new DOMException("The operation was aborted", "AbortError");
				}
				await new Promise<void>((_resolve, reject) => {
					opts?.signal?.addEventListener("abort", () => {
						reject(new DOMException("The operation was aborted", "AbortError"));
					});
				});
			}),
		);

		const promise = tool.execute("call-1", { url: "https://example.com" }, ac.signal);
		ac.abort();

		const result = await promise;
		expect(result.details?.error?.code).toBe("aborted");
	});
});
