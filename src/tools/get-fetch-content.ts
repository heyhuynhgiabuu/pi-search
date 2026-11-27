import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { bool, compile, int, nullable, num, obj, opt, str } from "@earendil-works/pi-schema";
import { buildErrorResult, toPiSearchError, ValidationError } from "../errors.js";
import { getFetchContent, listFetchContent } from "../fetch/content-store.js";
import { renderFetchContentResult, renderToolCall } from "./render.js";

const DEFAULT_SLICE_CHARS = 50_000;

const MAX_SLICE_CHARS = 200_000;

const getFetchContentParameters = obj({
	fetchId: opt(str({ description: "ID from web_fetch details.fetchId." })),
	list: opt(bool({ description: "List recent stored fetches (ids and URLs) instead of reading one." })),
	offset: opt(int({ description: "Character offset into stored text (default 0).", minimum: 0 })),
	maxChars: opt(
		int({
			description: `Max characters to return (default ${DEFAULT_SLICE_CHARS}).`,
			minimum: 1000,
			maximum: MAX_SLICE_CHARS,
		}),
	),
});

// Bounds are clamped in execute() rather than rejected, so direct callers keep the lenient behavior.
const validateGetFetchContentParams = compile(
	obj(
		{
			fetchId: opt(nullable(str())),
			list: opt(nullable(bool())),
			offset: opt(nullable(num())),
			maxChars: opt(nullable(num())),
		},
		{ open: true },
	),
);

export function createGetFetchContentTool(): ToolDefinition {
	return {
		name: "get_fetch_content",
		label: "⚙ get_fetch_content",
		renderCall: renderToolCall("get_fetch_content"),
		renderResult: renderFetchContentResult,
		description:
			"Retrieve full text from a prior web_fetch when the tool response was truncated. Use fetchId from web_fetch details, or list=true to see recent stored fetches.",
		parameters: getFetchContentParameters,
		async execute(_id, params) {
			try {
				const parsed = validateGetFetchContentParams.validate(params);

				if (!parsed.ok) {
					const first = parsed.errors[0];
					throw new ValidationError(
						first ? `${first.path || "params"}: ${first.message}` : "Invalid get_fetch_content parameters.",
					);
				}

				const args = parsed.value;

				if (args.list === true) {
					const entries = listFetchContent().slice(0, 20);

					if (entries.length === 0) {
						return {
							content: [{ type: "text", text: "No stored fetch content in this session." }],
							details: { count: 0 },
						};
					}

					const lines = entries.map(
						(e) => `- ${e.id}  ${e.url}${e.title ? `  (${e.title})` : ""}  [${e.text.length} chars]`,
					);

					return {
						content: [{ type: "text", text: `Stored fetches:\n${lines.join("\n")}` }],
						details: { count: entries.length, ids: entries.map((e) => e.id) },
					};
				}

				const fetchId = args.fetchId?.trim() ?? "";

				if (!fetchId) {
					throw new ValidationError("Provide fetchId or set list=true.");
				}

				const record = getFetchContent(fetchId);

				if (!record) {
					throw new ValidationError(`Unknown fetchId: ${fetchId}. Use list=true to see stored ids.`);
				}

				const offset =
					args.offset !== undefined && args.offset !== null && args.offset >= 0 ? Math.floor(args.offset) : 0;

				const maxChars =
					args.maxChars !== undefined && args.maxChars !== null
						? Math.min(MAX_SLICE_CHARS, Math.max(1000, Math.floor(args.maxChars)))
						: DEFAULT_SLICE_CHARS;

				const slice = record.text.slice(offset, offset + maxChars);
				const hasMore = offset + slice.length < record.text.length;
				const header = record.title ? `# ${record.title}\n\n` : "";
				let text = `${header}${slice}`;

				if (hasMore) {
					text += `\n\n[${record.text.length - offset - slice.length} more chars — call again with offset=${offset + slice.length}]`;
				}

				return {
					content: [{ type: "text", text }],
					details: {
						fetchId: record.id,
						url: record.url,
						offset,
						returnedChars: slice.length,
						totalChars: record.text.length,
						hasMore,
					},
				};
			} catch (error) {
				return buildErrorResult(toPiSearchError(error));
			}
		},
	};
}
