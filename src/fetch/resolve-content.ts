import { FetchError } from "../errors.js";
import { resolveGithubToken } from "../github/token.js";
import type { ResolvedConfig } from "../types.js";
import { fetchError } from "./errors.js";
import { fetchGitHubContent, parseGitHubUrl } from "./github.js";
import { extractFromHtml, isThinOrConsentPage } from "./html.js";
import { fetchViaJinaReader } from "./jina.js";
import { fetchFirstLlmsTxt, llmsTxtCandidateUrls } from "./llms-txt.js";
import { extractPdfTextFromBytes } from "./pdf.js";
import { assertSsrfAllowed, type SsrfPolicy } from "./ssrf.js";
import { applyUrlRewrites } from "./url-rewrites.js";

export type ResolvedFetch = {
	url: string;
	title: string | null;
	text: string;
	contentType: string | null;
	status: number;
	extraction: "direct" | "readability" | "strip" | "jina" | "github";
	truncated: boolean;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CHARS = 50_000;

function ssrfPolicyFromConfig(config: ResolvedConfig): SsrfPolicy {
	return { allowRanges: config.ssrf.allowRanges };
}

function urlLooksLikePdf(urlString: string): boolean {
	return urlString.toLowerCase().split("?")[0]?.endsWith(".pdf") ?? false;
}

async function fetchHttpResponse(
	url: URL,
	options: { signal?: AbortSignal; timeoutMs: number },
): Promise<{ bodyText: string | null; bodyBytes: ArrayBuffer | null; contentType: string | null; status: number }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;

	try {
		const response = await fetch(url.toString(), {
			headers: {
				"User-Agent": "pi-search/1.0",
				Accept: "text/html,application/xhtml+xml,text/plain,application/json,application/pdf,*/*",
			},
			signal,
			redirect: "follow",
		});
		const contentType = response.headers.get("content-type");
		const asPdf = (contentType ?? "").includes("application/pdf") || urlLooksLikePdf(url.toString());
		if (asPdf) {
			const bodyBytes = await response.arrayBuffer();
			return { bodyText: null, bodyBytes, contentType, status: response.status };
		}
		const bodyText = await response.text();
		return { bodyText, bodyBytes: null, contentType, status: response.status };
	} catch (err) {
		if (err instanceof FetchError) throw err;
		if (err instanceof Error && err.name === "AbortError") {
			throw fetchError("fetch_timeout", "Request timed out", { url: url.toString() });
		}
		const message = err instanceof Error ? err.message : String(err);
		throw fetchError("fetch_error", message, { url: url.toString() });
	} finally {
		clearTimeout(timeout);
	}
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	return { text: `${text.slice(0, maxChars)}\n\n[truncated at ${maxChars} chars]`, truncated: true };
}

export async function resolveUrlContent(
	urlString: string,
	config: ResolvedConfig,
	options: { signal?: AbortSignal; maxOutputChars?: number },
): Promise<ResolvedFetch> {
	const rewritten = applyUrlRewrites(urlString, config.urlRewrites);
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(rewritten);
	} catch {
		throw fetchError("fetch_error", "Invalid URL", { url: urlString });
	}
	if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
		throw fetchError("fetch_error", "Only http and https URLs are supported", { url: urlString });
	}

	const policy = ssrfPolicyFromConfig(config);
	assertSsrfAllowed(parsedUrl, policy);

	const timeoutMs = config.mcpTimeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxChars = options.maxOutputChars ?? DEFAULT_MAX_CHARS;

	const gh = parseGitHubUrl(parsedUrl);
	if (gh) {
		const ghAuth = await resolveGithubToken(config.githubToken);
		const { text, title } = await fetchGitHubContent(gh, {
			signal: options.signal,
			timeoutMs,
			githubToken: ghAuth.token ?? undefined,
		});
		const { text: out, truncated } = truncateText(text, maxChars);
		return {
			url: urlString,
			title,
			text: out,
			contentType: "text/markdown",
			status: 200,
			extraction: "github",
			truncated,
		};
	}

	const llmsCandidates = llmsTxtCandidateUrls(parsedUrl);
	if (llmsCandidates.length > 0) {
		const llms = await fetchFirstLlmsTxt(llmsCandidates, { signal: options.signal, timeoutMs });
		if (llms) {
			const { text: out, truncated } = truncateText(llms.text, maxChars);
			return {
				url: urlString,
				title: "llms.txt",
				text: out,
				contentType: "text/plain",
				status: 200,
				extraction: "direct",
				truncated,
			};
		}
	}

	const { bodyText, bodyBytes, contentType, status } = await fetchHttpResponse(parsedUrl, {
		signal: options.signal,
		timeoutMs,
	});

	if (bodyBytes) {
		const { text, totalPages } = await extractPdfTextFromBytes(bodyBytes, { url: urlString });
		const { text: out, truncated } = truncateText(text, maxChars);
		return {
			url: urlString,
			title: `PDF (${totalPages} pages)`,
			text: out,
			contentType: contentType ?? "application/pdf",
			status,
			extraction: "direct",
			truncated,
		};
	}

	const body = bodyText ?? "";
	if (!body.trim()) {
		throw fetchError("fetch_error", "Empty response body", { url: urlString, status });
	}

	const isHtml = (contentType ?? "").includes("text/html") || body.trimStart().startsWith("<!");
	let text: string;
	let title: string | null = null;
	let extraction: ResolvedFetch["extraction"] = "direct";

	if (isHtml) {
		const extracted = extractFromHtml(body, urlString);
		text = extracted.text;
		title = extracted.title;
		extraction = extracted.method === "readability" ? "readability" : "strip";

		if (isThinOrConsentPage(text)) {
			try {
				const jina = await fetchViaJinaReader(urlString, { signal: options.signal, timeoutMs });
				text = jina.text;
				title = jina.title ?? title;
				extraction = "jina";
			} catch {
				// keep primary extraction
			}
		}
	} else {
		text = body;
	}

	const { text: out, truncated } = truncateText(text, maxChars);
	return {
		url: urlString,
		title,
		text: out,
		contentType,
		status,
		extraction,
		truncated,
	};
}
