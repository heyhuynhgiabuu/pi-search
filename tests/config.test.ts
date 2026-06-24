import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
