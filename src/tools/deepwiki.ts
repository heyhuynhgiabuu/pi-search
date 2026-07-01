/**
 * deepwiki tool — asks questions about a public GitHub repository
 * using DeepWiki's documentation knowledge base.
 *
 * Uses the DeepWiki MCP server (https://mcp.deepwiki.com/mcp) via
 * JSON-RPC. No API key required.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolveConfig } from "../config.js";
import { buildErrorResult, toPiSearchError, ValidationError } from "../errors.js";
import { renderDeepwikiResult } from "./render.js";

const DEEPWIKI_ASK_TOOL = "ask_question";

export function createDeepwikiTool(_pi: ExtensionAPI) {
	return {
		name: "deepwiki",
		label: "DeepWiki",
		description:
			"Ask questions about any public GitHub repository. Powered by DeepWiki. Use repo='owner/name' (e.g. 'facebook/react') and a natural-language question. Returns synthesized answer with citations to source files.",
		parameters: Type.Object({
			repo: Type.String({
				description: "GitHub repo in 'owner/name' format, e.g. 'facebook/react' or 'vercel/next.js'.",
				pattern: "^[\\w.-]+/[\\w.-]+$",
			}),
			question: Type.String({ description: "Natural-language question about the repository." }),
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
				if (config.disabledTools.has("deepwiki")) {
					throw new ValidationError("deepwiki is disabled in config.");
				}

				const repo = (params.repo as string | undefined)?.trim();
				const question = (params.question as string | undefined)?.trim();
				if (!repo) throw new ValidationError("repo is required (e.g. 'facebook/react').");
				if (!question) throw new ValidationError("question is required.");

				onUpdate?.({
					content: [{ type: "text", text: `DeepWiki: querying ${repo}…` }],
					details: { phase: "querying", repo },
				});

				const { createDefaultMcpClient } = await import("../mcp/client.js");
				const client = createDefaultMcpClient();
				const response = await client.invoke({
					server: "deepwiki",
					toolName: DEEPWIKI_ASK_TOOL,
					arguments: { repo, question },
					options: { signal, timeoutMs: config.mcpTimeoutMs },
				});

				const text = response.content.map((c) => c.text).join("\n");
				return {
					content: [{ type: "text", text }],
					details: { provider: "deepwiki", repo, question },
				};
			} catch (error) {
				return buildErrorResult(toPiSearchError(error));
			}
		},
		renderResult: renderDeepwikiResult,
	};
}
