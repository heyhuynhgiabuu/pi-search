import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { bool, compile, num, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import { buildErrorResult, ConfigError, toPiSearchError, ValidationError } from "../errors.js";
import { FETCH_CONTENT_CUSTOM_TYPE, putFetchContent } from "../fetch/content-store.js";
import { FirecrawlClient } from "../firecrawl/client.js";
import type { ResolvedConfig } from "../types.js";

const FirecrawlScrapeParamsSchema = obj({
	url: str({ description: "Absolute http:// or https:// URL to scrape." }),
	onlyMainContent: opt(bool({ description: "Extract only the page's main content. Defaults to true.", default: true })),
	timeout: opt(num({ description: "Firecrawl request timeout in milliseconds.", minimum: 1_000, maximum: 120_000 })),
});

const firecrawlScrapeExecuteValidator = compile(
	obj(
		{
			url: opt(unknown()),
			onlyMainContent: opt(unknown()),
			timeout: opt(unknown()),
		},
		{ open: true },
	),
);

const stringValidator = compile(str());

const booleanValidator = compile(bool());

const numberValidator = compile(num());

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
		parameters: FirecrawlScrapeParamsSchema,
		async execute(_toolCallId, params, signal) {
			if (!config.firecrawlApiKey) {
				return buildErrorResult(
					new ConfigError(
						"Firecrawl API key not configured. Set FIRECRAWL_API_KEY or add firecrawlApiKey to ~/.pi/pi-search.json.",
					),
				);
			}

			try {
				const parsed = firecrawlScrapeExecuteValidator.validate(params);

				if (!parsed.ok) {
					const first = parsed.errors[0];
					throw new ValidationError(
						first ? `${first.path || "/"}: ${first.message}` : "Invalid firecrawl_scrape parameters.",
					);
				}

				const url = stringValidator.check(parsed.value.url) ? parsed.value.url : "";

				if (!isAbsoluteHttpUrl(url)) {
					throw new ValidationError("url must be an absolute http:// or https:// URL.");
				}

				const onlyMainContent = booleanValidator.check(parsed.value.onlyMainContent)
					? parsed.value.onlyMainContent
					: true;

				const timeout = numberValidator.check(parsed.value.timeout) ? parsed.value.timeout : undefined;

				const result = await new FirecrawlClient({ apiKey: config.firecrawlApiKey }).scrape(
					{
						url,
						onlyMainContent,
						timeout,
					},
					signal ?? undefined,
				);

				const markdown = result.markdown ?? "";
				const sourceURL = result.metadata?.sourceURL ?? url;
				const title = result.metadata?.title;

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
