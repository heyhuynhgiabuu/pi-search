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
import { bool, compile, nullable, num, obj, opt, type Static, str, unknown, unsafe } from "@earendil-works/pi-schema";
import { readKetchBraveApiKey } from "./config/external-keys.js";
import { ConfigError } from "./errors.js";
import { parseSsrfAllowRanges } from "./fetch/ssrf.js";
import { parseUrlRewriteRules, type UrlRewriteJsonValue } from "./fetch/url-rewrites.js";
import type { ResolvedConfig, SearchProvider } from "./types.js";

export const DEFAULT_CONFIG_PATH = join(homedir(), ".pi", "pi-search.json");

export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

const ConfigJsonValueSchema = unsafe<UrlRewriteJsonValue>(unknown());

const RawConfigSchema = obj(
	{
		exaApiKey: opt(nullable(str())),
		parallelApiKey: opt(nullable(str())),
		searchProvider: opt(ConfigJsonValueSchema),
		braveApiKey: opt(nullable(str())),
		firecrawlApiKey: opt(nullable(str())),
		apiKey: opt(nullable(str())),
		disabledTools: opt(ConfigJsonValueSchema),
		useRestForExa: opt(nullable(bool())),
		mcpTimeoutMs: opt(nullable(num())),
		ssrf: opt(ConfigJsonValueSchema),
		githubToken: opt(nullable(str())),
		urlRewrites: opt(ConfigJsonValueSchema),
	},
	{ open: true },
);

type RawConfig = Static<typeof RawConfigSchema>;

const rawConfigValidator = compile(RawConfigSchema);

const stringValidator = compile(str());

const ssrfSectionValidator = compile(obj({ allowRanges: opt(ConfigJsonValueSchema) }, { open: true }));

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
	let result: ReturnType<typeof rawConfigValidator.validate>;

	try {
		result = rawConfigValidator.validate(JSON.parse(raw));
	} catch {
		throw new ConfigError("Invalid JSON in pi-search config file.");
	}

	if (!result.ok) {
		const first = result.errors[0];

		if (first?.path === "" && first.keyword === "type") {
			throw new ConfigError("Config root must be a JSON object.");
		}

		throw new ConfigError(`Invalid pi-search config: ${first?.path || "/"} ${first?.message ?? "invalid value"}.`);
	}

	return normalizeRaw(result.value);
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
	const configPath = options.configPath ?? env.PI_SEARCH_CONFIG_PATH;
	const file = readConfig(configPath !== undefined ? { ...options, configPath } : options);
	const homeDir = options.homeDir ?? homedir();

	const fileDisabled = Array.isArray(file.disabledTools)
		? file.disabledTools.filter((item): item is string => stringValidator.check(item))
		: [];

	const argDisabled = options.disabledToolsFromArgs ?? [];

	const exaApiKey = env.EXA_API_KEY || (file.exaApiKey ?? undefined);
	const parallelApiKey = env.PARALLEL_API_KEY || (file.parallelApiKey ?? undefined);
	const searchProvider = parseSearchProvider(env.PI_SEARCH_PROVIDER || file.searchProvider);

	if (searchProvider === "parallel" && !parallelApiKey) {
		throw new ConfigError("searchProvider is 'parallel' but no PARALLEL_API_KEY or parallelApiKey is set.");
	}

	const braveApiKey = env.BRAVE_API_KEY || file.braveApiKey || readKetchBraveApiKey(homeDir);
	const firecrawlApiKey = env.FIRECRAWL_API_KEY || (file.firecrawlApiKey ?? undefined);
	const githubToken = env.GITHUB_TOKEN || env.GH_TOKEN || (file.githubToken ?? undefined);

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

	const mcpTimeoutMs =
		file.mcpTimeoutMs !== undefined && file.mcpTimeoutMs !== null && Number.isFinite(file.mcpTimeoutMs)
			? file.mcpTimeoutMs
			: DEFAULT_MCP_TIMEOUT_MS;

	const allowRanges = parseSsrfAllowRanges(ssrfSectionValidator.check(file.ssrf) ? file.ssrf.allowRanges : undefined);

	const resolved: ResolvedConfig = {
		exaApiKey,
		parallelApiKey,
		braveApiKey,
		firecrawlApiKey,
		githubToken,
		disabledTools,
		useRestForExa,
		mcpTimeoutMs,
		ssrf: { allowRanges },
		urlRewrites: parseUrlRewriteRules(file.urlRewrites),
	};

	if (searchProvider) {
		resolved.searchProvider = searchProvider;
	}

	return resolved;
}

function parseSearchProvider(value?: UrlRewriteJsonValue): SearchProvider | undefined {
	if (!value) return undefined;

	if (!stringValidator.check(value)) {
		throw new ConfigError("searchProvider must be a string ('exa' or 'parallel').");
	}

	const normalized = value.trim().toLowerCase();

	if (normalized === "exa" || normalized === "parallel") return normalized;
	throw new ConfigError(`Unknown searchProvider '${value}'. Use 'exa' or 'parallel'.`);
}

/** Throws ConfigError if any unknown tool names are disabled. */
export function validateDisabledTools(disabled: Set<string>, known: readonly string[]): void {
	const knownSet = new Set(known.map((s) => s.toLowerCase()));
	const unknown = [...disabled].filter((d) => !knownSet.has(d));

	if (unknown.length > 0) {
		throw new ConfigError(`Unknown tool(s) in disabledTools: ${unknown.join(", ")}. Known: ${known.join(", ")}.`);
	}
}
