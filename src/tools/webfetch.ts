import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { compile, num, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import { buildErrorResult, toPiSearchError } from "../errors.js";
import { FETCH_CONTENT_CUSTOM_TYPE, putFetchContent, WEB_FETCH_INLINE_MAX_CHARS } from "../fetch/content-store.js";
import { resolveUrlContent } from "../fetch/resolve-content.js";
import type { ResolvedConfig } from "../types.js";
import { renderToolCall, renderWebFetchResult } from "./render.js";

const DEFAULT_MAX_OUTPUT_CHARS = 50_000;

const MAX_OUTPUT_CHARS_LIMIT = 200_000;

const stringValidator = compile(str());

const numberValidator = compile(num());

const webFetchExecuteValidator = compile(
	obj(
		{
			url: opt(unknown()),
			maxOutputChars: opt(unknown()),
		},
		{ open: true },
	),
);

export function createWebFetchTool(pi: ExtensionAPI, config: ResolvedConfig): ToolDefinition {
	const canRetrieveStoredContent = !config.disabledTools.has("get_fetch_content");

	const parameters = obj({
		url: str({ description: "The URL to fetch (must be http:// or https://)." }),
		maxOutputChars: opt(
			num({
				description: canRetrieveStoredContent
					? `Maximum characters to return inline (default ${DEFAULT_MAX_OUTPUT_CHARS}). Full body may still be continued with get_fetch_content.`
					: `Maximum characters to return inline (default ${DEFAULT_MAX_OUTPUT_CHARS}).`,
				minimum: 1000,
				maximum: MAX_OUTPUT_CHARS_LIMIT,
			}),
		),
	});

	return {
		name: "web_fetch",
		label: "⚙ web_fetch",
		renderCall: renderToolCall("web_fetch"),
		renderResult: renderWebFetchResult,
		description: canRetrieveStoredContent
			? "Read a specific public URL (HTTP/HTTPS) selected by the user or websearch and return readable content. Use only for external page content. Do not use for greetings, local files, or local repository work. Large bodies can be continued with get_fetch_content."
			: "Read a specific public URL (HTTP/HTTPS) selected by the user or websearch and return readable content. Use only for external page content. Do not use for greetings, local files, or local repository work.",
		promptSnippet: "Read a specific external URL selected by the user or websearch",
		promptGuidelines: [
			"Use web_fetch only for a user-provided or search-result URL when external page content is needed.",
			"Do not use web_fetch for greetings, local files, or local repository questions.",
		],
		parameters,
		async execute(_toolCallId, params, signal) {
			try {
				const parsed = webFetchExecuteValidator.validate(params);

				const url = parsed.ok && stringValidator.check(parsed.value.url) ? parsed.value.url : "";

				const maxOutputChars =
					parsed.ok && numberValidator.check(parsed.value.maxOutputChars)
						? parsed.value.maxOutputChars
						: DEFAULT_MAX_OUTPUT_CHARS;

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
						? `${resolved.text.slice(0, inlineLimit)}\n\n${
								canRetrieveStoredContent
									? `[truncated — full ${resolved.text.length} chars stored; use get_fetch_content with fetchId ${fetchId}]`
									: `[truncated — ${resolved.text.length} chars total]`
							}`
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
