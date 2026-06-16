/**
 * pi-search — Web search, code search, GitHub grep, and docs lookup for pi.
 *
 * @module pi-search
 * @see https://github.com/buddingnewinsights/pi-search
 *
 * Tools:

 *   • websearch  — Real-time web search via Exa AI (no API key)
 *   • codesearch — Technical doc/example search via Exa AI web search (no API key)
 *   • context7   — Resolve library IDs and query official documentation
 *   • deepwiki   — Query DeepWiki's public GitHub repository documentation
 *
 * Architecture:
 *   Single extension entry point registers all tools.
 * Context7 and DeepWiki use JSON-RPC 2.0 MCP. Exa uses JSON-RPC 2.0 MCP over HTTP/SSE.
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

const TOOL_NAMES = ["websearch", "codesearch", "context7", "deepwiki", "web_fetch"] as const;
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

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const DEEPWIKI_MCP_URL = "https://mcp.deepwiki.com/mcp";
const CONTEXT7_API = "https://context7.com/api/v2";
const USER_AGENT = "pi-search/1.0";

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

interface Citation {
	id: string;
	title?: string;
	url: string;
	source: "exa" | "context7";
	snippet?: string;
}

interface ExaMCPResult {
	text: string;
	citations: Citation[];
}

type DeepWikiOperation = "structure" | "contents" | "ask";
type DeepWikiToolName = "read_wiki_structure" | "read_wiki_contents" | "ask_question";

// ===========================================================================
// Shared: MCP response parsing
// ===========================================================================

function parseMcpMessages(text: string, contentType: string): Record<string, unknown>[] {
	const parsed =
		contentType.includes("application/json") || text.trimStart().startsWith("{")
			? [JSON.parse(text)]
			: text
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim())
					.filter(Boolean)
					.map((line) => JSON.parse(line));

	return parsed.filter(isRecord);
}

function textFromMcpContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(item): item is { type: string; text: string } =>
				isRecord(item) && item.type === "text" && typeof item.text === "string",
		)
		.map((item) => item.text)
		.join("\n");
}

// ===========================================================================
// Shared: Exa MCP caller (JSON-RPC 2.0 over HTTP/SSE)
// ===========================================================================

async function callExaMCP(
	toolName: string,
	args: Record<string, unknown>,
	signal: AbortSignal,
	timeoutMs = 30_000,
): Promise<ExaMCPResult> {
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
		const messages = parseMcpMessages(text, response.headers.get("content-type") ?? "");

		for (const message of messages) {
			const result = message.result;
			if (isRecord(result) && result.content) {
				return exaResultFromContent(result.content);
			}
			const error = message.error;
			if (isRecord(error)) {
				throw new Error(`Exa error: ${error.message ?? JSON.stringify(error)}`);
			}
		}

		const fallbackText = text.slice(0, 5000);
		return { text: fallbackText, citations: extractCitationsFromText(fallbackText) };
	} finally {
		clearTimeout(timer);
	}
}

function exaResultFromContent(content: unknown): ExaMCPResult {
	if (!Array.isArray(content)) {
		throw new Error(`Unsupported Exa content format: expected array, received ${typeof content}`);
	}

	const text = textFromMcpContent(content);
	const structuredCitations = extractCitationsFromUnknown(content);
	const fallbackCitations = extractCitationsFromText(text);
	return { text, citations: mergeCitations([...structuredCitations, ...fallbackCitations]) };
}

// ===========================================================================
// Shared: DeepWiki MCP caller (Streamable HTTP)
// ===========================================================================

async function callDeepWikiMCP(toolName: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
	const body = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name: toolName, arguments: args },
	});

	const response = await fetch(DEEPWIKI_MCP_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"User-Agent": USER_AGENT,
		},
		body,
		signal,
	});

	if (!response.ok) {
		throw new Error(`DeepWiki MCP returned ${response.status}: ${response.statusText}`);
	}

	const text = await response.text();
	const messages = parseMcpMessages(text, response.headers.get("content-type") ?? "");

	for (const message of messages) {
		const result = message.result;
		if (isRecord(result) && isRecord(result.structuredContent)) {
			const structuredResult = result.structuredContent.result;
			if (typeof structuredResult === "string") return structuredResult;
		}
		if (isRecord(result) && result.content) {
			const contentResult = textFromMcpContent(result.content);
			if (contentResult.trim()) return contentResult;
		}
		const error = message.error;
		if (isRecord(error)) {
			throw new Error(`DeepWiki error: ${error.message ?? JSON.stringify(error)}`);
		}
	}

	return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function extractCitationsFromUnknown(value: unknown): Citation[] {
	const citations: Citation[] = [];
	const seenObjects = new WeakSet<object>();

	function visit(node: unknown) {
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}

		if (!isRecord(node)) return;
		if (seenObjects.has(node)) return;
		seenObjects.add(node);

		const url = stringField(node, ["url", "link"]);
		if (url && isHttpUrl(url)) {
			const title = stringField(node, ["title", "name"]);
			const snippet = stringField(node, ["snippet", "text", "highlight", "summary"]);
			citations.push(makeCitation(citations.length + 1, url, title, snippet));
		}

		for (const child of Object.values(node)) visit(child);
	}

	visit(value);
	return mergeCitations(citations);
}

function extractCitationsFromText(text: string): Citation[] {
	const blocks = text.split("\n---\n");
	const citations: Citation[] = [];
	for (const block of blocks) {
		const url = matchField(block, "URL") ?? matchFirstHttpUrl(block);
		if (!url || !isHttpUrl(url)) continue;
		const title = matchField(block, "Title") ?? firstNonEmptyLine(block);
		const snippet = matchHighlights(block) ?? undefined;
		citations.push(makeCitation(citations.length + 1, url, title, snippet));
	}
	return mergeCitations(citations);
}

function makeCitation(index: number, url: string, title?: string, snippet?: string): Citation {
	return {
		id: `exa-${index}`,
		title: title?.trim() || undefined,
		url,
		source: "exa",
		snippet: snippet?.trim().slice(0, MAX_HIGHLIGHTS_CHARS) || undefined,
	};
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function matchField(text: string, field: string): string | undefined {
	const match = text.match(new RegExp(`^${field}:\\s*(.+)$`, "im"));
	return match?.[1]?.trim();
}

function matchHighlights(text: string): string | undefined {
	const idx = text.indexOf("Highlights:\n");
	if (idx === -1) return undefined;
	return text.slice(idx + "Highlights:\n".length).trim();
}

function matchFirstHttpUrl(text: string): string | undefined {
	return text.match(/https?:\/\/[^\s)]+/)?.[0];
}

function firstNonEmptyLine(text: string): string | undefined {
	return text
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean);
}

function isHttpUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function mergeCitations(citations: Citation[]): Citation[] {
	const byUrl = new Map<string, Citation>();
	for (const citation of citations) {
		const existing = byUrl.get(citation.url);
		if (!existing) {
			byUrl.set(citation.url, citation);
			continue;
		}
		byUrl.set(citation.url, {
			...existing,
			title: existing.title ?? citation.title,
			snippet: existing.snippet ?? citation.snippet,
		});
	}
	return [...byUrl.values()].map((citation, index) => ({ ...citation, id: `exa-${index + 1}` }));
}

function formatCitationMarkers(text: string, citations: Citation[]): string {
	if (citations.length === 0) return text;
	const lines = citations.map(
		(citation, index) => `[${index + 1}] ${citation.title ?? citation.url}\nURL: ${citation.url}`,
	);
	return `${text}\n\n## Sources\n${lines.join("\n\n")}`;
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
					const citations = result.citations;
					return {
						content: [
							{ type: "text" as const, text: formatCitationMarkers(truncateExaResults(result.text), citations) },
						],
						details: { citations },
					};
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
					const citations = result.citations;
					return {
						content: [
							{ type: "text" as const, text: formatCitationMarkers(truncateExaResults(result.text), citations) },
						],
						details: { backend: "web_search_exa", citations },
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
	// Tool 5: deepwiki — Public GitHub repository docs via DeepWiki MCP
	// -----------------------------------------------------------------------

	if (!disabled.has("deepwiki"))
		pi.registerTool({
			name: "deepwiki",
			label: "DeepWiki",
			description: `Query DeepWiki's public GitHub repository documentation via the official DeepWiki MCP server.

Use when:
- You need a repository-specific documentation overview
- You want to ask questions about a public GitHub repo
- You need generated docs for unfamiliar open-source codebases

Operations:
- "structure" — list documentation topics for a repo
- "contents" — read generated documentation for a repo
- "ask" — ask a repo-grounded question

Limitations: public GitHub repositories only; generated docs may be incomplete or stale. Use the repository source for exact code truth.

Examples:
  deepwiki({ operation: "structure", repo: "facebook/react" })
  deepwiki({ operation: "contents", repo: "facebook/react" })
  deepwiki({ operation: "ask", repo: "facebook/react", question: "How does reconciliation work?" })`,
			promptSnippet: "Query DeepWiki's public GitHub repository documentation and Q&A.",

			parameters: Type.Object({
				operation: Type.Optional(
					Type.Union([Type.Literal("structure"), Type.Literal("contents"), Type.Literal("ask")], {
						description: 'Operation to perform (default: "ask" when question is provided, otherwise "contents")',
					}),
				),
				repo: Type.String({ description: 'GitHub repository in "owner/name" format' }),
				question: Type.Optional(Type.String({ description: 'Question to ask for operation: "ask"' })),
			}),

			async execute(
				_toolCallId: string,
				params: { operation?: DeepWikiOperation; repo: string; question?: string },
				signal: AbortSignal,
			) {
				const repo = params.repo?.trim();
				if (!repo) {
					return {
						content: [{ type: "text" as const, text: 'Error: repo is required in "owner/name" format' }],
						details: { error: "repo required" },
					};
				}

				if (!/^[^\s/]+\/[^\s/]+$/.test(repo)) {
					return {
						content: [
							{ type: "text" as const, text: 'Error: repo must be in "owner/name" format, e.g. "facebook/react"' },
						],
						details: { error: "invalid repo", repo },
					};
				}

				const operation = params.operation ?? (params.question?.trim() ? "ask" : "contents");
				let toolName: DeepWikiToolName;
				let args: Record<string, unknown>;

				if (operation === "structure") {
					toolName = "read_wiki_structure";
					args = { repoName: repo };
				} else if (operation === "contents") {
					toolName = "read_wiki_contents";
					args = { repoName: repo };
				} else {
					const question = params.question?.trim();
					if (!question) {
						return {
							content: [{ type: "text" as const, text: 'Error: question is required for operation: "ask"' }],
							details: { operation, repo, error: "question required" },
						};
					}
					toolName = "ask_question";
					args = { repoName: repo, question };
				}

				try {
					const text = await callDeepWikiMCP(toolName, args, signal);
					return {
						content: [
							{ type: "text" as const, text: paginateText(text, 0, MAX_PAGE_CHARS, `# DeepWiki: ${repo}\n\n`) },
						],
						details: { operation, repo, backend: "deepwiki_mcp", toolName },
					};
				} catch (err) {
					const msg = errorMessage(err);
					return {
						content: [{ type: "text" as const, text: `DeepWiki failed: ${msg}` }],
						details: { operation, repo, backend: "deepwiki_mcp", toolName, error: msg },
					};
				}
			},
		});

	// -----------------------------------------------------------------------
	// Tool 6: web_fetch — Fetch full page content via Exa
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
					const citations = mergeCitations([
						...result.citations,
						{ id: "exa-1", url, source: "exa" as const, title: matchField(result.text, "Title") },
					]);
					const text = paginateText(result.text, params.offset ?? 0, MAX_PAGE_CHARS);
					return {
						content: [{ type: "text" as const, text: formatCitationMarkers(text, citations) }],
						details: { citations },
					};
				} catch (err) {
					const msg = errorMessage(err);
					return {
						content: [{ type: "text" as const, text: `Fetch failed: ${msg}` }],
					};
				}
			},
		});
}
