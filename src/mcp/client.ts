/**
 * MCP client wrapper using JSON-RPC 2.0 over HTTP/SSE.
 *
 * Pi-search talks to three MCP-compatible servers:
 *  - Exa (https://mcp.exa.ai/mcp)
 *  - DeepWiki (https://mcp.deepwiki.com/mcp)
 *  - Context7 (https://context7.com/api/v2 — REST, not JSON-RPC; handled in tools/context7.ts)
 *
 * The original monolithic index.ts used raw `fetch()` with hand-rolled
 * JSON-RPC envelopes and SSE parsing. This module centralizes that
 * logic behind a thin interface so it can be:
 *  - unit tested with a fake transport
 *  - swapped for a different transport later (e.g. stdio)
 *  - time-bounded and abortable
 *  - mapped onto coded errors (McpError)
 */

import { McpError } from "../errors.js";

const USER_AGENT = "pi-search/1.0";

export type McpServerName = "exa" | "deepwiki";

const MCP_URLS: Record<McpServerName, string> = {
	exa: "https://mcp.exa.ai/mcp",
	deepwiki: "https://mcp.deepwiki.com/mcp",
};

export type McpCallResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

export type McpInvokeOptions = {
	signal?: AbortSignal;
	timeoutMs?: number;
};

export interface McpClient {
	/** List tool names available on a given server. */
	listToolNames(server: McpServerName): Promise<string[]>;
	invoke(args: {
		server: McpServerName;
		toolName: string;
		arguments: Record<string, unknown>;
		options?: McpInvokeOptions;
	}): Promise<McpCallResult>;
	close(): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Parse MCP-over-HTTP responses: either `application/json` or SSE (`text/event-stream`). */
export function parseMcpMessages(text: string, contentType: string): Record<string, unknown>[] {
	const looksLikeJson = contentType.includes("application/json") || text.trimStart().startsWith("{");
	if (looksLikeJson) {
		try {
			const parsed: unknown = JSON.parse(text);
			return Array.isArray(parsed) ? parsed.filter(isRecord) : isRecord(parsed) ? [parsed] : [];
		} catch {
			return [];
		}
	}
	return text
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line) as unknown;
			} catch {
				return null;
			}
		})
		.filter((m): m is Record<string, unknown> => isRecord(m));
}

export function textFromMcpContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(item): item is { type: "text"; text: string } =>
				isRecord(item) && item.type === "text" && typeof item.text === "string",
		)
		.map((item) => item.text)
		.join("\n");
}

/** Default MCP client backed by Node's global fetch + JSON-RPC 2.0. */
export class JsonRpcHttpMcpClient implements McpClient {
	async listToolNames(server: McpServerName): Promise<string[]> {
		try {
			const body = JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/list",
				params: {},
			});
			const response = await fetch(MCP_URLS[server], {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"User-Agent": USER_AGENT,
				},
				body,
			});
			if (!response.ok) {
				throw new McpError("mcp_unavailable", `Failed to list ${server} tools: HTTP ${response.status}`);
			}
			const text = await response.text();
			const messages = parseMcpMessages(text, response.headers.get("content-type") ?? "");
			const names: string[] = [];
			for (const message of messages) {
				if (
					typeof message === "object" &&
					message !== null &&
					"result" in message &&
					typeof message.result === "object" &&
					message.result !== null &&
					"tools" in message.result &&
					Array.isArray((message.result as { tools?: unknown }).tools)
				) {
					for (const t of (message.result as { tools: Array<{ name?: unknown }> }).tools) {
						if (typeof t.name === "string") names.push(t.name);
					}
				}
			}
			return names;
		} catch (error) {
			if (error instanceof McpError) throw error;
			throw new McpError("mcp_unavailable", `Failed to list ${server} tools: ${(error as Error).message}`);
		}
	}

	async invoke({
		server,
		toolName,
		arguments: args,
		options,
	}: {
		server: McpServerName;
		toolName: string;
		arguments: Record<string, unknown>;
		options?: McpInvokeOptions;
	}): Promise<McpCallResult> {
		const timeoutMs = options?.timeoutMs ?? 30_000;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		if (options?.signal) {
			if (options.signal.aborted) controller.abort(options.signal.reason);
			else options.signal.addEventListener("abort", () => controller.abort(options.signal?.reason), { once: true });
		}

		try {
			const body = JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: toolName, arguments: args },
			});

			const response = await fetch(MCP_URLS[server], {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"User-Agent": USER_AGENT,
				},
				body,
				signal: controller.signal,
			});

			if (!response.ok) {
				const code = mapHttpStatusToCode(response.status);
				throw new McpError(code, `${server} MCP returned ${response.status}: ${response.statusText}`);
			}

			const text = await response.text();
			const messages = parseMcpMessages(text, response.headers.get("content-type") ?? "");

			for (const message of messages) {
				if (isRecord(message.result) && message.result.content) {
					return normalizeContent(message.result.content);
				}
				if (isRecord(message.error)) {
					const message_ =
						typeof message.error.message === "string" ? message.error.message : JSON.stringify(message.error);
					throw new McpError("mcp_error", `${server} error: ${message_}`);
				}
			}
			// Fallback: server returned plain text we couldn't parse as JSON-RPC
			return { content: [{ type: "text", text: text.slice(0, 5000) }] };
		} catch (error) {
			if (error instanceof McpError) throw error;
			if (controller.signal.aborted) {
				throw new McpError("mcp_timeout", `${server}/${toolName} timed out after ${timeoutMs}ms`);
			}
			throw new McpError("mcp_error", `${server}/${toolName} failed: ${(error as Error).message}`);
		} finally {
			clearTimeout(timer);
		}
	}

	async close(): Promise<void> {
		// No persistent connection for HTTP/SSE — nothing to close.
	}
}

function mapHttpStatusToCode(status: number): "mcp_error" | "mcp_timeout" | "mcp_unavailable" {
	if (status === 408) return "mcp_timeout";
	if (status === 502 || status === 503 || status === 504) return "mcp_unavailable";
	return "mcp_error";
}

function normalizeContent(content: unknown): McpCallResult {
	if (!Array.isArray(content)) {
		return { content: [{ type: "text", text: String(content) }] };
	}
	const out: McpCallResult = { content: [] };
	for (const item of content) {
		if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
			out.content.push({ type: "text", text: item.text });
		}
	}
	return out;
}

export function createDefaultMcpClient(): McpClient {
	return new JsonRpcHttpMcpClient();
}
