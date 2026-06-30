import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { buildErrorResult, toPiSearchError, ValidationError } from "../errors.js";
import { getFetchContent, listFetchContent } from "../fetch/content-store.js";

const DEFAULT_SLICE_CHARS = 50_000;
const MAX_SLICE_CHARS = 200_000;

export function createGetFetchContentTool(): ToolDefinition {
	return {
		name: "get_fetch_content",
		label: "Get Fetch Content",
		description:
			"Retrieve full text from a prior web_fetch when the tool response was truncated. Use fetchId from web_fetch details, or list=true to see recent stored fetches.",
		parameters: Type.Object({
			fetchId: Type.Optional(Type.String({ description: "ID from web_fetch details.fetchId." })),
			list: Type.Optional(
				Type.Boolean({ description: "List recent stored fetches (ids and URLs) instead of reading one." }),
			),
			offset: Type.Optional(
				Type.Integer({ description: "Character offset into stored text (default 0).", minimum: 0 }),
			),
			maxChars: Type.Optional(
				Type.Integer({
					description: `Max characters to return (default ${DEFAULT_SLICE_CHARS}).`,
					minimum: 1000,
					maximum: MAX_SLICE_CHARS,
				}),
			),
		}),
		async execute(_id, params: Record<string, unknown>) {
			try {
				if (params.list === true) {
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

				const fetchId = typeof params.fetchId === "string" ? params.fetchId.trim() : "";
				if (!fetchId) {
					throw new ValidationError("Provide fetchId or set list=true.");
				}

				const record = getFetchContent(fetchId);
				if (!record) {
					throw new ValidationError(`Unknown fetchId: ${fetchId}. Use list=true to see stored ids.`);
				}

				const offset = typeof params.offset === "number" && params.offset >= 0 ? Math.floor(params.offset) : 0;
				const maxChars =
					typeof params.maxChars === "number"
						? Math.min(MAX_SLICE_CHARS, Math.max(1000, Math.floor(params.maxChars)))
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
