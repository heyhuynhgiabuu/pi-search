/**
 * pi-search — research tools for the Pi coding agent.
 *
 * Five tools, two providers (REST + MCP), one config:
 *  - websearch: open-web search (REST, fallback to Exa MCP)
 *  - codesearch: code/library search (REST, fallback to Exa MCP)
 *  - context7:  up-to-date library docs
 *  - deepwiki:  ask questions about any public GitHub repo
 *  - web_fetch: extract full text from a URL
 *
 * Resolved at load time from:
 *  1. process.env (EXA_API_KEY, PI_SEARCH_DISABLED_TOOLS, PI_SEARCH_USE_REST, PI_SEARCH_CONFIG_PATH)
 *  2. ~/.pi/pi-search.json (configPath can be overridden by PI_SEARCH_CONFIG_PATH)
 *  3. defaults
 *
 * Unknown tool names in disabledTools are rejected via ConfigError.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveConfig, validateDisabledTools } from "./config.js";
import { type FetchSessionRestoreContext, restoreFetchContentFromSession } from "./fetch/content-store.js";
import { createCodesearchTool } from "./tools/codesearch.js";
import { createContext7Tool } from "./tools/context7.js";
import { createDeepwikiTool } from "./tools/deepwiki.js";
import { createGetFetchContentTool } from "./tools/get-fetch-content.js";
import { createWebFetchTool } from "./tools/webfetch.js";
import { createWebsearchTool } from "./tools/websearch.js";

export const TOOL_NAMES = [
	"websearch",
	"codesearch",
	"context7",
	"deepwiki",
	"web_fetch",
	"get_fetch_content",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export default function piSearchExtension(pi: ExtensionAPI): void {
	const config = resolveConfig();
	validateDisabledTools(config.disabledTools, TOOL_NAMES);

	const enabled = (name: ToolName): boolean => !config.disabledTools.has(name);

	if (enabled("websearch")) pi.registerTool(createWebsearchTool(pi, config) as never);
	if (enabled("codesearch")) pi.registerTool(createCodesearchTool(pi) as never);
	if (enabled("context7")) pi.registerTool(createContext7Tool(pi) as never);
	if (enabled("deepwiki")) pi.registerTool(createDeepwikiTool(pi) as never);
	if (enabled("web_fetch")) pi.registerTool(createWebFetchTool(pi, config) as never);
	if (enabled("get_fetch_content")) pi.registerTool(createGetFetchContentTool() as never);

	const hydrateFetchStore = async (_event: unknown, ctx: FetchSessionRestoreContext) => {
		restoreFetchContentFromSession(ctx);
	};
	pi.on("session_start", hydrateFetchStore);
	pi.on("session_tree", hydrateFetchStore);
}

export { resolveConfig, validateDisabledTools } from "./config.js";
export * from "./errors.js";
export { createExaRestClient, formatExaResult, normalizeExaResults } from "./exa/client.js";
export { normalizeExaParams } from "./exa/params.js";
export { createDefaultMcpClient, type McpClient } from "./mcp/client.js";
export { dedupeCitations, extractCitationsFromMcpText, formatCitationFooter } from "./tools/citations.js";
export * from "./types.js";
