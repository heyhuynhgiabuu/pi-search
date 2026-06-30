import { describe, expect, it } from "vitest";
import { applyUrlRewrites, parseUrlRewriteRules } from "../../src/fetch/url-rewrites.js";

describe("url rewrites", () => {
	it("applies match/replace", () => {
		expect(applyUrlRewrites("https://old.com/x", [{ match: "old.com", replace: "new.com" }])).toBe("https://new.com/x");
	});

	it("parses rules from config shape", () => {
		expect(parseUrlRewriteRules([{ match: "a", replace: "b" }, { bad: true }])).toEqual([{ match: "a", replace: "b" }]);
	});
});
