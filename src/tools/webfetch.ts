import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { buildErrorResult, toPiSearchError } from "../errors.js";
import { FETCH_CONTENT_CUSTOM_TYPE, putFetchContent, WEB_FETCH_INLINE_MAX_CHARS } from "../fetch/content-store.js";
import { resolveUrlContent } from "../fetch/resolve-content.js";
import type { ResolvedConfig } from "../types.js";

const DEFAULT_MAX_OUTPUT_CHARS = 50_000;
const MAX_OUTPUT_CHARS_LIMIT = 200_000;

export function createWebFetchTool(pi: ExtensionAPI, config: ResolvedConfig): ToolDefinition {
	return {
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a URL and return readable content (Readability/turndown for HTML; Jina Reader fallback on thin/consent pages; GitHub URLs via API). Large pages store full text — use fetchId with get_fetch_content. Survives Pi session resume via session JSONL. For local video/PDF use pi-web-access fetch_content.",
		parameters: Type.Object({
			url: Type.String({ description: "The URL to fetch (must be http:// or https://)." }),
			maxOutputChars: Type.Optional(
				Type.Number({
					description: `Maximum characters to return inline (default ${DEFAULT_MAX_OUTPUT_CHARS}). Full body may still be stored for get_fetch_content.`,
					minimum: 1000,
					maximum: MAX_OUTPUT_CHARS_LIMIT,
				}),
			),
		}),
		async execute(_toolCallId, params: Record<string, unknown>, signal) {
			try {
				const url = typeof params.url === "string" ? params.url : "";
				const maxOutputChars =
					typeof params.maxOutputChars === "number" ? params.maxOutputChars : DEFAULT_MAX_OUTPUT_CHARS;
				const resolved = await resolveUrlContent(url, config, { signal, maxOutputChars: MAX_OUTPUT_CHARS_LIMIT });

				const { id: fetchId, record } = putFetchContent({
					url: resolved.url,
					title: resolved.title,
					text: resolved.text,
					extraction: resolved.extraction,
				});
				pi.appendEntry(FETCH_CONTENT_CUSTOM_TYPE, record);

				const inlineLimit = Math.min(maxOutputChars, WEB_FETCH_INLINE_MAX_CHARS);
				const inlineBody =
					resolved.text.length > inlineLimit
						? `${resolved.text.slice(0, inlineLimit)}\n\n[truncated — full ${resolved.text.length} chars stored; use get_fetch_content with fetchId ${fetchId}]`
						: resolved.text;

				const header = resolved.title ? `# ${resolved.title}\n\n` : "";
				const output = `${header}${inlineBody}`;

				const truncatedInline = resolved.text.length > inlineLimit;

				return {
					content: [{ type: "text", text: output }],
					details: {
						url: resolved.url,
						title: resolved.title,
						contentType: resolved.contentType,
						status: resolved.status,
						extraction: resolved.extraction,
						truncated: truncatedInline || resolved.truncated,
						charCount: resolved.text.length,
						fetchId,
						storedChars: resolved.text.length,
					},
				};
			} catch (error) {
				return buildErrorResult(toPiSearchError(error));
			}
		},
	};
}
