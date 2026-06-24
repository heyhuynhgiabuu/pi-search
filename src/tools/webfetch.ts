/**
 * web_fetch tool — fetches a URL and returns the page content as clean text.
 *
 * No API key required. Uses Node's global fetch. Designed as the
 * deep-extraction follow-up to websearch and codesearch.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolveConfig } from "../config.js";
import { buildErrorResult, FetchError, toPiSearchError, ValidationError } from "../errors.js";
import { dedupeCitations, extractCitationsFromMcpText, formatCitationFooter } from "./citations.js";
import { renderWebFetchResult } from "./render.js";

const MAX_FETCH_BYTES = 5 * 1024 * 1024; // 5MB
const DEFAULT_MAX_CHARS = 50_000;

export function createWebFetchTool(_pi: ExtensionAPI) {
	return {
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a URL and return the page content as clean text/markdown. Use this after websearch to extract full articles. For PDFs or binary content, use a more specialized tool. Set maxOutputChars to control truncation.",
		parameters: Type.Object({
			url: Type.String({ description: "The URL to fetch (must be http:// or https://)." }),
			maxOutputChars: Type.Optional(
				Type.Integer({ description: "Maximum characters to return (default 50000).", minimum: 1000, maximum: 200000 }),
			),
		}),
		async execute(
			_id: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate:
				| ((update: { content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }) => void)
				| undefined,
		) {
			try {
				const config = resolveConfig();
				if (config.disabledTools.has("web_fetch")) {
					throw new ValidationError("web_fetch is disabled in config.");
				}

				const url = (params.url as string | undefined)?.trim();
				const maxOutputChars = (params.maxOutputChars as number | undefined) ?? DEFAULT_MAX_CHARS;

				if (!url) throw new ValidationError("url is required.");
				if (!/^https?:\/\//i.test(url))
					throw new ValidationError(`url must start with http:// or https://. Got: ${url}`);

				onUpdate?.({
					content: [{ type: "text", text: `Fetching ${url}…` }],
					details: { phase: "fetching", url },
				});

				const response = await fetch(url, {
					signal,
					headers: { "User-Agent": "pi-search/1.0 (+https://github.com/heyhuynhgiabuu/pi-search)" },
					redirect: "follow",
				});

				if (!response.ok) {
					throw new FetchError("fetch_error", `HTTP ${response.status} ${response.statusText} for ${url}`);
				}

				const contentType = response.headers.get("content-type") ?? "";
				let body = await response.text();

				if (body.length > MAX_FETCH_BYTES) {
					body = `${body.slice(0, MAX_FETCH_BYTES)}\n\n[truncated to ${MAX_FETCH_BYTES} bytes]`;
				}

				// Strip HTML if we got a non-text content-type
				if (contentType.includes("text/html")) {
					body = stripHtml(body);
				}

				if (body.length > maxOutputChars) {
					body = `${body.slice(0, maxOutputChars)}\n\n[truncated to ${maxOutputChars} chars]`;
				}

				const citations = dedupeCitations(extractCitationsFromMcpText(body, "web"));
				const footer = formatCitationFooter(citations);

				return {
					content: [{ type: "text", text: `${body}${footer}` }],
					details: {
						provider: "web-fetch",
						url,
						contentType,
						originalLength: body.length,
						citationCount: citations.length,
					},
				};
			} catch (error) {
				return buildErrorResult(toPiSearchError(error));
			}
		},
		renderResult: renderWebFetchResult,
	};
}

function stripHtml(html: string): string {
	// Remove script/style blocks
	let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
	text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
	// Strip tags but keep line breaks for block elements
	text = text.replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, "\n");
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(/<[^>]+>/g, "");
	// Decode common entities
	text = text
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
	// Collapse whitespace
	text = text.replace(/\n{3,}/g, "\n\n");
	return text.trim();
}
