/**
 * pi-search — Web search, code search, GitHub grep, and docs lookup for pi.
 *
 * @module pi-search
 * @see https://github.com/buddingnewinsights/pi-search
 *
 * Tools:
 *   • grepsearch — Search real-world code on GitHub via grep.app
 *   • websearch  — Real-time web search via Exa AI (no API key)
 *   • codesearch — Technical doc/example search via Exa AI web search (no API key)
 *   • context7   — Resolve library IDs and query official documentation
 *
 * Architecture:
 *   Single extension entry point registers all tools.
 *   grep.app and Context7 use plain REST. Exa uses JSON-RPC 2.0 over SSE.
 *   codesearch is implemented on top of Exa web search because the current public MCP endpoint exposes
 *   web tools (`web_search_exa`, `web_fetch_exa`) but not the older dedicated code-context tool.
 *   Zero runtime dependencies beyond @sinclair/typebox for param schemas.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";

// ===========================================================================
// Config
// ===========================================================================

const TOOL_NAMES = ["grepsearch", "websearch", "codesearch", "context7", "web_fetch"] as const;
type ToolName = (typeof TOOL_NAMES)[number];

interface PiSearchConfig {
	disabledTools?: ToolName[];
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-search.json");

function loadConfig(): PiSearchConfig {
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		if (!Array.isArray(raw.disabledTools)) {
			raw.disabledTools = [];
		}
		return raw;
	} catch {
		return {};
	}
}

// ===========================================================================
// Constants
// ===========================================================================

const GREP_APP_API = "https://grep.app/api/search";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const CONTEXT7_API = "https://context7.com/api/v2";
const USER_AGENT = "pi-search/1.0";

// ===========================================================================
// Types
// ===========================================================================

interface GrepHit {
	repo: string;
	path: string;
	content: { snippet: string };
	total_matches: string;
}

interface GrepResponse {
	hits: { hits: GrepHit[] };
	time: number;
}

interface Context7LibraryInfo {
	id: string;
	title: string;
	description?: string;
	totalSnippets?: number;
	benchmarkScore?: number;
}

interface Context7SearchResponse {
	results: Context7LibraryInfo[];
}

// ===========================================================================
// Shared: Exa MCP caller (JSON-RPC 2.0 over SSE)
// ===========================================================================

async function callExaMCP(
	toolName: string,
	args: Record<string, unknown>,
	signal: AbortSignal,
	timeoutMs = 30_000,
): Promise<string> {
	const controller = new AbortController();
	const combinedSignal = AbortSignal.any([signal, controller.signal]);
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const body = JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: toolName, arguments: args },
		});

		const response = await fetch(EXA_MCP_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"User-Agent": USER_AGENT,
			},
			body,
			signal: combinedSignal,
		});

		if (!response.ok) {
			throw new Error(`Exa MCP returned ${response.status}: ${response.statusText}`);
		}

		const text = await response.text();
		const contentType = response.headers.get("content-type") ?? "";

		// Try direct JSON first
		if (contentType.includes("application/json") || text.startsWith("{")) {
			try {
				const parsed = JSON.parse(text);
				if (parsed.result?.content) {
					return parsed.result.content
						.filter((c: { type: string }) => c.type === "text")
						.map((c: { text: string }) => c.text)
						.join("\n");
				}
				if (parsed.error) {
					throw new Error(`Exa error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
				}
			} catch (e) {
				if (!(e instanceof SyntaxError)) throw e;
			}
		}

		// Fall back to SSE parsing
		const dataLines = text
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim());

		for (const line of dataLines) {
			try {
				const parsed = JSON.parse(line);
				if (parsed.result?.content) {
					return parsed.result.content
						.filter((c: { type: string }) => c.type === "text")
						.map((c: { text: string }) => c.text)
						.join("\n");
				}
				if (parsed.error) {
					throw new Error(`Exa error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
				}
			} catch (e) {
				if (e instanceof SyntaxError) continue;
				throw e;
			}
		}

		return dataLines.join("\n") || text.slice(0, 5000);
	} finally {
		clearTimeout(timer);
	}
}

// ===========================================================================
// Shared: HTML entity cleanup for grep.app snippets
// ===========================================================================

function cleanSnippet(html: string): string {
	return html
		.replace(/<[^>]*>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.split("\n")
		.slice(0, 8)
		.join("\n")
		.trim();
}

// ===========================================================================
// Shared: Truncate Exa MCP results (Highlights can contain near-full page content)
// ===========================================================================

const MAX_HIGHLIGHTS_CHARS = 500;
const MAX_PAGE_CHARS = 10_000;

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function paginateText(content: string, offset: number, maxChars: number, header?: string): string {
	const clamped = Math.max(0, Math.min(offset, content.length));
	const slice = content.slice(clamped, clamped + maxChars);
	const remaining = content.length - clamped - slice.length;
	let text = header && clamped === 0 ? header + slice : slice;
	if (remaining > 0) {
		text += `\n\n… [${remaining} chars remaining — call again with offset: ${clamped + maxChars} to continue]`;
	}
	return text;
}

function truncateExaResults(raw: string): string {
	const blocks = raw.split("\n---\n");
	const truncated = blocks.map((block) => {
		const idx = block.indexOf("Highlights:\n");
		if (idx === -1) return block;
		const header = block.slice(0, idx + "Highlights:\n".length);
		let highlights = block.slice(idx + "Highlights:\n".length);
		if (highlights.length > MAX_HIGHLIGHTS_CHARS) {
			highlights = `${highlights.slice(0, MAX_HIGHLIGHTS_CHARS).trimEnd()}…`;
		}
		return header + highlights;
	});
	return truncated.join("\n---\n");
}

function context7HttpError(status: number, operation: string, libraryId?: string) {
	if (status === 401) {
		return {
			content: [
				{
					type: "text" as const,
					text: "Error: Invalid CONTEXT7_API_KEY. Get a free key at https://context7.com/dashboard",
				},
			],
			details: { operation, error: "auth" },
		};
	}
	if (status === 404 && libraryId) {
		return {
			content: [
				{
					type: "text" as const,
					text: `Error: Library not found: ${libraryId}\n\nUse operation: "resolve" first to find the correct ID.`,
				},
			],
			details: { operation, error: "not_found" },
		};
	}
	if (status === 429) {
		return {
			content: [
				{
					type: "text" as const,
					text: "Error: Rate limit exceeded. Get a free API key at https://context7.com/dashboard for higher limits.",
				},
			],
			details: { operation, error: "rate_limit" },
		};
	}
	return {
		content: [{ type: "text" as const, text: `Error: Context7 API returned ${status}` }],
		details: { operation, error: `http_${status}` },
	};
}

// ===========================================================================
// Extension entry point
// ===========================================================================

export default function piSearchExtension(pi: { registerTool: (tool: Record<string, unknown>) => void }): void {
	const config = loadConfig();
	const disabled = new Set(config.disabledTools ?? []);

	// -----------------------------------------------------------------------
	// Tool 1: grepsearch — GitHub code search via grep.app
	// -----------------------------------------------------------------------

	if (!disabled.has("grepsearch"))
		pi.registerTool({
			name: "grepsearch",
			label: "Grep Search",
			description: `Search real-world code examples from GitHub repositories via grep.app.

Use when:
- Implementing unfamiliar APIs - see how others use a library
- Looking for production patterns - find real-world examples
- Understanding library integrations - see how things work together

IMPORTANT: Search for **literal code patterns**, not keywords:
Good: "useState(", "import React from", "async function"
Bad: "react tutorial", "best practices", "how to use"

Examples:
  grepsearch({ query: "getServerSession", language: "TypeScript" })
  grepsearch({ query: "CORS(", language: "Python", repo: "flask" })
  grepsearch({ query: "export async function POST", path: "route.ts" })`,
			promptSnippet: "Search real-world code examples from GitHub repos via grep.app.",

			parameters: Type.Object({
				query: Type.String({ description: "Code pattern to search for (literal text)" }),
				language: Type.Optional(
					Type.String({ description: "Filter by language: TypeScript, TSX, Python, Go, Rust, etc." }),
				),
				repo: Type.Optional(Type.String({ description: "Filter by repo: 'owner/repo' or partial match" })),
				path: Type.Optional(Type.String({ description: "Filter by file path: 'src/', '.test.ts', etc." })),
				limit: Type.Optional(Type.Number({ description: "Max results to return (default: 10, max: 20)" })),
			}),

			async execute(
				_toolCallId: string,
				params: { query: string; language?: string; repo?: string; path?: string; limit?: number },
				signal: AbortSignal,
			) {
				const { query, language, repo, path, limit = 10 } = params;

				if (!query?.trim()) {
					return {
						content: [{ type: "text" as const, text: "Error: query is required" }],
						details: { error: "query required" },
					};
				}

				const url = new URL(GREP_APP_API);
				url.searchParams.set("q", query);
				if (language) url.searchParams.set("filter[lang][0]", language);
				if (repo) url.searchParams.set("filter[repo][0]", repo);
				if (path) url.searchParams.set("filter[path][0]", path);

				try {
					const response = await fetch(url.toString(), {
						headers: { Accept: "application/json", "User-Agent": USER_AGENT },
						signal,
					});

					if (!response.ok) {
						return {
							content: [{ type: "text" as const, text: `Error: grep.app API returned ${response.status}` }],
							details: { error: `http_${response.status}` },
						};
					}

					const data = (await response.json()) as GrepResponse;

					if (!data.hits?.hits?.length) {
						return {
							content: [
								{
									type: "text" as const,
									text: `No results found for: ${query}${language ? ` (${language})` : ""}`,
								},
							],
							details: { query, results: 0 },
						};
					}

					const maxResults = Math.min(limit, 20);
					const results = data.hits.hits.slice(0, maxResults);

					const formatted = results.map((hit, i) => {
						const repoName = hit.repo || "unknown";
						const filePath = hit.path || "unknown";
						const cleanCode = cleanSnippet(hit.content?.snippet || "");
						return `## ${i + 1}. ${repoName}\n**File**: ${filePath}\n\`\`\`\n${cleanCode}\n\`\`\``;
					});

					return {
						content: [
							{
								type: "text" as const,
								text: `Found ${data.hits.hits.length} results (showing ${results.length}) in ${data.time}ms:\n\n${formatted.join("\n\n")}`,
							},
						],
						details: { query, language, totalResults: data.hits.hits.length, shown: results.length, timeMs: data.time },
					};
				} catch (error: unknown) {
					const message = errorMessage(error);
					return {
						content: [{ type: "text" as const, text: `Error searching grep.app: ${message}` }],
						details: { error: message },
					};
				}
			},
		});

	// -----------------------------------------------------------------------
	// Tool 2: websearch — Real-time web search via Exa AI
	// -----------------------------------------------------------------------

	if (!disabled.has("websearch"))
		pi.registerTool({
			name: "websearch",
			label: "Web Search",
			description:
				"Search the web using Exa AI. Returns relevant results with content snippets. Use for current information, documentation, blog posts, discussions. No API key required.",
			promptSnippet: "Search the web via Exa AI for current information, docs, and discussions.",

			parameters: Type.Object({
				query: Type.String({ description: "Search query (be specific for better results)" }),
				numResults: Type.Optional(Type.Number({ description: "Number of results (default 8, max 20)" })),
				type: Type.Optional(
					Type.String({ description: '"auto" (default), "neural" (semantic), or "keyword" (exact match)' }),
				),
			}),

			async execute(
				_toolCallId: string,
				params: { query: string; numResults?: number; type?: string },
				signal: AbortSignal,
			) {
				try {
					const result = await callExaMCP(
						"web_search_exa",
						{
							query: params.query,
							numResults: Math.min(params.numResults ?? 8, 20),
							type: params.type ?? "auto",
							livecrawl: "fallback",
							textContentsOptions: { maxCharacters: 3000 },
						},
						signal,
						25_000,
					);
					return { content: [{ type: "text" as const, text: truncateExaResults(result) }], details: {} };
				} catch (err) {
					const msg = errorMessage(err);
					return { content: [{ type: "text" as const, text: `Web search failed: ${msg}` }], details: {} };
				}
			},
		});

	// -----------------------------------------------------------------------
	// Tool 3: codesearch — Technical doc/example search via Exa AI web search
	// -----------------------------------------------------------------------

	if (!disabled.has("codesearch"))
		pi.registerTool({
			name: "codesearch",
			label: "Code Search",
			description:
				"Search for programming documentation, code examples, and API references using Exa AI. Tuned for technical queries and implemented on top of Exa web search because the public MCP endpoint does not currently expose a dedicated code-search tool. No API key required.",
			promptSnippet: "Search technical docs and API references via Exa AI.",

			parameters: Type.Object({
				query: Type.String({
					description: 'Code/API query (e.g. "React useState hook examples", "Go context.WithCancel usage")',
				}),
				numResults: Type.Optional(Type.Number({ description: "Number of results (default 5, max 10)" })),
			}),

			async execute(_toolCallId: string, params: { query: string; numResults?: number }, signal: AbortSignal) {
				try {
					const result = await callExaMCP(
						"web_search_exa",
						{
							query: `programming documentation, API reference, code examples, official docs, GitHub examples for: ${params.query}`,
							numResults: Math.min(params.numResults ?? 5, 10),
						},
						signal,
						30_000,
					);
					return {
						content: [{ type: "text" as const, text: truncateExaResults(result) }],
						details: { backend: "web_search_exa" },
					};
				} catch (err) {
					const msg = errorMessage(err);
					return {
						content: [{ type: "text" as const, text: `Code search failed: ${msg}` }],
						details: { backend: "web_search_exa" },
					};
				}
			},
		});

	// -----------------------------------------------------------------------
	// Tool 4: context7 — Documentation lookup
	// -----------------------------------------------------------------------

	if (!disabled.has("context7"))
		pi.registerTool({
			name: "context7",
			label: "Context7",
			description: `Context7 documentation lookup: resolve library IDs and query docs.

Operations:
- "resolve": Find library ID from name (e.g., "react" → "/reactjs/react.dev")
- "query": Get documentation for a library topic

Example:
context7({ operation: "resolve", libraryName: "react" })
context7({ operation: "query", libraryId: "/reactjs/react.dev", topic: "hooks" })`,
			promptSnippet: "Library documentation lookup — resolve library IDs and query docs.",

			parameters: Type.Object({
				operation: Type.Optional(
					Type.Union([Type.Literal("resolve"), Type.Literal("query")], {
						description: 'Operation to perform (default: "resolve")',
					}),
				),
				libraryName: Type.Optional(Type.String({ description: "Library name to resolve (for resolve operation)" })),
				libraryId: Type.Optional(Type.String({ description: "Library ID from resolve (for query operation)" })),
				topic: Type.Optional(Type.String({ description: "Documentation topic (for query operation)" })),
				offset: Type.Optional(
					Type.Number({ description: "Character offset to start reading from (for paginating long docs)", minimum: 0 }),
				),
			}),

			async execute(
				_toolCallId: string,
				params: {
					operation?: "resolve" | "query";
					libraryName?: string;
					libraryId?: string;
					topic?: string;
					offset?: number;
				},
				signal: AbortSignal,
			) {
				const operation = params.operation ?? "resolve";
				const apiKey = process.env.CONTEXT7_API_KEY;
				const headers: Record<string, string> = {
					Accept: "application/json",
					"User-Agent": USER_AGENT,
				};

				if (apiKey) {
					headers.Authorization = `Bearer ${apiKey}`;
				}

				if (operation === "resolve") {
					const { libraryName } = params;

					if (!libraryName?.trim()) {
						return {
							content: [
								{
									type: "text" as const,
									text: "Error: libraryName is required for resolve operation",
								},
							],
							details: { operation: "resolve", error: "libraryName required" },
						};
					}

					try {
						const url = new URL(`${CONTEXT7_API}/libs/search`);
						url.searchParams.set("libraryName", libraryName);
						url.searchParams.set("query", "documentation");

						const response = await fetch(url.toString(), { headers, signal });

						if (!response.ok) {
							return context7HttpError(response.status, "resolve");
						}

						const data = (await response.json()) as Context7SearchResponse;
						const libraries = data.results || [];

						if (libraries.length === 0) {
							return {
								content: [
									{
										type: "text" as const,
										text: `No libraries found matching: ${libraryName}\n\nTry:\n- Different library name\n- Check spelling\n- Use official package name`,
									},
								],
								details: { operation: "resolve", query: libraryName, results: 0 },
							};
						}

						const formatted = libraries
							.slice(0, 5)
							.map((lib, i) => {
								const desc = lib.description ? `\n   ${lib.description.slice(0, 100)}...` : "";
								const snippets = lib.totalSnippets ? ` (${lib.totalSnippets} snippets)` : "";
								const score = lib.benchmarkScore ? ` [score: ${lib.benchmarkScore}]` : "";
								return `${i + 1}. **${lib.title}** → \`${lib.id}\`${snippets}${score}${desc}`;
							})
							.join("\n\n");

						return {
							content: [
								{
									type: "text" as const,
									text: `Found ${libraries.length} libraries matching "${libraryName}":\n\n${formatted}\n\n**Next step**: Use \`context7({ operation: "query", libraryId: "${libraries[0].id}", topic: "your topic" })\` to fetch documentation.`,
								},
							],
							details: {
								operation: "resolve",
								query: libraryName,
								results: libraries.length,
								topResult: libraries[0].id,
							},
						};
					} catch (error: unknown) {
						if (error instanceof DOMException && error.name === "AbortError") {
							return {
								content: [{ type: "text" as const, text: "Request cancelled." }],
								details: { operation: "resolve", error: "cancelled" },
							};
						}
						const message = errorMessage(error);
						return {
							content: [{ type: "text" as const, text: `Error resolving library: ${message}` }],
							details: { operation: "resolve", error: message },
						};
					}
				}

				const { libraryId, topic } = params;

				if (!libraryId?.trim()) {
					return {
						content: [
							{
								type: "text" as const,
								text: 'Error: libraryId is required (use operation: "resolve" first)',
							},
						],
						details: { operation: "query", error: "libraryId required" },
					};
				}

				if (!topic?.trim()) {
					return {
						content: [
							{
								type: "text" as const,
								text: "Error: topic is required (e.g., 'hooks', 'setup', 'API reference')",
							},
						],
						details: { operation: "query", error: "topic required" },
					};
				}

				try {
					const url = new URL(`${CONTEXT7_API}/context`);
					url.searchParams.set("libraryId", libraryId);
					url.searchParams.set("query", topic);

					const response = await fetch(url.toString(), {
						headers: { ...headers, Accept: "text/plain" },
						signal,
					});

					if (!response.ok) {
						return context7HttpError(response.status, "query", libraryId);
					}

					const content = await response.text();

					if (!content.trim()) {
						return {
							content: [
								{
									type: "text" as const,
									text: `No documentation found for "${topic}" in ${libraryId}.\n\nTry:\n- Simpler terms (e.g., "useState" instead of "state management")\n- Different topic spelling\n- Broader topics like "API reference" or "getting started"`,
								},
							],
							details: { operation: "query", libraryId, topic, results: 0 },
						};
					}

					const text = paginateText(
						content,
						params.offset ?? 0,
						MAX_PAGE_CHARS,
						`# Documentation: ${topic} (${libraryId})\n\n`,
					);

					return {
						content: [
							{
								type: "text" as const,
								text,
							},
						],
						details: { operation: "query", libraryId, topic, length: content.length, offset: params.offset ?? 0 },
					};
				} catch (error: unknown) {
					if (error instanceof DOMException && error.name === "AbortError") {
						return {
							content: [{ type: "text" as const, text: "Request cancelled." }],
							details: { operation: "query", error: "cancelled" },
						};
					}
					const message = errorMessage(error);
					return {
						content: [{ type: "text" as const, text: `Error querying documentation: ${message}` }],
						details: { operation: "query", error: message },
					};
				}
			},
		});

	// -----------------------------------------------------------------------
	// Tool 5: web_fetch — Fetch full page content via Exa
	// -----------------------------------------------------------------------

	if (!disabled.has("web_fetch"))
		pi.registerTool({
			name: "web_fetch",
			label: "Web Fetch",
			description: `Fetch a webpage's content as clean markdown via Exa.

Use after websearch/codesearch when you need the full content of a specific result.
Supports any public URL. Output is truncated to ~10k characters. Use offset to paginate long pages.

Example:
  web_fetch({ url: "https://example.com/article" })
  web_fetch({ url: "https://example.com/article", offset: 20000 })`,
			promptSnippet: "Fetch full webpage content as markdown. Use after websearch to read a specific result.",

			parameters: Type.Object({
				url: Type.String({ description: "The URL to fetch content from" }),
				offset: Type.Optional(
					Type.Number({
						description: "Character offset to start reading from (for paginating long pages)",
						minimum: 0,
					}),
				),
			}),

			async execute(_toolCallId: string, params: { url: string; offset?: number }, signal: AbortSignal) {
				const { url } = params;
				if (!url?.trim()) {
					return {
						content: [{ type: "text" as const, text: "Error: url is required" }],
					};
				}

				try {
					const result = await callExaMCP("web_fetch_exa", { urls: [url] }, signal, 30_000);
					const text = paginateText(result, params.offset ?? 0, MAX_PAGE_CHARS);
					return { content: [{ type: "text" as const, text }] };
				} catch (err) {
					const msg = errorMessage(err);
					return {
						content: [{ type: "text" as const, text: `Fetch failed: ${msg}` }],
					};
				}
			},
		});
}
