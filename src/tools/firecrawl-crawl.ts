import type { AgentToolUpdateCallback, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	buildErrorResult,
	ConfigError,
	PiSearchError,
	ProviderError,
	toPiSearchError,
	ValidationError,
} from "../errors.js";
import { FETCH_CONTENT_CUSTOM_TYPE, putFetchContent } from "../fetch/content-store.js";
import { abortableDelay, type CrawlStatusResponse, composeAbortSignals, FirecrawlClient } from "../firecrawl/client.js";
import type { ResolvedConfig } from "../types.js";

const DEFAULT_MAX_PAGES = 5;
const MAX_PAGES = 20;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_CRAWL_TIMEOUT_MS = 120_000;

function isAbsoluteHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pageUrl(page: Record<string, unknown>, fallback: string): string {
	const metadata = isRecord(page.metadata) ? page.metadata : undefined;
	if (typeof metadata?.sourceURL === "string") return metadata.sourceURL;
	return typeof page.url === "string" ? page.url : fallback;
}

function pageTitle(page: Record<string, unknown>, fallbackUrl: string): string {
	const metadata = isRecord(page.metadata) ? page.metadata : undefined;
	if (typeof metadata?.title === "string" && metadata.title.trim()) return metadata.title.trim();
	try {
		return new URL(fallbackUrl).pathname || fallbackUrl;
	} catch {
		return fallbackUrl;
	}
}

async function cancelWithFreshSignal(client: FirecrawlClient, crawlId: string): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	try {
		await client.cancelCrawl(crawlId, controller.signal);
	} catch {
		// Cancellation is best-effort after the primary request has already failed.
	} finally {
		clearTimeout(timer);
	}
}

async function runCrawl(
	client: FirecrawlClient,
	params: { url: string; maxPages: number; includePaths?: string[]; excludePaths?: string[] },
	userSignal: AbortSignal,
	onUpdate: AgentToolUpdateCallback | undefined,
	pollIntervalMs: number,
	timeoutMs: number,
): Promise<{ crawlId: string; data: Record<string, unknown>[]; creditsUsed: number }> {
	const timeoutController = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		timeoutController.abort();
	}, timeoutMs);
	const signal = composeAbortSignals(userSignal, timeoutController.signal);
	let crawlId: string | undefined;

	try {
		onUpdate?.({
			content: [{ type: "text", text: "Submitting Firecrawl crawl (consumes credits)..." }],
			details: undefined,
		});
		crawlId = (
			await client.submitCrawl(
				{
					url: params.url,
					maxPages: params.maxPages,
					includePaths: params.includePaths,
					excludePaths: params.excludePaths,
				},
				signal,
			)
		).id;

		let terminal: CrawlStatusResponse;
		for (;;) {
			await abortableDelay(pollIntervalMs, signal);
			const status = await client.getCrawlStatus(crawlId, signal);
			onUpdate?.({ content: [{ type: "text", text: `Firecrawl crawl status: ${status.status}` }], details: undefined });
			if (status.status === "scraping") continue;
			if (status.status === "failed") throw new ProviderError("Firecrawl crawl failed");
			if (status.status === "cancelled") throw new ProviderError("Firecrawl crawl was cancelled remotely");
			terminal = status;
			break;
		}

		const data = [...(terminal.data ?? [])];
		const creditsUsed = terminal.creditsUsed;
		let next = terminal.next;
		while (next) {
			const page = await client.getCrawlResultsPage(next, signal);
			data.push(...(page.data ?? []));
			next = page.next;
			onUpdate?.({
				content: [{ type: "text", text: `Retrieved ${data.length} crawled pages...` }],
				details: undefined,
			});
		}
		return { crawlId, data, creditsUsed: creditsUsed ?? data.length };
	} catch (error) {
		if (error instanceof PiSearchError && error.code === "aborted") {
			if (crawlId) await cancelWithFreshSignal(client, crawlId);
			if (timedOut && !userSignal.aborted) {
				throw new PiSearchError("firecrawl_timeout", `Firecrawl crawl timed out after ${timeoutMs}ms`);
			}
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

export function createFirecrawlCrawlTool(
	pi: ExtensionAPI,
	config: ResolvedConfig,
	pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
	timeoutMs = DEFAULT_CRAWL_TIMEOUT_MS,
): ToolDefinition {
	return {
		name: "firecrawl_crawl",
		label: "⚙ firecrawl_crawl",
		description:
			"Crawl up to 20 website pages through Firecrawl. Each crawled page consumes Firecrawl credits. " +
			"Defaults to 5 pages and requires FIRECRAWL_API_KEY or firecrawlApiKey in config.",
		parameters: Type.Object({
			url: Type.String({ description: "Absolute http:// or https:// URL to crawl." }),
			maxPages: Type.Optional(
				Type.Integer({ description: "Maximum pages. Defaults to 5; maximum 20.", minimum: 1, maximum: MAX_PAGES }),
			),
			includePaths: Type.Optional(
				Type.Array(Type.String(), { description: "URL pathname regex patterns to include." }),
			),
			excludePaths: Type.Optional(
				Type.Array(Type.String(), { description: "URL pathname regex patterns to exclude." }),
			),
		}),
		async execute(_toolCallId, rawParams: Record<string, unknown>, signal, onUpdate) {
			if (!config.firecrawlApiKey) {
				return buildErrorResult(
					new ConfigError(
						"Firecrawl API key not configured. Set FIRECRAWL_API_KEY or add firecrawlApiKey to ~/.pi/pi-search.json.",
					),
				);
			}

			try {
				const url = typeof rawParams.url === "string" ? rawParams.url : "";
				if (!isAbsoluteHttpUrl(url)) throw new ValidationError("url must be an absolute http:// or https:// URL.");
				const maxPages = typeof rawParams.maxPages === "number" ? rawParams.maxPages : DEFAULT_MAX_PAGES;
				if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) {
					throw new ValidationError("maxPages must be an integer between 1 and 20.");
				}
				const includePaths = Array.isArray(rawParams.includePaths)
					? rawParams.includePaths.filter((item): item is string => typeof item === "string")
					: undefined;
				const excludePaths = Array.isArray(rawParams.excludePaths)
					? rawParams.excludePaths.filter((item): item is string => typeof item === "string")
					: undefined;
				const client = new FirecrawlClient({ apiKey: config.firecrawlApiKey });
				const result = await runCrawl(
					client,
					{ url, maxPages, includePaths, excludePaths },
					signal ?? new AbortController().signal,
					onUpdate,
					pollIntervalMs,
					timeoutMs,
				);

				const sections = result.data.map((page) => {
					const source = pageUrl(page, url);
					const markdown = typeof page.markdown === "string" ? page.markdown : "";
					return `# ${pageTitle(page, source)}\n\nSource: ${source}\n\n${markdown}`;
				});
				const text = sections.join("\n\n---\n\n");
				const { id, record } = putFetchContent({
					url,
					title: `Firecrawl: ${url}`,
					text,
					extraction: "firecrawl",
				});
				setImmediate(() => pi.appendEntry(FETCH_CONTENT_CUSTOM_TYPE, record));

				return {
					content: [
						{
							type: "text",
							text: `Crawled ${result.data.length} pages (${result.creditsUsed} credits reported). Full content: ${id}`,
						},
					],
					details: {
						crawlId: result.crawlId,
						fetchId: id,
						pages: result.data.length,
						creditsUsed: result.creditsUsed,
						sourceURL: url,
					},
				};
			} catch (error) {
				return buildErrorResult(toPiSearchError(error));
			}
		},
	};
}
