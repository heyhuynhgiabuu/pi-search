/**
 * context7 tool — fetches up-to-date library documentation and code examples.
 *
 * Context7 (https://context7.com) provides a free REST API at
 * https://context7.com/api/v1/{libraryId} for resolving library IDs
 * and https://context7.com/api/v2 for general docs/code snippets.
 *
 * No API key required.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolveConfig } from "../config.js";
import { buildErrorResult, FetchError, toPiSearchError, ValidationError } from "../errors.js";
import { renderContext7Result, renderToolCall } from "./render.js";

const CONTEXT7_API = "https://context7.com/api/v1";

type Context7SearchResponse = {
	results: Array<{
		id: string;
		title: string;
		description?: string;
		totalSnippets?: number;
		trustScore?: number;
		versions?: string[];
	}>;
};

type Context7DocsResponse = {
	content?: string;
	metadata?: { title?: string; url?: string };
};

export function createContext7Tool(_pi: ExtensionAPI) {
	return {
		name: "context7",
		label: "⚙ context7",
		description:
			"Fetch up-to-date documentation and code examples for a library via Context7. Use libraryName='react' or '/reactjs/react.dev' for the official React docs, '/vercel/next.js' for Next.js, etc. Returns ready-to-use code snippets and citations.",
		parameters: Type.Object({
			libraryName: Type.Optional(
				Type.String({ description: "Library name or Context7 path (e.g. 'react', '/reactjs/react.dev')." }),
			),
			topic: Type.Optional(Type.String({ description: "Specific topic to focus on (e.g. 'hooks', 'routing')." })),
			maxTokens: Type.Optional(
				Type.Integer({ description: "Maximum tokens to return (default 10000).", minimum: 1000, maximum: 50000 }),
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
				if (config.disabledTools.has("context7")) {
					throw new ValidationError("context7 is disabled in config.");
				}

				const libraryName = (params.libraryName as string | undefined)?.trim();
				const topic = (params.topic as string | undefined)?.trim();
				const maxTokens = (params.maxTokens as number | undefined) ?? 10000;

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
	const data = (await response.json()) as Context7SearchResponse;
	if (!data.results || data.results.length === 0) return null;
	return data.results[0].id;
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
			return JSON.parse(body) as Context7DocsResponse;
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
