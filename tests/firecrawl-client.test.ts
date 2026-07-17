import { describe, expect, it, vi } from "vitest";
import { type CrawlSubmitParams, FirecrawlClient, type ScrapeParams } from "../src/firecrawl/client.js";

function mockFetch(status: number, body: unknown, headers?: Record<string, string>): typeof globalThis.fetch {
	return vi.fn().mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		headers: new Map(Object.entries(headers ?? {})),
		json: () => Promise.resolve(body),
	}) as unknown as typeof globalThis.fetch;
}

function mockFetchFn(): ReturnType<typeof vi.fn> {
	return vi.fn();
}

describe("FirecrawlClient", () => {
	const API_KEY = "fc-test-key";

	describe("scrape", () => {
		it("sends correct request headers and body", async () => {
			const fetch = mockFetchFn();
			fetch.mockResolvedValue({
				ok: true,
				status: 200,
				headers: new Map(),
				json: () => Promise.resolve({ success: true, data: { markdown: "# Hello" } }),
			});

			const client = new FirecrawlClient({ apiKey: API_KEY, fetch: fetch as unknown as typeof globalThis.fetch });
			const params: ScrapeParams = { url: "https://example.com", onlyMainContent: true };
			await client.scrape(params);

			expect(fetch).toHaveBeenCalledTimes(1);
			const [url, opts] = fetch.mock.calls[0];
			expect(url).toBe("https://api.firecrawl.dev/v2/scrape");
			expect(opts.method).toBe("POST");
			expect(opts.headers).toMatchObject({
				Authorization: `Bearer ${API_KEY}`,
				"Content-Type": "application/json",
			});
			expect(JSON.parse(opts.body)).toEqual({
				url: "https://example.com",
				onlyMainContent: true,
				formats: ["markdown"],
			});
		});

		it("returns markdown and metadata on success", async () => {
			const fetch = mockFetch(200, {
				success: true,
				data: {
					markdown: "# Hello\n\nThis is content.",
					metadata: { title: "Test", sourceURL: "https://example.com" },
				},
			});
			const client = new FirecrawlClient({ apiKey: API_KEY, fetch });

			const result = await client.scrape({ url: "https://example.com" });
			expect(result.markdown).toBe("# Hello\n\nThis is content.");
			expect(result.metadata?.title).toBe("Test");
		});

		it("throws ProviderError with firecrawl_auth_error code on 401", async () => {
			const fetch = mockFetch(401, { success: false, error: "Unauthorized: Invalid token" });
			const client = new FirecrawlClient({ apiKey: API_KEY, fetch });

			const err = await client.scrape({ url: "https://example.com" }).catch((e) => e);
			expect(err.code).toBe("firecrawl_auth_error");
			expect(err.message).toContain("Unauthorized: Invalid token");
		});

		it("throws ProviderError with firecrawl_rate_limited code on 429", async () => {
			const fetch = mockFetch(429, { success: false, error: "Rate limit exceeded" });
			const client = new FirecrawlClient({ apiKey: API_KEY, fetch });

			const err = await client.scrape({ url: "https://example.com" }).catch((e) => e);
			expect(err.code).toBe("firecrawl_rate_limited");
			expect(err.message).toContain("Rate limit exceeded");
		});

		it("throws ProviderError with provider_error code on 5xx", async () => {
			const fetch = mockFetch(502, { success: false, error: "Bad Gateway" });
			const client = new FirecrawlClient({ apiKey: API_KEY, fetch });

			const err = await client.scrape({ url: "https://example.com" }).catch((e) => e);
			expect(err.code).toBe("provider_error");
			expect(err.message).toContain("Bad Gateway");
		});

		it("throws ProviderError with provider_error on malformed 2xx response (missing data)", async () => {
			const fetch = mockFetch(200, { success: true });
			const client = new FirecrawlClient({ apiKey: API_KEY, fetch });

			const err = await client.scrape({ url: "https://example.com" }).catch((e) => e);
			expect(err.code).toBe("provider_error");
			expect(err.message).toMatch(/missing/i);
		});

		it("throws ProviderError with provider_error on malformed 2xx response when data is not an object", async () => {
			const fetch = mockFetch(200, { success: true, data: "notanobject" });
			const client = new FirecrawlClient({ apiKey: API_KEY, fetch });

			const err = await client.scrape({ url: "https://example.com" }).catch((e) => e);
			expect(err.code).toBe("provider_error");
			expect(err.message).toMatch(/data/i);
		});

		it("throws ProviderError on invalid JSON in 2xx response", async () => {
			const fetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				headers: new Map(),
				json: () => Promise.reject(new SyntaxError("Unexpected token")),
			}) as unknown as typeof globalThis.fetch;
			const client = new FirecrawlClient({ apiKey: API_KEY, fetch });

			const err = await client.scrape({ url: "https://example.com" }).catch((e: Error) => e);
			expect(err.code).toBe("provider_error");
		});

		it("throws ProviderError on success=false in scrape response", async () => {
			const fetch = mockFetch(200, { success: false, data: { markdown: "x" } });
			const client = new FirecrawlClient({ apiKey: API_KEY, fetch });

			const err = await client.scrape({ url: "https://example.com" }).catch((e: Error) => e);
			expect(err.code).toBe("provider_error");
			expect(err.message).toContain("success=false");
		});

		it("passes AbortSignal to fetch and rejects with aborted on user abort", async () => {
			const ac = new AbortController();
			const fetch = vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
				await new Promise<void>((_resolve, reject) => {
					if (opts?.signal?.aborted) {
						reject(new DOMException("The operation was aborted", "AbortError"));
						return;
					}
					opts?.signal?.addEventListener("abort", () => {
						reject(new DOMException("The operation was aborted", "AbortError"));
					});
				});
			}) as unknown as typeof globalThis.fetch;

			const client = new FirecrawlClient({ apiKey: API_KEY, fetch });
			const promise = client.scrape({ url: "https://example.com" }, ac.signal);
			ac.abort();

			const err = await promise.catch((e: Error) => e);
			expect(err.code).toBe("aborted");
		});

		it("throws ProviderError on success=false in submit response", async () => {
			const fetch = mockFetch(200, { success: false, id: "abc" });
			const client = new FirecrawlClient({ apiKey: API_KEY, fetch });

			const err = await client.submitCrawl({ url: "https://example.com" }).catch((e: Error) => e);
			expect(err.code).toBe("provider_error");
			expect(err.message).toContain("success=false");
		});

		it("throws ProviderError on empty crawl id", async () => {
			const fetch = mockFetch(200, { success: true, id: "" });
			const client = new FirecrawlClient({ apiKey: API_KEY, fetch });

			const err = await client.submitCrawl({ url: "https://example.com" }).catch((e: Error) => e);
			expect(err.code).toBe("provider_error");
			expect(err.message).toContain("empty");
		});
	});

	describe("submitCrawl", () => {
		it("sends POST to /v2/crawl with correct body", async () => {
			const fetch = mockFetchFn();
			fetch.mockResolvedValue({
				ok: true,
				status: 200,
				headers: new Map(),
				json: () => Promise.resolve({ success: true, id: "crawl-123" }),
			});

			const client = new FirecrawlClient({ apiKey: API_KEY, fetch: fetch as unknown as typeof globalThis.fetch });
			const params: CrawlSubmitParams = {
				url: "https://example.com",
				maxPages: 5,
			};
			const result = await client.submitCrawl(params);

			expect(result.id).toBe("crawl-123");
			expect(fetch).toHaveBeenCalledTimes(1);
			const [, opts] = fetch.mock.calls[0];
			expect(opts.method).toBe("POST");
			expect(JSON.parse(opts.body)).toMatchObject({
				url: "https://example.com",
				limit: 5,
			});
		});

		it("passes AbortSignal to fetch and rejects with aborted on user abort", async () => {
			const ac = new AbortController();
			const fetch = vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
				await new Promise<void>((_resolve, reject) => {
					if (opts?.signal?.aborted) {
						reject(new DOMException("Aborted", "AbortError"));
						return;
					}
					opts?.signal?.addEventListener("abort", () => {
						reject(new DOMException("Aborted", "AbortError"));
					});
				});
			}) as unknown as typeof globalThis.fetch;

			const client = new FirecrawlClient({ apiKey: API_KEY, fetch });
			const promise = client.submitCrawl({ url: "https://example.com" }, ac.signal);
			ac.abort();

			const err = await promise.catch((e: Error) => e);
			expect(err.code).toBe("aborted");
		});
	});

	describe("getCrawlStatus", () => {
		it("returns status and data for completed crawl", async () => {
			const fetch = mockFetch(200, {
				status: "completed",
				completed: 3,
				total: 3,
				creditsUsed: 10,
				data: [{ markdown: "page1" }, { markdown: "page2" }, { markdown: "page3" }],
			});
			const client = new FirecrawlClient({ apiKey: API_KEY, fetch });

			const status = await client.getCrawlStatus("crawl-123");
			expect(status.status).toBe("completed");
			expect(status.completed).toBe(3);
			expect(status.data).toHaveLength(3);
		});

		it("returns failed status", async () => {
			const fetch = mockFetch(200, { status: "failed", total: 5, completed: 2 });
			const client = new FirecrawlClient({ apiKey: API_KEY, fetch });

			const status = await client.getCrawlStatus("crawl-123");
			expect(status.status).toBe("failed");
		});

		it("throws provider_error on malformed response (missing status)", async () => {
			const fetch = mockFetch(200, { data: [] });
			const client = new FirecrawlClient({ apiKey: API_KEY, fetch });

			const err = await client.getCrawlStatus("crawl-123").catch((e: Error) => e);
			expect(err.code).toBe("provider_error");
		});

		it("throws provider_error on non-array data", async () => {
			const fetch = mockFetch(200, { status: "completed", data: "notarray" });
			const client = new FirecrawlClient({ apiKey: API_KEY, fetch });

			const err = await client.getCrawlStatus("crawl-123").catch((e: Error) => e);
			expect(err.code).toBe("provider_error");
		});

		it("passes AbortSignal to fetch and rejects with aborted on user abort", async () => {
			const ac = new AbortController();
			const fetch = vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
				await new Promise<void>((_resolve, reject) => {
					if (opts?.signal?.aborted) {
						reject(new DOMException("Aborted", "AbortError"));
						return;
					}
					opts?.signal?.addEventListener("abort", () => {
						reject(new DOMException("Aborted", "AbortError"));
					});
				});
			}) as unknown as typeof globalThis.fetch;

			const client = new FirecrawlClient({ apiKey: API_KEY, fetch });
			const promise = client.getCrawlStatus("crawl-123", ac.signal);
			ac.abort();

			const err = await promise.catch((e: Error) => e);
			expect(err.code).toBe("aborted");
		});
	});

	describe("getCrawlResultsPage", () => {
		it("fetches an absolute next URL and returns data", async () => {
			const fetch = mockFetchFn();
			fetch.mockResolvedValue({
				ok: true,
				status: 200,
				headers: new Map(),
				json: () =>
					Promise.resolve({
						status: "completed",
						data: [{ markdown: "page4" }, { markdown: "page5" }],
						next: "https://api.firecrawl.dev/v2/crawl/crawl-123/next?page=3",
					}),
			});

			const client = new FirecrawlClient({ apiKey: API_KEY, fetch: fetch as unknown as typeof globalThis.fetch });
			const result = await client.getCrawlResultsPage("https://api.firecrawl.dev/v2/crawl/crawl-123/next?page=2");

			expect(result.data).toHaveLength(2);
			expect(result.data[0].markdown).toBe("page4");
			expect(result.next).toBe("https://api.firecrawl.dev/v2/crawl/crawl-123/next?page=3");
			expect(fetch).toHaveBeenCalledTimes(1);
			const [url, opts] = fetch.mock.calls[0];
			expect(url).toBe("https://api.firecrawl.dev/v2/crawl/crawl-123/next?page=2");
			expect(opts.method).toBe("GET");
			expect(opts.headers).toMatchObject({ Authorization: `Bearer ${API_KEY}` });
		});

		it("rejects firecrawl.dev with hostile suffix", async () => {
			const fetch = mockFetchFn();
			const client = new FirecrawlClient({ apiKey: API_KEY, fetch: fetch as unknown as typeof globalThis.fetch });

			const err = await client.getCrawlResultsPage("https://evilfirecrawl.dev/v2/crawl/1").catch((e: Error) => e);
			expect(err.code).toBe("validation_error");
		});

		it("rejects wrong subdomain on firecrawl.dev", async () => {
			const fetch = mockFetchFn();
			const client = new FirecrawlClient({ apiKey: API_KEY, fetch: fetch as unknown as typeof globalThis.fetch });

			const err = await client.getCrawlResultsPage("https://sub.api.firecrawl.dev/v2/crawl/1").catch((e: Error) => e);
			expect(err.code).toBe("validation_error");
		});

		it("rejects HTTP firecrawl.dev URL", async () => {
			const fetch = mockFetchFn();
			const client = new FirecrawlClient({ apiKey: API_KEY, fetch: fetch as unknown as typeof globalThis.fetch });

			const err = await client.getCrawlResultsPage("http://api.firecrawl.dev/v2/crawl/1").catch((e: Error) => e);
			expect(err.code).toBe("validation_error");
		});

		it("rejects firecrawl.dev URL without /v2/ path", async () => {
			const fetch = mockFetchFn();
			const client = new FirecrawlClient({ apiKey: API_KEY, fetch: fetch as unknown as typeof globalThis.fetch });

			const err = await client.getCrawlResultsPage("https://api.firecrawl.dev/something/data").catch((e: Error) => e);
			expect(err.code).toBe("validation_error");
		});

		it("rejects non-http/https URLs", async () => {
			const fetch = mockFetchFn();
			const client = new FirecrawlClient({ apiKey: API_KEY, fetch: fetch as unknown as typeof globalThis.fetch });

			const err = await client.getCrawlResultsPage("ftp://files.com/data").catch((e: Error) => e);
			expect(err.code).toBe("validation_error");
		});

		it("accepts exact https://api.firecrawl.dev/v2/ URL", async () => {
			const fetch = mockFetchFn();
			fetch.mockResolvedValue({
				ok: true,
				status: 200,
				headers: new Map(),
				json: () => Promise.resolve({ status: "completed" }),
			});
			const client = new FirecrawlClient({ apiKey: API_KEY, fetch: fetch as unknown as typeof globalThis.fetch });

			const result = await client.getCrawlResultsPage("https://api.firecrawl.dev/v2/crawl/crawl-123/next?page=2");
			expect(result.status).toBe("completed");
			const [url, opts] = fetch.mock.calls[0];
			expect(url).toBe("https://api.firecrawl.dev/v2/crawl/crawl-123/next?page=2");
			expect(opts.headers).toMatchObject({ Authorization: `Bearer ${API_KEY}` });
		});

		it("throws provider_error on malformed page response (missing data)", async () => {
			const fetch = mockFetch(200, { success: true });
			const client = new FirecrawlClient({ apiKey: API_KEY, fetch });

			const err = await client
				.getCrawlResultsPage("https://api.firecrawl.dev/v2/crawl/crawl-123/next?page=2")
				.catch((e: Error) => e);
			expect(err.code).toBe("provider_error");
		});

		it("passes AbortSignal to fetch and rejects with aborted on user abort", async () => {
			const ac = new AbortController();
			const fetch = vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
				if (opts?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
				return { ok: true, status: 200, headers: new Map(), json: () => Promise.resolve({ data: [] }) };
			}) as unknown as typeof globalThis.fetch;

			const client = new FirecrawlClient({ apiKey: API_KEY, fetch });
			ac.abort();
			const err = await client
				.getCrawlResultsPage("https://api.firecrawl.dev/v2/crawl/crawl-123/next?page=2", ac.signal)
				.catch((e: Error) => e);
			expect(err.code).toBe("aborted");
		});
	});

	describe("cancelCrawl", () => {
		it("sends DELETE to /v2/crawl/:id", async () => {
			const fetch = mockFetchFn();
			fetch.mockResolvedValue({
				ok: true,
				status: 200,
				headers: new Map(),
				json: () => Promise.resolve({ status: "cancelled" }),
			});

			const client = new FirecrawlClient({ apiKey: API_KEY, fetch: fetch as unknown as typeof globalThis.fetch });
			await client.cancelCrawl("crawl-123");

			expect(fetch).toHaveBeenCalledTimes(1);
			const [url, opts] = fetch.mock.calls[0];
			expect(url).toBe("https://api.firecrawl.dev/v2/crawl/crawl-123");
			expect(opts.method).toBe("DELETE");
		});

		it("passes AbortSignal to fetch", async () => {
			const ac = new AbortController();
			const fetch = vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
				if (opts?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
				return { ok: true, status: 200, headers: new Map(), json: () => Promise.resolve({ status: "cancelled" }) };
			}) as unknown as typeof globalThis.fetch;

			const client = new FirecrawlClient({ apiKey: API_KEY, fetch });
			await client.cancelCrawl("crawl-123", ac.signal);
			expect(fetch).toHaveBeenCalledTimes(1);
			const [, opts] = fetch.mock.calls[0];
			expect(opts.signal).toBe(ac.signal);
		});
	});
});
