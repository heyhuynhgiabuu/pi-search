/**
 * context7 tool — fetches up-to-date library documentation and code examples.
 *
 * Context7 (https://context7.com) provides a free REST API at
 * https://context7.com/api/v1/{libraryId} for resolving library IDs
 * and https://context7.com/api/v2 for general docs/code snippets.
 *
 * No API key required.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { arr, compile, int, nullable, num, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import { resolveConfig } from "../config.js";
import { buildErrorResult, FetchError, toPiSearchError, ValidationError } from "../errors.js";
import { renderContext7Result, renderToolCall } from "./render.js";

const CONTEXT7_API = "https://context7.com/api/v1";

const stringValidator = compile(str());

const Context7SearchResponseSchema = obj(
	{
		results: opt(nullable(arr(unknown()))),
	},
	{ open: true },
);

const context7SearchValidator = compile(Context7SearchResponseSchema);

const context7SearchFirstResultValidator = compile(
	obj(
		{
			id: nullable(str()),
		},
		{ open: true },
	),
);

const Context7DocsMetadataSchema = obj(
	{
		title: opt(unknown()),
		url: opt(unknown()),
	},
	{ open: true },
);

const context7DocsMetadataValidator = compile(Context7DocsMetadataSchema);

const Context7DocsResponseSchema = obj(
	{
		content: opt(unknown()),
		metadata: opt(unknown()),
	},
	{ open: true },
);

type Context7DocsMetadata = {
	title?: string;
	url?: string;
};

type Context7DocsResponse = {
	content?: string;
	metadata?: Context7DocsMetadata;
};

const context7DocsValidator = compile(Context7DocsResponseSchema);

const context7Parameters = obj({
	libraryName: str({ description: "Library name or Context7 path (e.g. 'react', '/reactjs/react.dev')." }),
	topic: opt(str({ description: "Specific topic to focus on (e.g. 'hooks', 'routing')." })),
	maxTokens: opt(int({ description: "Maximum tokens to return (default 10000).", minimum: 1000, maximum: 50000 })),
});

const validateContext7ExecuteParams = compile(
	obj(
		{
			libraryName: opt(nullable(str())),
			topic: opt(nullable(str())),
			maxTokens: opt(nullable(num())),
		},
		{ open: true },
	),
);

export function createContext7Tool(_pi: ExtensionAPI): ToolDefinition {
	return {
		name: "context7",
		label: "⚙ context7",
		description:
			"Fetch up-to-date documentation and code examples for a library via Context7. Use libraryName='react' or '/reactjs/react.dev' for the official React docs, '/vercel/next.js' for Next.js, etc. Returns ready-to-use code snippets and citations.",
		parameters: context7Parameters,
		async execute(_id, params, signal, onUpdate) {
			try {
				const config = resolveConfig();

				if (config.disabledTools.has("context7")) {
					throw new ValidationError("context7 is disabled in config.");
				}

				const parsed = validateContext7ExecuteParams.validate(params);

				if (!parsed.ok) {
					const first = parsed.errors[0];
					throw new ValidationError(
						first ? `${first.path || "params"}: ${first.message}` : "Invalid context7 parameters.",
					);
				}

				const libraryName = parsed.value.libraryName?.trim();
				const topic = parsed.value.topic?.trim();
				const maxTokens = parsed.value.maxTokens ?? 10000;

				if (!libraryName) {
					throw new ValidationError("libraryName is required.");
				}

				onUpdate?.({
					content: [{ type: "text", text: `Context7: resolving library "${libraryName}"…` }],
					details: { phase: "resolving-library" },
				});

				// Step 1: resolve library name to ID
				const libraryId = await resolveLibraryId(libraryName, signal);

				if (!libraryId) {
					throw new ValidationError(`Library not found on Context7: ${libraryName}`);
				}

				onUpdate?.({
					content: [
						{ type: "text", text: `Context7: fetching docs for ${libraryId}${topic ? ` (topic: ${topic})` : ""}…` },
					],
					details: { phase: "fetching-docs", libraryId, topic },
				});

				// Step 2: fetch docs
				const docs = await fetchDocs(libraryId, topic, maxTokens, signal);

				return {
					content: [{ type: "text", text: renderOutput(libraryId, docs) }],
					details: { provider: "context7", libraryId, topic, contentLength: docs.content?.length ?? 0 },
				};
			} catch (error) {
				return buildErrorResult(toPiSearchError(error));
			}
		},
		renderCall: renderToolCall("context7"),
		renderResult: renderContext7Result,
	};
}

async function resolveLibraryId(name: string, signal: AbortSignal | undefined): Promise<string | null> {
	const url = `${CONTEXT7_API}/search?query=${encodeURIComponent(name)}`;
	const response = await fetch(url, { signal });

	if (!response.ok) {
		throw new FetchError("fetch_error", `Context7 search returned ${response.status}`);
	}

	const parsed = context7SearchValidator.validate(await response.json());

	if (!parsed.ok || !parsed.value.results || parsed.value.results.length === 0) return null;

	const first = context7SearchFirstResultValidator.validate(parsed.value.results[0]);

	if (!first.ok) return null;

	return first.value.id ?? null;
}

async function fetchDocs(
	libraryId: string,
	topic: string | undefined,
	maxTokens: number,
	signal: AbortSignal | undefined,
): Promise<Context7DocsResponse> {
	const params = new URLSearchParams();
	params.set("type", "txt");
	params.set("tokens", String(maxTokens));

	if (topic) params.set("topic", topic);
	const url = `${CONTEXT7_API}/${libraryId}?${params.toString()}`;
	const response = await fetch(url, { signal });

	if (!response.ok) {
		if (response.status === 404) {
			throw new ValidationError(`No documentation found for ${libraryId}.`);
		}

		throw new FetchError("fetch_error", `Context7 docs returned ${response.status}`);
	}

	const body = await response.text();
	const contentType = response.headers.get("content-type") ?? "";

	if (contentType.includes("application/json") || body.trimStart().startsWith("{")) {
		try {
			const parsed = context7DocsValidator.validate(JSON.parse(body));

			if (parsed.ok) {
				const docs: Context7DocsResponse = {};

				if (stringValidator.check(parsed.value.content)) {
					docs.content = parsed.value.content;
				}

				if (context7DocsMetadataValidator.check(parsed.value.metadata)) {
					const metadata: Context7DocsMetadata = {};

					if (stringValidator.check(parsed.value.metadata.title)) {
						metadata.title = parsed.value.metadata.title;
					}

					if (stringValidator.check(parsed.value.metadata.url)) {
						metadata.url = parsed.value.metadata.url;
					}

					docs.metadata = metadata;
				}

				return docs;
			}
		} catch {
			// Context7's txt endpoint may omit/lie about content-type; fall through to text.
		}
	}

	return {
		content: body,
		metadata: { title: libraryId, url: `https://context7.com${libraryId}` },
	};
}

function renderOutput(libraryId: string, docs: Context7DocsResponse): string {
	const lines: string[] = [`## ${docs.metadata?.title ?? libraryId}`, ""];

	if (docs.content) {
		lines.push(docs.content);
	} else {
		lines.push("(no content returned)");
	}

	if (docs.metadata?.url) {
		lines.push("", `Source: ${docs.metadata.url}`);
	}

	return lines.join("\n").trim();
}
