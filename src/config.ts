/**
 * Configuration resolution for pi-search.
 *
 * Resolution order (highest priority first):
 *  1. process.env.EXA_API_KEY / process.env.PI_SEARCH_CONFIG_PATH
 *  2. ~/.pi/pi-search.json (or PI_SEARCH_CONFIG_PATH)
 *  3. defaults
 *
 * Mirrors the pi-exa-search config pattern with extension hook
 * for the disabledTools list and the REST/MCP selection.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readKetchBraveApiKey } from "./config/external-keys.js";
import { ConfigError } from "./errors.js";
import { parseSsrfAllowRanges } from "./fetch/ssrf.js";
import { parseUrlRewriteRules } from "./fetch/url-rewrites.js";
import type { ResolvedConfig } from "./types.js";

export const DEFAULT_CONFIG_PATH = join(homedir(), ".pi", "pi-search.json");

export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

type RawConfig = {
	exaApiKey?: string;
	braveApiKey?: string;
	firecrawlApiKey?: string;
	apiKey?: string; // alias
	disabledTools?: string[];
	useRestForExa?: boolean;
	mcpTimeoutMs?: number;
	ssrf?: {
		allowRanges?: string[];
	};
	githubToken?: string;
	urlRewrites?: Array<{ match: string; replace: string }>;
};

export type ReadConfigOptions = {
	configPath?: string;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
};

function normalizeRaw(raw: RawConfig): RawConfig {
	if (raw.apiKey && !raw.exaApiKey) {
		return { ...raw, exaApiKey: raw.apiKey };
	}
	return raw;
}

export function parseConfig(raw: string): RawConfig {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return normalizeRaw(parsed as RawConfig);
		}
		throw new ConfigError("Config root must be a JSON object.");
	} catch (error) {
		if (error instanceof ConfigError) throw error;
		throw new ConfigError("Invalid JSON in pi-search config file.");
	}
}

export function readConfig(options: ReadConfigOptions = {}): RawConfig {
	const configPath = options.configPath ?? join(options.homeDir ?? homedir(), ".pi", "pi-search.json");
	if (!existsSync(configPath)) return {};
	return parseConfig(readFileSync(configPath, "utf-8"));
}

export type ResolveConfigOptions = ReadConfigOptions & {
	disabledToolsFromArgs?: string[];
};

export function resolveConfig(options: ResolveConfigOptions = {}): ResolvedConfig {
	const env = options.env ?? process.env;
	const file = readConfig(options);
	const homeDir = options.homeDir ?? homedir();
	const fileDisabled = Array.isArray(file.disabledTools) ? file.disabledTools : [];
	const argDisabled = options.disabledToolsFromArgs ?? [];

	const exaApiKey = env.EXA_API_KEY || file.exaApiKey;
	const braveApiKey = env.BRAVE_API_KEY || file.braveApiKey || readKetchBraveApiKey(homeDir);
	const firecrawlApiKey = env.FIRECRAWL_API_KEY || file.firecrawlApiKey;
	const githubToken = env.GITHUB_TOKEN || env.GH_TOKEN || file.githubToken;
	const disabledTools = new Set<string>(
		[
			...(env.PI_SEARCH_DISABLED_TOOLS?.split(",")
				.map((s) => s.trim())
				.filter(Boolean) ?? []),
			...fileDisabled,
			...argDisabled,
		].map((s) => s.toLowerCase()),
	);

	const useRestForExa = (env.PI_SEARCH_USE_REST ?? (file.useRestForExa ? "true" : "false")).toLowerCase() === "true";
	const mcpTimeoutMs = Number.isFinite(file.mcpTimeoutMs) ? (file.mcpTimeoutMs as number) : DEFAULT_MCP_TIMEOUT_MS;

	const allowRanges = parseSsrfAllowRanges(file.ssrf?.allowRanges);

	return {
		exaApiKey,
		braveApiKey,
		firecrawlApiKey,
		githubToken,
		disabledTools,
		useRestForExa,
		mcpTimeoutMs,
		ssrf: { allowRanges },
		urlRewrites: parseUrlRewriteRules(file.urlRewrites),
	};
}

/** Throws ConfigError if any unknown tool names are disabled. */
export function validateDisabledTools(disabled: Set<string>, known: readonly string[]): void {
	const knownSet = new Set(known.map((s) => s.toLowerCase()));
	const unknown = [...disabled].filter((d) => !knownSet.has(d));
	if (unknown.length > 0) {
		throw new ConfigError(`Unknown tool(s) in disabledTools: ${unknown.join(", ")}. Known: ${known.join(", ")}.`);
	}
}
