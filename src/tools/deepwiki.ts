/**
 * deepwiki tool — asks questions about a public GitHub repository
 * using DeepWiki's documentation knowledge base.
 *
 * Uses the DeepWiki MCP server (https://mcp.deepwiki.com/mcp) via
 * JSON-RPC. No API key required.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { compile, nullable, obj, opt, str } from "@earendil-works/pi-schema";
import { resolveConfig } from "../config.js";
import { buildErrorResult, toPiSearchError, ValidationError } from "../errors.js";
import { renderDeepwikiResult, renderToolCall } from "./render.js";

const DEEPWIKI_ASK_TOOL = "ask_question";

const REPO_NAME_PATTERN = "^[\\w.-]+/[\\w.-]+$";

const deepwikiParameters = obj({
	repoName: str({
		description: "GitHub repo in 'owner/name' format, e.g. 'facebook/react' or 'vercel/next.js'.",
		pattern: REPO_NAME_PATTERN,
	}),
	question: str({ description: "Natural-language question about the repository." }),
});

const validateDeepwikiExecuteParams = compile(
	obj(
		{
			repoName: opt(nullable(str())),
			question: opt(nullable(str())),
		},
		{ open: true },
	),
);

const repoNamePatternValidator = compile(str({ pattern: REPO_NAME_PATTERN }));

export function createDeepwikiTool(_pi: ExtensionAPI): ToolDefinition {
	return {
		name: "deepwiki",
		label: "⚙ deepwiki",
		description:
			"Ask questions about any public GitHub repository. Powered by DeepWiki. Use repoName='owner/name' (e.g. 'facebook/react') and a natural-language question. Returns synthesized answer with citations to source files.",
		parameters: deepwikiParameters,
		async execute(_id, params, signal, onUpdate) {
			try {
				const config = resolveConfig();

				if (config.disabledTools.has("deepwiki")) {
					throw new ValidationError("deepwiki is disabled in config.");
				}

				const parsed = validateDeepwikiExecuteParams.validate(params);

				if (!parsed.ok) {
					const first = parsed.errors[0];
					throw new ValidationError(
						first ? `${first.path || "params"}: ${first.message}` : "Invalid deepwiki parameters.",
					);
				}

				const repoName = parsed.value.repoName?.trim() ?? "";
				const question = parsed.value.question?.trim() ?? "";

				if (!repoName) throw new ValidationError("repoName is required (e.g. 'facebook/react').");

				if (!question) throw new ValidationError("question is required.");

				if (!repoNamePatternValidator.check(repoName)) {
					const first = repoNamePatternValidator.errors(repoName)[0];
					throw new ValidationError(first ? `/repoName: ${first.message}` : "Invalid repoName.");
				}

				onUpdate?.({
					content: [{ type: "text", text: `DeepWiki: querying ${repoName}…` }],
					details: { phase: "querying", repoName },
				});

				const { createDefaultMcpClient } = await import("../mcp/client.js");
				const client = createDefaultMcpClient();

				const response = await client.invoke({
					server: "deepwiki",
					toolName: DEEPWIKI_ASK_TOOL,
					arguments: { repoName, question },
					options: { signal, timeoutMs: config.mcpTimeoutMs },
				});

				const text = response.content.map((c) => c.text).join("\n");

				return {
					content: [{ type: "text", text }],
					details: { provider: "deepwiki", repoName, question },
				};
			} catch (error) {
				return buildErrorResult(toPiSearchError(error));
			}
		},
		renderCall: renderToolCall("deepwiki"),
		renderResult: renderDeepwikiResult,
	};
}
