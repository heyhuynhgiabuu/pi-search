import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FETCH_CONTENT_CUSTOM_TYPE } from "../../src/fetch/content-store.js";
import { createFirecrawlCrawlTool } from "../../src/tools/firecrawl-crawl.js";
import type { ResolvedConfig } from "../../src/types.js";

interface MockPi {
	pi: ExtensionAPI;
	appendEntry: ReturnType<typeof vi.fn>;
}

function createMockPi(): MockPi {
	const appendEntry = vi.fn();
	const partial: Partial<ExtensionAPI> = { appendEntry };
	// SAFETY: These tests only exercise `pi.appendEntry`; no other `ExtensionAPI` members are accessed.
	const pi = partial as ExtensionAPI;

	return { pi, appendEntry };
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

type MockJsonValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| Array<MockJsonValue>
	| { [key: string]: MockJsonValue };

/** Creates a mock fetch that returns specific responses in sequence */
function makeSequencedMock(...responses: Array<MockJsonValue>) {
	let idx = 0;

	return vi.fn().mockImplementation(async () => {
		const res = responses[idx++];

		if (res === undefined) {
			return new Response(JSON.stringify({ status: "completed", completed: 0, total: 0 }), { status: 200 });
		}

		return new Response(JSON.stringify(res), { status: 200 });
	});
}

describe("firecrawl_crawl tool", () => {
	const FAST_POLL_MS = 10;
	let seqFetch: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("rejects missing API key when none is configured", async () => {
		const { pi } = createMockPi();
		const tool = createFirecrawlCrawlTool(pi, mockConfig({ firecrawlApiKey: undefined }), FAST_POLL_MS);
		const result = await tool.execute("call-1", { url: "https://example.com" }, new AbortController().signal);

		expect(result.details?.error?.code).toBe("config_error");
	});

	it("submits crawl, polls to completion", async () => {
		seqFetch = makeSequencedMock(
			{ success: true, id: "crawl-123" },
			{ status: "scraping", completed: 1, total: 3 },
			{
				status: "completed",
				completed: 3,
				total: 3,
				creditsUsed: 7,
				data: [
					{ markdown: "# Page 1", metadata: { sourceURL: "https://example.com/p1", title: "Page 1" } },
					{ markdown: "# Page 2", metadata: { sourceURL: "https://example.com/p2", title: "Page 2" } },
					{ markdown: "# Page 3", metadata: { sourceURL: "https://example.com/p3", title: "Page 3" } },
				],
			},
		);
		vi.stubGlobal("fetch", seqFetch);

		const { pi } = createMockPi();
		const tool = createFirecrawlCrawlTool(pi, mockConfig(), FAST_POLL_MS);
		const result = await tool.execute("call-1", { url: "https://example.com" }, new AbortController().signal);

		expect(result.details?.pages).toBe(3);
		expect(result.details?.crawlId).toBe("crawl-123");
		expect(result.details?.sourceURL).toBe("https://example.com");
		expect(result.details?.creditsUsed).toBe(7);
	});

	it("returns errors for failed crawl", async () => {
		seqFetch = makeSequencedMock({ success: true, id: "crawl-fail" }, { status: "failed", total: 5, completed: 2 });
		vi.stubGlobal("fetch", seqFetch);

		const { pi } = createMockPi();
		const tool = createFirecrawlCrawlTool(pi, mockConfig(), FAST_POLL_MS);
		const result = await tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal);

		expect(result.details?.error?.code).toBe("provider_error");
		expect(result.content?.[0]?.text).toContain("failed");
	});

	it("returns errors for externally cancelled crawl", async () => {
		seqFetch = makeSequencedMock(
			{ success: true, id: "crawl-cancel" },
			{ status: "cancelled", total: 10, completed: 4 },
		);
		vi.stubGlobal("fetch", seqFetch);

		const { pi } = createMockPi();
		const tool = createFirecrawlCrawlTool(pi, mockConfig(), FAST_POLL_MS);
		const result = await tool.execute("call-1", { url: "https://example.com" }, new AbortController().signal);

		expect(result.details?.error?.code).toBe("provider_error");
		expect(result.content?.[0]?.text).toContain("cancelled");
	});

	it("collects pagination pages via next URL with no duplicates", async () => {
		const { pi } = createMockPi();
		const tool = createFirecrawlCrawlTool(pi, mockConfig(), FAST_POLL_MS);

		seqFetch = makeSequencedMock(
			{ success: true, id: "crawl-multi" }, // 0: submit POST
			{
				// 1: status poll GET — returns completed with next
				status: "completed",
				completed: 4,
				total: 4,
				creditsUsed: 8,
				data: [{ markdown: "page1" }, { markdown: "page2" }],
				next: "https://api.firecrawl.dev/v2/crawl/crawl-multi/next?page=2",
			},
			{
				// 2: next page GET — returns more data
				status: "completed",
				data: [{ markdown: "page3" }, { markdown: "page4" }],
			},
		);
		vi.stubGlobal("fetch", seqFetch);

		const result = await tool.execute("call-1", { url: "https://example.com" }, new AbortController().signal);

		// Should have collected all 4 unique pages
		expect(result.details?.pages).toBe(4);
		// Verify the third fetch call (index 2) is for the next URL
		const thirdCallUrl = seqFetch.mock.calls[2]?.[0];
		expect(thirdCallUrl).toContain("/next?page=2");
	});

	it("persists crawl data as full content store records", async () => {
		const { pi, appendEntry } = createMockPi();
		const tool = createFirecrawlCrawlTool(pi, mockConfig(), FAST_POLL_MS);
		seqFetch = makeSequencedMock(
			{ success: true, id: "crawl-store" }, // submit
			{
				// status poll — completed with data
				status: "completed",
				completed: 2,
				total: 2,
				creditsUsed: 5,
				data: [
					{
						url: "https://example.com/p1",
						markdown: "# Page 1",
						metadata: { sourceURL: "https://example.com/p1", title: "Page 1" },
					},
					{
						url: "https://example.com/p2",
						markdown: "# Page 2",
						metadata: { sourceURL: "https://example.com/p2", title: "Page 2" },
					},
				],
			},
		);
		vi.stubGlobal("fetch", seqFetch);

		await tool.execute("call-1", { url: "https://example.com" }, new AbortController().signal);

		// Flush setImmediate callbacks for appendEntry
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(appendEntry).toHaveBeenCalledTimes(1);
		const [entryType, record] = appendEntry.mock.calls[0];
		expect(entryType).toBe(FETCH_CONTENT_CUSTOM_TYPE);
		expect(record).toHaveProperty("id");
		expect(record).toHaveProperty("createdAt");
		expect(record.url).toBe("https://example.com");
		expect(record.text).toContain("Page 1");
		expect(record.text).toContain("https://example.com/p1");
		expect(record.text).toContain("Page 2");
	});

	it("calls onUpdate with progress during crawl", async () => {
		const { pi } = createMockPi();
		const onUpdate = vi.fn();

		seqFetch = makeSequencedMock(
			{ success: true, id: "crawl-progress" }, // submit
			{ status: "scraping", completed: 2, total: 5 }, // poll 1
			{
				status: "completed",
				completed: 5,
				total: 5,
				creditsUsed: 10,
				data: [{ markdown: "# Content", metadata: { sourceURL: "https://example.com", title: "Test" } }],
			},
		);
		vi.stubGlobal("fetch", seqFetch);

		const tool = createFirecrawlCrawlTool(pi, mockConfig(), FAST_POLL_MS);
		await tool.execute("call-1", { url: "https://example.com" }, new AbortController().signal, onUpdate);

		// Should have at least one update (submit, poll, completion)
		expect(onUpdate.mock.calls.length).toBeGreaterThanOrEqual(1);
	});

	it("attempts remote cancellation on in-flight fetch abort via signal", async () => {
		const { pi } = createMockPi();
		const tool = createFirecrawlCrawlTool(pi, mockConfig(), FAST_POLL_MS);
		const cancelFn = vi.fn();

		const fetchMock = vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
			// POST = submit
			if (!opts || opts.method === "POST" || !opts.method) {
				return new Response(JSON.stringify({ success: true, id: "crawl-inflight-abort" }), { status: 200 });
			}

			// DELETE = cancel
			if (opts.method === "DELETE") {
				cancelFn();

				return new Response(JSON.stringify({ status: "cancelled" }), { status: 200 });
			}

			// GET poll — hold until aborted
			const pollSignal = opts.signal;

			await new Promise<void>((_resolve, reject) => {
				if (pollSignal) {
					pollSignal.addEventListener("abort", () => {
						reject(new DOMException("Aborted during poll fetch", "AbortError"));
					});

					if (pollSignal.aborted) {
						reject(new DOMException("Aborted during poll fetch", "AbortError"));
					}
				}
			});

			return new Response(JSON.stringify({ status: "scraping", completed: 1, total: 5 }), { status: 200 });
		});

		vi.stubGlobal("fetch", fetchMock);

		const ac = new AbortController();
		const resultPromise = tool.execute("call-1", { url: "https://example.com" }, ac.signal);

		// Wait a tick for submit to complete and first poll to start
		await new Promise((r) => setTimeout(r, 20));

		// Abort should trigger cancel via DELETE and return aborted
		ac.abort();

		const result = await resultPromise;
		expect(cancelFn).toHaveBeenCalled();
		expect(result.details?.error?.code).toBe("aborted");
		expect(result.content?.[0]?.text).toContain("aborted");
	});

	it("rejects empty URL", async () => {
		const { pi } = createMockPi();
		const tool = createFirecrawlCrawlTool(pi, mockConfig(), FAST_POLL_MS);
		const result = await tool.execute("call-1", { url: "" }, new AbortController().signal);

		expect(result.content?.[0]?.text).toContain("Error:");
		expect(result.details?.error?.code).toBe("validation_error");
	});

	it("rejects non-http/https URL", async () => {
		const { pi } = createMockPi();
		const tool = createFirecrawlCrawlTool(pi, mockConfig(), FAST_POLL_MS);
		const result = await tool.execute("call-1", { url: "ftp://evil.com/file" }, new AbortController().signal);

		expect(result.details?.error?.code).toBe("validation_error");
	});

	it("filters non-string items from includePaths/excludePaths and accepts null optionals and extra keys", async () => {
		seqFetch = makeSequencedMock(
			{ success: true, id: "crawl-lenient" },
			{ status: "completed", completed: 1, total: 1, creditsUsed: 1, data: [{ markdown: "# Ok" }] },
		);
		vi.stubGlobal("fetch", seqFetch);

		const { pi } = createMockPi();
		const tool = createFirecrawlCrawlTool(pi, mockConfig(), FAST_POLL_MS);

		const result = await tool.execute(
			"call-1",
			{
				url: "https://example.com",
				maxPages: null,
				includePaths: ["/docs/.*", 123, null],
				excludePaths: null,
				extraKey: true,
			},
			new AbortController().signal,
		);

		expect(result.details?.crawlId).toBe("crawl-lenient");
		const submitBody = JSON.parse(String(seqFetch.mock.calls[0]?.[1]?.body ?? ""));
		expect(submitBody.limit).toBe(5);
		expect(submitBody.includePaths).toEqual(["/docs/.*"]);
		expect(submitBody.excludePaths).toBeUndefined();
	});
});
