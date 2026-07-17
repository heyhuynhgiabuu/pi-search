import { PiSearchError, ProviderError, ValidationError } from "../errors.js";

// ── Exported helpers ──────────────────────────────────────────────

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new PiSearchError("aborted", "Request was aborted"));
			return;
		}

		const onAbort = () => {
			clearTimeout(timeout);
			reject(new PiSearchError("aborted", "Request was aborted"));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function composeAbortSignals(...signals: Array<AbortSignal>): AbortSignal {
	return AbortSignal.any(signals);
}

// ── Internal helpers ──────────────────────────────────────────────

function unknownToErrorMessage(error: unknown): string {
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.message;
	if (error !== null && typeof error === "object" && "message" in error) {
		const message = Reflect.get(error, "message");
		if (typeof message === "string") return message;
	}
	return String(error);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

// ── Types ─────────────────────────────────────────────────────────

export interface ScrapeParams {
	url: string;
	onlyMainContent?: boolean;
	timeout?: number;
}

export interface ScrapeResult {
	markdown?: string;
	metadata?: Record<string, unknown>;
}

export interface CrawlSubmitParams {
	url: string;
	maxPages?: number;
	excludePaths?: Array<string>;
	includePaths?: Array<string>;
	scrapeOptions?: {
		formats?: Array<string>;
		onlyMainContent?: boolean;
	};
}

export interface CrawlStatusResponse {
	status: "scraping" | "completed" | "failed" | "cancelled";
	total?: number;
	completed?: number;
	creditsUsed?: number;
	data?: Array<Record<string, unknown>>;
	next?: string | null;
}

export interface FirecrawlClientConfig {
	apiKey: string;
	fetch?: typeof globalThis.fetch;
}

const BASE_URL = "https://api.firecrawl.dev/v2";

// ── Client ────────────────────────────────────────────────────────

export class FirecrawlClient {
	private apiKey: string;
	private fetch: typeof globalThis.fetch;
	private baseUrl: string;

	constructor(config: FirecrawlClientConfig) {
		this.apiKey = config.apiKey;
		this.fetch = config.fetch ?? globalThis.fetch;
		this.baseUrl = BASE_URL;
	}

	// ── Private helpers ──────────────────────────────────────────

	private static isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	private static assertString(value: unknown, label: string): string {
		if (typeof value !== "string") {
			throw new ProviderError(`Firecrawl: expected ${label} to be a string, got ${typeof value}`);
		}
		return value;
	}

	private static extractErrorMessage(body: unknown): string | undefined {
		if (!FirecrawlClient.isRecord(body)) return undefined;
		const error = body.error;
		return typeof error === "string" ? error : undefined;
	}

	private defaultHeaders(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.apiKey}`,
			"Content-Type": "application/json",
		};
	}

	// Shared fetch + error handling for any URL
	private async rawFetch(
		url: string,
		method: string,
		headers: Record<string, string>,
		body?: unknown,
		signal?: AbortSignal,
	): Promise<unknown> {
		let res: Response;
		try {
			res = await this.fetch(url, {
				method,
				headers,
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal,
			});
		} catch (err: unknown) {
			if (isAbortError(err)) {
				throw new PiSearchError("aborted", "Request was aborted");
			}
			throw new ProviderError(`Firecrawl network error: ${unknownToErrorMessage(err)}`);
		}

		if (!res.ok) {
			await this.handleNonOkResponse(res);
		}

		try {
			return await res.json();
		} catch (err: unknown) {
			throw new ProviderError(`Firecrawl returned invalid JSON: ${unknownToErrorMessage(err)}`);
		}
	}

	private async handleNonOkResponse(res: Response): Promise<never> {
		let errorBody: unknown = null;
		try {
			errorBody = await res.json();
		} catch {
			// ignore parse failures in error path
		}

		const message = FirecrawlClient.extractErrorMessage(errorBody) ?? `Firecrawl API returned HTTP ${res.status}`;

		if (res.status === 401 || res.status === 403) {
			throw new PiSearchError("firecrawl_auth_error", message);
		}
		if (res.status === 429) {
			throw new PiSearchError("firecrawl_rate_limited", message);
		}
		throw new ProviderError(`Firecrawl API error ${res.status}: ${message}`);
	}

	private async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
		return this.rawFetch(`${this.baseUrl}${path}`, method, this.defaultHeaders(), body, signal);
	}

	// ── Response validators ──────────────────────────────────────

	private static validateScrapeResponse(raw: unknown): { markdown?: string; metadata?: Record<string, unknown> } {
		if (!FirecrawlClient.isRecord(raw)) {
			throw new ProviderError("Firecrawl: scrape response is not an object");
		}
		if (raw.success !== true) {
			throw new ProviderError("Firecrawl: scrape returned success=false");
		}
		const data = raw.data;
		if (!FirecrawlClient.isRecord(data)) {
			throw new ProviderError("Firecrawl: scrape response missing data field");
		}
		const markdown = data.markdown;
		if (markdown !== undefined && typeof markdown !== "string") {
			throw new ProviderError("Firecrawl: scrape data.markdown is not a string");
		}
		const metadata = data.metadata;
		if (metadata !== undefined && !FirecrawlClient.isRecord(metadata)) {
			throw new ProviderError("Firecrawl: scrape data.metadata is not an object");
		}
		return {
			markdown: typeof markdown === "string" ? markdown : undefined,
			metadata: FirecrawlClient.isRecord(metadata) ? metadata : undefined,
		};
	}

	private static validateCrawlSubmitResponse(raw: unknown): { id: string } {
		if (!FirecrawlClient.isRecord(raw)) {
			throw new ProviderError("Firecrawl: crawl submit response is not an object");
		}
		if (raw.success !== true) {
			throw new ProviderError("Firecrawl: crawl submit returned success=false");
		}
		const id = FirecrawlClient.assertString(raw.id, "crawl id");
		if (id.length === 0) {
			throw new ProviderError("Firecrawl: crawl submit returned empty id");
		}
		return { id };
	}

	// Require exact https://api.firecrawl.dev with /v2/ path prefix
	private static validateNextUrl(nextUrl: string): string {
		let parsed: URL;
		try {
			parsed = new URL(nextUrl);
		} catch {
			throw new ValidationError("Firecrawl next URL is not a valid URL");
		}
		if (parsed.protocol !== "https:") {
			throw new ValidationError("Firecrawl next URL must use HTTPS");
		}
		if (parsed.hostname !== "api.firecrawl.dev") {
			throw new ValidationError("Firecrawl next URL does not belong to the Firecrawl API");
		}
		if (!parsed.pathname.startsWith("/v2/crawl/")) {
			throw new ValidationError("Firecrawl next URL must target a v2 crawl result page");
		}
		return nextUrl;
	}

	private static validateCrawlStatusResponse(raw: unknown): CrawlStatusResponse {
		if (!FirecrawlClient.isRecord(raw)) {
			throw new ProviderError("Firecrawl: status response is not an object");
		}
		const status = raw.status;
		if (typeof status !== "string") {
			throw new ProviderError("Firecrawl: status response missing status field");
		}
		const validStatuses: Array<string> = ["scraping", "completed", "failed", "cancelled"];
		if (!validStatuses.includes(status)) {
			throw new ProviderError(`Firecrawl: unknown crawl status "${status}"`);
		}
		const data = raw.data;
		if (data !== undefined) {
			if (!Array.isArray(data)) {
				throw new ProviderError("Firecrawl: status response data is not an array");
			}
			for (let i = 0; i < data.length; i++) {
				if (!FirecrawlClient.isRecord(data[i])) {
					throw new ProviderError(`Firecrawl: status response data[${i}] is not an object`);
				}
			}
		}
		const next = raw.next;
		if (next !== undefined && next !== null && typeof next !== "string") {
			throw new ProviderError("Firecrawl: status response next is not a string or null");
		}
		return {
			status: status as CrawlStatusResponse["status"],
			total: typeof raw.total === "number" ? raw.total : undefined,
			completed: typeof raw.completed === "number" ? raw.completed : undefined,
			creditsUsed: typeof raw.creditsUsed === "number" ? raw.creditsUsed : undefined,
			data: Array.isArray(data) ? (data as Array<Record<string, unknown>>) : undefined,
			next: typeof next === "string" ? next : null,
		};
	}

	// ── Public API ───────────────────────────────────────────────

	async scrape(params: ScrapeParams, signal?: AbortSignal): Promise<ScrapeResult> {
		const body: Record<string, unknown> = {
			url: params.url,
			formats: ["markdown"],
		};
		if (params.onlyMainContent !== undefined) body.onlyMainContent = params.onlyMainContent;
		if (params.timeout !== undefined) body.timeout = params.timeout;

		const response = await this.request("POST", "/scrape", body, signal);
		return FirecrawlClient.validateScrapeResponse(response);
	}

	async submitCrawl(params: CrawlSubmitParams, signal?: AbortSignal): Promise<{ id: string }> {
		const body: Record<string, unknown> = {
			url: params.url,
		};
		if (params.maxPages !== undefined) body.limit = params.maxPages;
		if (params.excludePaths !== undefined) body.excludePaths = params.excludePaths;
		if (params.includePaths !== undefined) body.includePaths = params.includePaths;
		if (params.scrapeOptions !== undefined) body.scrapeOptions = params.scrapeOptions;

		const response = await this.request("POST", "/crawl", body, signal);
		return FirecrawlClient.validateCrawlSubmitResponse(response);
	}

	async getCrawlStatus(id: string, signal?: AbortSignal): Promise<CrawlStatusResponse> {
		const response = await this.request("GET", `/crawl/${encodeURIComponent(id)}`, undefined, signal);
		return FirecrawlClient.validateCrawlStatusResponse(response);
	}

	async getCrawlResultsPage(nextUrl: string, signal?: AbortSignal): Promise<CrawlStatusResponse> {
		FirecrawlClient.validateNextUrl(nextUrl);
		const raw = await this.rawFetch(nextUrl, "GET", this.defaultHeaders(), undefined, signal);
		return FirecrawlClient.validateCrawlStatusResponse(raw);
	}

	async cancelCrawl(id: string, signal?: AbortSignal): Promise<void> {
		await this.request("DELETE", `/crawl/${encodeURIComponent(id)}`, undefined, signal);
	}
}
