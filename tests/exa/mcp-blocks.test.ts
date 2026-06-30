import { describe, expect, it } from "vitest";
import { parseExaMcpTextToResults } from "../../src/exa/mcp-blocks.js";

describe("parseExaMcpTextToResults", () => {
	it("parses ketch-style blocks", () => {
		const raw = `Title: Example
URL: https://example.com
A short highlight line.

---

Title: Two
URL: https://two.test
Second snippet here.`;
		const results = parseExaMcpTextToResults(raw, 5);
		expect(results).toHaveLength(2);
		expect(results[0]?.url).toBe("https://example.com");
		expect(results[0]?.highlights[0]).toContain("highlight");
	});
});
