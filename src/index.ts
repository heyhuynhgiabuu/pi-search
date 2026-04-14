/**
 * pi-search — Web search, code search, and GitHub grep for pi.
 *
 * @module pi-search
 * @see https://github.com/buddingnewinsights/pi-search
 *
 * Tools:
 *   • grepsearch — Search real-world code on GitHub via grep.app
 *   • websearch  — Real-time web search via Exa AI (no API key)
 *   • codesearch — Code-specific doc/example search via Exa AI (no API key)
 *
 * Architecture:
 *   Single extension entry point registers all three tools.
 *   grep.app uses plain REST. Exa uses JSON-RPC 2.0 over SSE.
 *   Zero runtime dependencies beyond @sinclair/typebox for param schemas.
 */

import { Type } from "@sinclair/typebox";

// ===========================================================================
// Constants
// ===========================================================================

const GREP_APP_API = "https://grep.app/api/search";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
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
// Extension entry point
// ===========================================================================

export default function piSearchExtension(pi: { registerTool: (tool: Record<string, unknown>) => void }): void {
	// -----------------------------------------------------------------------
	// Tool 1: grepsearch — GitHub code search via grep.app
	// -----------------------------------------------------------------------

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
			_signal: AbortSignal,
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
				const message = error instanceof Error ? error.message : String(error);
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
				return { content: [{ type: "text" as const, text: result }], details: {} };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text" as const, text: `Web search failed: ${msg}` }], details: {} };
			}
		},
	});

	// -----------------------------------------------------------------------
	// Tool 3: codesearch — Code-specific search via Exa AI
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "codesearch",
		label: "Code Search",
		description:
			"Search for programming documentation, code examples, and API references using Exa AI's code-specific index. Better than web search for technical queries. No API key required.",
		promptSnippet: "Search code-specific docs and API references via Exa AI.",

		parameters: Type.Object({
			query: Type.String({
				description: 'Code/API query (e.g. "React useState hook examples", "Go context.WithCancel usage")',
			}),
			numResults: Type.Optional(Type.Number({ description: "Number of results (default 5, max 10)" })),
		}),

		async execute(_toolCallId: string, params: { query: string; numResults?: number }, signal: AbortSignal) {
			try {
				const result = await callExaMCP(
					"get_code_context_exa",
					{ query: params.query, numResults: Math.min(params.numResults ?? 5, 10) },
					signal,
					30_000,
				);
				return { content: [{ type: "text" as const, text: result }], details: {} };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Code search failed: ${msg}` }],
					details: {},
				};
			}
		},
	});
}
