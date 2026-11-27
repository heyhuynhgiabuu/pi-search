import {
	arr,
	compile,
	lit,
	nullable,
	num,
	obj,
	oneOf,
	opt,
	type Static,
	str,
	union,
	unknown,
	type Validator,
} from "@earendil-works/pi-schema";
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

// ── Wire schemas & boundary parsers ───────────────────────────────

const stringCheck = compile(str());

const numberCheck = compile(num());

const errorWithMessageCheck = compile(obj({ message: str() }, { open: true }));

const firecrawlErrorBodyValidator = compile(obj({ error: opt(str()) }, { open: true }));

const MetadataWireSchema = obj(
	{
		sourceURL: opt(unknown()),
		title: opt(unknown()),
	},
	{ open: true },
);

type MetadataWire = Static<typeof MetadataWireSchema>;

const metadataWireCheck = compile(MetadataWireSchema);

const ScrapeResponseSchema = union([
	obj({ success: lit(false) }, { open: true }),
	obj(
		{
			success: lit(true),
			data: obj(
				{
					markdown: opt(str()),
					metadata: opt(MetadataWireSchema),
				},
				{ open: true },
			),
		},
		{ open: true },
	),
]);

const scrapeResponseValidator = compile(ScrapeResponseSchema);

const CrawlSubmitResponseSchema = union([
	obj({ success: lit(false) }, { open: true }),
	obj(
		{
			success: lit(true),
			id: str(),
		},
		{ open: true },
	),
]);

const crawlSubmitResponseValidator = compile(CrawlSubmitResponseSchema);

const CrawlStatusValueSchema = oneOf(["scraping", "completed", "failed", "cancelled"]);

const CrawlPageWireSchema = obj(
	{
		url: opt(unknown()),
		markdown: opt(unknown()),
		metadata: opt(unknown()),
	},
	{ open: true },
);

type CrawlPageWire = Static<typeof CrawlPageWireSchema>;

const CrawlStatusWireSchema = obj(
	{
		status: CrawlStatusValueSchema,
		total: opt(unknown()),
		completed: opt(unknown()),
		creditsUsed: opt(unknown()),
		data: opt(arr(CrawlPageWireSchema)),
		next: opt(nullable(str())),
	},
	{ open: true },
);

const crawlStatusResponseValidator = compile(CrawlStatusWireSchema);

// ── Internal helpers ──────────────────────────────────────────────

function errorToMessage(cause: unknown): string {
	if (stringCheck.check(cause)) return cause;

	if (cause instanceof Error) return cause.message;

	if (errorWithMessageCheck.check(cause)) return cause.message;

	return String(cause);
}

function isAbortError(cause: unknown): boolean {
	return cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError");
}

// ── Types ─────────────────────────────────────────────────────────

export interface ScrapeParams {
	url: string;
	onlyMainContent?: boolean;
	timeout?: number;
}

export interface FirecrawlPageMetadata {
	sourceURL?: string;
	title?: string;
}

export interface ScrapeResult {
	markdown?: string;
	metadata?: FirecrawlPageMetadata;
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

export interface CrawlPage {
	url?: string;
	markdown?: string;
	metadata?: FirecrawlPageMetadata;
}

export interface CrawlStatusResponse {
	status: "scraping" | "completed" | "failed" | "cancelled";
	total?: number;
	completed?: number;
	creditsUsed?: number;
	data?: Array<CrawlPage>;
	next?: string | null;
}

export interface FirecrawlClientConfig {
	apiKey: string;
	fetch?: typeof globalThis.fetch;
}

interface ScrapeRequestBody {
	url: string;
	formats: Array<"markdown">;
	onlyMainContent?: boolean;
	timeout?: number;
}

interface CrawlSubmitRequestBody {
	url: string;
	limit?: number;
	excludePaths?: Array<string>;
	includePaths?: Array<string>;
	scrapeOptions?: CrawlSubmitParams["scrapeOptions"];
}

type FirecrawlRequestBody = ScrapeRequestBody | CrawlSubmitRequestBody;

type FirecrawlRequestHeaders = {
	Authorization: string;
	"Content-Type": string;
};

const BASE_URL = "https://api.firecrawl.dev/v2";

function normalizeMetadata(raw: MetadataWire): FirecrawlPageMetadata {
	const metadata: FirecrawlPageMetadata = {};

	if (stringCheck.check(raw.sourceURL)) {
		metadata.sourceURL = raw.sourceURL;
	}

	if (stringCheck.check(raw.title)) {
		metadata.title = raw.title;
	}

	return metadata;
}

function normalizeCrawlPage(raw: CrawlPageWire): CrawlPage {
	const page: CrawlPage = {};

	if (stringCheck.check(raw.url)) {
		page.url = raw.url;
	}

	if (stringCheck.check(raw.markdown)) {
		page.markdown = raw.markdown;
	}

	if (metadataWireCheck.check(raw.metadata)) {
		page.metadata = normalizeMetadata(raw.metadata);
	}

	return page;
}

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

	private defaultHeaders(): FirecrawlRequestHeaders {
		return {
			Authorization: `Bearer ${this.apiKey}`,
			"Content-Type": "application/json",
		};
	}

	// Shared fetch + error handling for any URL
	private async rawFetchResponse(
		url: string,
		method: string,
		headers: FirecrawlRequestHeaders,
		body?: FirecrawlRequestBody,
		signal?: AbortSignal,
	): Promise<Response> {
		let res: Response;

		try {
			res = await this.fetch(url, {
				method,
				headers,
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal,
			});
		} catch (cause) {
			if (isAbortError(cause)) {
				throw new PiSearchError("aborted", "Request was aborted");
			}

			throw new ProviderError(`Firecrawl network error: ${errorToMessage(cause)}`);
		}

		if (!res.ok) {
			await this.handleNonOkResponse(res);
		}

		return res;
	}

