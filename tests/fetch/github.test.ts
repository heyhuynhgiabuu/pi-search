import { describe, expect, it } from "vitest";
import { parseGitHubUrl } from "../../src/fetch/github.js";

describe("parseGitHubUrl", () => {
	it("parses repo root", () => {
		expect(parseGitHubUrl(new URL("https://github.com/facebook/react"))).toEqual({
			kind: "repo",
			owner: "facebook",
			repo: "react",
		});
	});

	it("parses blob", () => {
		expect(parseGitHubUrl(new URL("https://github.com/o/r/blob/main/src/index.ts"))).toEqual({
			kind: "blob",
			owner: "o",
			repo: "r",
			ref: "main",
			path: "src/index.ts",
		});
	});

	it("returns null for non-GitHub", () => {
		expect(parseGitHubUrl(new URL("https://example.com"))).toBeNull();
	});
});
