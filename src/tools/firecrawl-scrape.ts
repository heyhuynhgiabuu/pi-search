import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { buildErrorResult, ConfigError, toPiSearchError, ValidationError } from "../errors.js";
import { FETCH_CONTENT_CUSTOM_TYPE, putFetchContent } from "../fetch/content-store.js";
import { FirecrawlClient } from "../firecrawl/client.js";
import type { ResolvedConfig } from "../types.js";

function isAbsoluteHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

export function createFirecrawlScrapeTool(pi: ExtensionAPI, config: ResolvedConfig): ToolDefinition {
	return {
		name: "firecrawl_scrape",
		label: "⚙ firecrawl_scrape",
		description:
			"Scrape a web page into Markdown using Firecrawl. Each page consumes Firecrawl credits. " +
			"Requires FIRECRAWL_API_KEY or firecrawlApiKey in config. Full content is retrievable via get_fetch_content.",
		parameters: Type.Object({
			url: Type.String({ description: "Absolute http:// or https:// URL to scrape." }),
			onlyMainContent: Type.Optional(
				Type.Boolean({ description: "Extract only the page's main content. Defaults to true.", default: true }),
			),
			timeout: Type.Optional(
				Type.Number({ description: "Firecrawl request timeout in milliseconds.", minimum: 1_000, maximum: 120_000 }),
			),
		}),
		async execute(_toolCallId, params: Record<string, unknown>, signal) {
			if (!config.firecrawlApiKey) {
				return buildErrorResult(
					new ConfigError(
						"Firecrawl API key not configured. Set FIRECRAWL_API_KEY or add firecrawlApiKey to ~/.pi/pi-search.json.",
					),
				);
			}

			try {
				const url = typeof params.url === "string" ? params.url : "";
				if (!isAbsoluteHttpUrl(url)) {
					throw new ValidationError("url must be an absolute http:// or https:// URL.");
				}

				const result = await new FirecrawlClient({ apiKey: config.firecrawlApiKey }).scrape(
					{
						url,
						onlyMainContent: typeof params.onlyMainContent === "boolean" ? params.onlyMainContent : true,
						timeout: typeof params.timeout === "number" ? params.timeout : undefined,
					},
					signal ?? undefined,
				);
				const markdown = result.markdown ?? "";
				const sourceURL = typeof result.metadata?.sourceURL === "string" ? result.metadata.sourceURL : url;
				const title = typeof result.metadata?.title === "string" ? result.metadata.title : undefined;
				const { id, record } = putFetchContent({
					url: sourceURL,
					title: title ?? null,
					text: markdown,
					extraction: "firecrawl",
				});
				setImmediate(() => pi.appendEntry(FETCH_CONTENT_CUSTOM_TYPE, record));

				const heading = title ? `# ${title}\n\n` : "";
				return {
					content: [{ type: "text" as const, text: `${heading}${markdown}\n\n[Full content: ${id}]` }],
					details: {
						fetchId: id,
						sourceURL,
						title,
						length: markdown.length,
						scrapeMethod: "firecrawl",
					},
				};
			} catch (error) {
				return buildErrorResult(toPiSearchError(error));
			}
		},
	};
}