	private async parseJsonResponse<T>(res: Response, validator: Validator<T>, label: string): Promise<T> {
		let rawJson: unknown;

		try {
			rawJson = await res.json();
		} catch (cause) {
			throw new ProviderError(`Firecrawl returned invalid JSON: ${errorToMessage(cause)}`);
		}

		const parsed = validator.validate(rawJson);

		if (!parsed.ok) {
			const first = parsed.errors[0];
			const detail = first ? `${first.path || "/"}: ${first.message}` : "schema validation failed";

			throw new ProviderError(`Firecrawl: invalid ${label} (${detail})`);
		}

		return parsed.value;
	}

	private async handleNonOkResponse(res: Response): Promise<never> {
		let message = `Firecrawl API returned HTTP ${res.status}`;

		try {
			const rawBody = await res.json();

			if (firecrawlErrorBodyValidator.check(rawBody) && rawBody.error !== undefined) {
				message = rawBody.error;
			}
		} catch {
			// ignore parse failures in error path
		}

		if (res.status === 401 || res.status === 403) {
			throw new PiSearchError("firecrawl_auth_error", message);
		}

		if (res.status === 429) {
			throw new PiSearchError("firecrawl_rate_limited", message);
		}

		throw new ProviderError(`Firecrawl API error ${res.status}: ${message}`);
	}

	private async request(
		method: string,
		path: string,
		body?: FirecrawlRequestBody,
		signal?: AbortSignal,
	): Promise<Response> {
		return this.rawFetchResponse(`${this.baseUrl}${path}`, method, this.defaultHeaders(), body, signal);
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

	private static toScrapeResult(parsed: Static<typeof ScrapeResponseSchema>): ScrapeResult {
		if (!parsed.success) {
			throw new ProviderError("Firecrawl: scrape returned success=false");
		}

		return {
			markdown: parsed.data.markdown,
			metadata: parsed.data.metadata !== undefined ? normalizeMetadata(parsed.data.metadata) : undefined,
		};
	}

	private static toCrawlSubmitResult(parsed: Static<typeof CrawlSubmitResponseSchema>) {
		if (!parsed.success) {
			throw new ProviderError("Firecrawl: crawl submit returned success=false");
		}

		if (parsed.id.length === 0) {
			throw new ProviderError("Firecrawl: crawl submit returned empty id");
		}

		return { id: parsed.id };
	}

	private static toCrawlStatusResponse(parsed: Static<typeof CrawlStatusWireSchema>): CrawlStatusResponse {
		return {
			status: parsed.status,
			total: numberCheck.check(parsed.total) ? parsed.total : undefined,
			completed: numberCheck.check(parsed.completed) ? parsed.completed : undefined,
			creditsUsed: numberCheck.check(parsed.creditsUsed) ? parsed.creditsUsed : undefined,
			data: parsed.data !== undefined ? parsed.data.map(normalizeCrawlPage) : undefined,
			next: parsed.next ?? null,
		};
	}

	// ── Public API ───────────────────────────────────────────────

	async scrape(params: ScrapeParams, signal?: AbortSignal): Promise<ScrapeResult> {
		const body: ScrapeRequestBody = {
			url: params.url,
			formats: ["markdown"],
		};

		if (params.onlyMainContent !== undefined) body.onlyMainContent = params.onlyMainContent;

		if (params.timeout !== undefined) body.timeout = params.timeout;

		const res = await this.request("POST", "/scrape", body, signal);
		const parsed = await this.parseJsonResponse(res, scrapeResponseValidator, "scrape response");

		return FirecrawlClient.toScrapeResult(parsed);
	}

	async submitCrawl(params: CrawlSubmitParams, signal?: AbortSignal): Promise<{ id: string }> {
		const body: CrawlSubmitRequestBody = {
			url: params.url,
		};

		if (params.maxPages !== undefined) body.limit = params.maxPages;

		if (params.excludePaths !== undefined) body.excludePaths = params.excludePaths;

		if (params.includePaths !== undefined) body.includePaths = params.includePaths;

		if (params.scrapeOptions !== undefined) body.scrapeOptions = params.scrapeOptions;

		const res = await this.request("POST", "/crawl", body, signal);
		const parsed = await this.parseJsonResponse(res, crawlSubmitResponseValidator, "crawl submit response");

		return FirecrawlClient.toCrawlSubmitResult(parsed);
	}

	async getCrawlStatus(id: string, signal?: AbortSignal): Promise<CrawlStatusResponse> {
		const res = await this.request("GET", `/crawl/${encodeURIComponent(id)}`, undefined, signal);
		const parsed = await this.parseJsonResponse(res, crawlStatusResponseValidator, "status response");

		return FirecrawlClient.toCrawlStatusResponse(parsed);
	}

	async getCrawlResultsPage(nextUrl: string, signal?: AbortSignal): Promise<CrawlStatusResponse> {
		FirecrawlClient.validateNextUrl(nextUrl);
		const res = await this.rawFetchResponse(nextUrl, "GET", this.defaultHeaders(), undefined, signal);
		const parsed = await this.parseJsonResponse(res, crawlStatusResponseValidator, "status response");

		return FirecrawlClient.toCrawlStatusResponse(parsed);
	}

	async cancelCrawl(id: string, signal?: AbortSignal): Promise<void> {
		const res = await this.request("DELETE", `/crawl/${encodeURIComponent(id)}`, undefined, signal);

		try {
			await res.json();
		} catch (cause) {
			throw new ProviderError(`Firecrawl returned invalid JSON: ${errorToMessage(cause)}`);
		}
	}
}
