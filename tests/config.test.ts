import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, resolveConfig, validateDisabledTools } from "../src/config.js";

let tempDir: string;

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-search-config-"));

	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, ORIGINAL_ENV);
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe("config", () => {
	describe("parseConfig", () => {
		it("accepts a valid object", () => {
			const result = parseConfig('{"exaApiKey": "abc", "disabledTools": ["websearch"]}');
			expect(result.exaApiKey).toBe("abc");
			expect(result.disabledTools).toEqual(["websearch"]);
		});

		it("treats apiKey as alias for exaApiKey", () => {
			const result = parseConfig('{"apiKey": "abc"}');
			expect(result.exaApiKey).toBe("abc");
		});

		it("throws ConfigError on invalid JSON", () => {
			expect(() => parseConfig("not json")).toThrowError(/Invalid JSON/);
		});

		it("throws ConfigError on non-object root", () => {
			expect(() => parseConfig("[]")).toThrowError(/JSON object/);
		});
	});

	describe("resolveConfig", () => {
		it("reads from env first", () => {
			process.env.EXA_API_KEY = "env-key";
			const config = resolveConfig({ env: process.env, homeDir: tempDir });
			expect(config.exaApiKey).toBe("env-key");
		});

		it("reads the Parallel key and provider from env", () => {
			process.env.PARALLEL_API_KEY = "pk";
			process.env.PI_SEARCH_PROVIDER = "Parallel";
			const config = resolveConfig({ env: process.env, homeDir: tempDir });
			expect(config.parallelApiKey).toBe("pk");
			expect(config.searchProvider).toBe("parallel");
		});

		it("rejects searchProvider=parallel without a key and unknown providers", () => {
			delete process.env.PARALLEL_API_KEY;
			process.env.PI_SEARCH_PROVIDER = "parallel";
			expect(() => resolveConfig({ env: process.env, homeDir: tempDir })).toThrow(/PARALLEL_API_KEY/);
			process.env.PI_SEARCH_PROVIDER = "bing";
			expect(() => resolveConfig({ env: process.env, homeDir: tempDir })).toThrow(/Unknown searchProvider/);
		});

		it("falls back to config file when env is empty", () => {
			delete process.env.EXA_API_KEY;
			const _configPath = join(tempDir, ".pi", "pi-search.json");
			// simulate by using configPath option
			const fileDir = join(tempDir, "user-home");
			const cfgPath = join(fileDir, ".pi", "pi-search.json");
			require("node:fs").mkdirSync(join(fileDir, ".pi"), { recursive: true });
			writeFileSync(cfgPath, JSON.stringify({ exaApiKey: "file-key" }));
			const config = resolveConfig({ env: process.env, homeDir: fileDir });
			expect(config.exaApiKey).toBe("file-key");
		});

		it("collects disabledTools from env, file, and args (deduped lowercased)", () => {
			process.env.PI_SEARCH_DISABLED_TOOLS = "websearch, codesearch";
			const fileDir = join(tempDir, "u");
			require("node:fs").mkdirSync(join(fileDir, ".pi"), { recursive: true });
			writeFileSync(join(fileDir, ".pi", "pi-search.json"), JSON.stringify({ disabledTools: ["CONTEXT7"] }));

			const config = resolveConfig({
				env: process.env,
				homeDir: fileDir,
				disabledToolsFromArgs: ["deepwiki"],
			});

			expect([...config.disabledTools].sort()).toEqual(["codesearch", "context7", "deepwiki", "websearch"]);
		});

		it("reads firecrawlApiKey from env", () => {
			process.env.FIRECRAWL_API_KEY = "fc-env-key";
			const config = resolveConfig({ env: process.env, homeDir: tempDir });
			expect(config.firecrawlApiKey).toBe("fc-env-key");
		});

		it("falls back to config file for firecrawlApiKey", () => {
			delete process.env.FIRECRAWL_API_KEY;
			const fileDir = join(tempDir, "fc-home");
			require("node:fs").mkdirSync(join(fileDir, ".pi"), { recursive: true });
			writeFileSync(join(fileDir, ".pi", "pi-search.json"), JSON.stringify({ firecrawlApiKey: "fc-file-key" }));
			const config = resolveConfig({ env: process.env, homeDir: fileDir });
			expect(config.firecrawlApiKey).toBe("fc-file-key");
		});

		it("firecrawlApiKey is undefined when not set", () => {
			delete process.env.FIRECRAWL_API_KEY;
			const config = resolveConfig({ env: process.env, homeDir: tempDir });
			expect(config.firecrawlApiKey).toBeUndefined();
		});

		it("useRestForExa defaults to false", () => {
			delete process.env.PI_SEARCH_USE_REST;
			const config = resolveConfig({ env: process.env, homeDir: tempDir });
			expect(config.useRestForExa).toBe(false);
		});

		it("PI_SEARCH_USE_REST=true enables direct REST", () => {
			process.env.PI_SEARCH_USE_REST = "TRUE";
			const config = resolveConfig({ env: process.env, homeDir: tempDir });
			expect(config.useRestForExa).toBe(true);
		});

		it("parses ssrf.allowRanges from config file", () => {
			const piDir = join(tempDir, ".pi");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(
				join(piDir, "pi-search.json"),
				JSON.stringify({ ssrf: { allowRanges: ["198.18.0.0/15", "0.0.0.0/0"] } }),
			);
			const config = resolveConfig({ env: process.env, homeDir: tempDir });
			expect(config.ssrf.allowRanges).toEqual(["198.18.0.0/15"]);
		});

		it("tolerates null-valued fields in config file", () => {
			delete process.env.EXA_API_KEY;
			delete process.env.PARALLEL_API_KEY;
			delete process.env.PI_SEARCH_PROVIDER;
			const piDir = join(tempDir, ".pi");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(
				join(piDir, "pi-search.json"),
				JSON.stringify({
					exaApiKey: null,
					parallelApiKey: null,
					searchProvider: null,
					braveApiKey: null,
					firecrawlApiKey: null,
					apiKey: null,
					disabledTools: null,
					useRestForExa: null,
					mcpTimeoutMs: null,
					ssrf: null,
					githubToken: null,
					urlRewrites: null,
				}),
			);

			const config = resolveConfig({ env: process.env, homeDir: tempDir });
			expect(config.exaApiKey).toBeUndefined();
			expect(config.searchProvider).toBeUndefined();
			expect(config.mcpTimeoutMs).toBe(30_000);
			expect(config.useRestForExa).toBe(false);
			expect(config.ssrf.allowRanges).toEqual([]);
			expect(config.urlRewrites).toEqual([]);
		});

		it("skips partial or malformed entries in urlRewrites and ssrf.allowRanges", () => {
			const piDir = join(tempDir, ".pi");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(
				join(piDir, "pi-search.json"),
				JSON.stringify({
					urlRewrites: [{ match: "a.example", replace: "b.example" }, { bad: true }, null, 42],
					ssrf: { allowRanges: [123, null, "198.18.0.0/15", "not-a-cidr"] },
				}),
			);

			const config = resolveConfig({ env: process.env, homeDir: tempDir });
			expect(config.urlRewrites).toEqual([{ match: "a.example", replace: "b.example" }]);
			expect(config.ssrf.allowRanges).toEqual(["198.18.0.0/15"]);
		});

		it("allows env PI_SEARCH_PROVIDER to override an invalid file searchProvider", () => {
			const piDir = join(tempDir, ".pi");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(join(piDir, "pi-search.json"), JSON.stringify({ searchProvider: 123 }));
			process.env.PI_SEARCH_PROVIDER = "exa";

			const config = resolveConfig({ env: process.env, homeDir: tempDir });
			expect(config.searchProvider).toBe("exa");
		});

		it("throws when effective file searchProvider is a truthy non-string", () => {
			const piDir = join(tempDir, ".pi");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(join(piDir, "pi-search.json"), JSON.stringify({ searchProvider: 123 }));
			delete process.env.PI_SEARCH_PROVIDER;

			expect(() => resolveConfig({ env: process.env, homeDir: tempDir })).toThrow(
				"searchProvider must be a string ('exa' or 'parallel').",
			);
		});
	});

	describe("validateDisabledTools", () => {
		it("passes when all disabled are known", () => {
			expect(() => validateDisabledTools(new Set(["websearch"]), ["websearch", "codesearch"])).not.toThrow();
		});

		it("throws ConfigError on unknown names", () => {
			expect(() => validateDisabledTools(new Set(["websearch", "bogus"]), ["websearch"])).toThrowError(/Unknown tool/);
		});
	});
});
