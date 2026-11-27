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

import { arr, compile, lit, obj, str, unknown, unsafe } from "@earendil-works/pi-schema";
import { McpError } from "../errors.js";

const USER_AGENT = "pi-search/1.0";

export type McpServerName = "exa" | "deepwiki";

const MCP_URLS: Record<McpServerName, string> = {
	exa: "https://mcp.exa.ai/mcp",
	deepwiki: "https://mcp.deepwiki.com/mcp",
};

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

export type McpArgumentValue =
	| JsonPrimitive
	| undefined
	| readonly McpArgumentValue[]
	| { readonly [key: string]: McpArgumentValue };

export type McpToolArguments = Readonly<Record<string, McpArgumentValue>>;

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
		arguments: McpToolArguments;
		options?: McpInvokeOptions;
	}): Promise<McpCallResult>;
	close(): Promise<void>;
}

const JsonObjectSchema = unsafe<JsonObject>({ type: "object" });

const jsonObjectValidator = compile(JsonObjectSchema);

const McpTextContentSchema = obj({ type: lit("text"), text: str() }, { open: true });

const mcpTextContentValidator = compile(McpTextContentSchema);

const McpToolSchema = obj({ name: str() }, { open: true });

const mcpToolValidator = compile(McpToolSchema);

const McpListToolsMessageSchema = obj(
	{
		result: obj({ tools: arr(unknown()) }, { open: true }),
	},
	{ open: true },
);

const mcpListToolsMessageValidator = compile(McpListToolsMessageSchema);

const McpCallResultMessageSchema = obj(
	{
		result: obj({ content: unsafe<JsonValue>({}) }, { open: true }),
	},
	{ open: true },
);

const mcpCallResultMessageValidator = compile(McpCallResultMessageSchema);

const McpErrorMessageSchema = obj({ error: JsonObjectSchema }, { open: true });

const mcpErrorMessageValidator = compile(McpErrorMessageSchema);

const McpErrorWithMessageSchema = obj({ message: str() }, { open: true });

const mcpErrorWithMessageValidator = compile(McpErrorWithMessageSchema);

/** Parse MCP-over-HTTP responses: either `application/json` or SSE (`text/event-stream`). */
export function parseMcpMessages(text: string, contentType: string): JsonObject[] {
	const looksLikeJson = contentType.includes("application/json") || text.trimStart().startsWith("{");

	if (looksLikeJson) {
		try {
			const parsed: unknown = JSON.parse(text);

			return Array.isArray(parsed)
				? parsed.filter(jsonObjectValidator.check)
				: jsonObjectValidator.check(parsed)
					? [parsed]
					: [];
		} catch {
			return [];
		}
	}

	const out: JsonObject[] = [];

	for (const line of text.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();

		if (!payload) continue;

		try {
			const parsed: unknown = JSON.parse(payload);

			if (jsonObjectValidator.check(parsed)) out.push(parsed);
		} catch {
			// skip invalid JSON line
		}
	}

	return out;
}

export function textFromMcpContent(content: JsonValue): string {
	if (!Array.isArray(content)) return "";

	return content.flatMap((item) => (mcpTextContentValidator.check(item) ? [item.text] : [])).join("\n");
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
				if (!mcpListToolsMessageValidator.check(message)) continue;

				for (const tool of message.result.tools) {
					if (mcpToolValidator.check(tool)) names.push(tool.name);
				}
			}

			return names;
		} catch (error) {
			if (error instanceof McpError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			throw new McpError("mcp_unavailable", `Failed to list ${server} tools: ${message}`);
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
		arguments: McpToolArguments;
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
				if (mcpCallResultMessageValidator.check(message) && message.result.content) {
					return normalizeContent(message.result.content);
				}

				if (mcpErrorMessageValidator.check(message)) {
					const message_ = mcpErrorWithMessageValidator.check(message.error)
						? message.error.message
						: JSON.stringify(message.error);

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

			const message = error instanceof Error ? error.message : String(error);
			throw new McpError("mcp_error", `${server}/${toolName} failed: ${message}`);
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

function normalizeContent(content: JsonValue): McpCallResult {
	if (!Array.isArray(content)) {
		return { content: [{ type: "text", text: String(content) }] };
	}

	const out: McpCallResult = { content: [] };

	for (const item of content) {
		if (mcpTextContentValidator.check(item)) {
			out.content.push({ type: "text", text: item.text });
		}
	}

	return out;
}

export function createDefaultMcpClient(): McpClient {
	return new JsonRpcHttpMcpClient();
}
