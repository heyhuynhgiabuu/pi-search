import { describe, expect, it } from "vitest";
import { dedupeCitations, extractCitationsFromMcpText, formatCitationFooter } from "../src/tools/citations.js";

describe("citations", () => {
	describe("extractCitationsFromMcpText", () => {
		it("extracts Title/URL pairs", () => {
			const text = `Title: Hello
URL: https://example.com
Snippet: world

Title: World
URL: https://example.org
Snippet: again`;
			const out = extractCitationsFromMcpText(text, "exa");
			expect(out).toHaveLength(2);
			expect(out[0]).toMatchObject({ title: "Hello", url: "https://example.com", source: "exa", index: 1 });
			expect(out[1]).toMatchObject({ title: "World", url: "https://example.org", index: 2 });
		});

		it("skips Title lines without a nearby URL", () => {
			const text = `Title: Lonely`;
			expect(extractCitationsFromMcpText(text, "exa")).toEqual([]);
		});

		it("extracts bare URLs in nearby lines", () => {
			const text = `Title: Bare
Check this https://bare.example.com for more`;
			const out = extractCitationsFromMcpText(text, "exa");
			expect(out).toHaveLength(1);
			expect(out[0].url).toBe("https://bare.example.com");
		});
	});

	describe("dedupeCitations", () => {
		it("removes duplicate URLs and reindexes", () => {
			const out = dedupeCitations([
				{ index: 1, url: "https://a.com", title: "A", source: "exa" },
				{ index: 2, url: "https://a.com", title: "A2", source: "exa" },
				{ index: 3, url: "https://b.com", title: "B", source: "exa" },
			]);
			expect(out.map((c) => c.url)).toEqual(["https://a.com", "https://b.com"]);
			expect(out.map((c) => c.index)).toEqual([1, 2]);
		});
	});

	describe("formatCitationFooter", () => {
		it("renders an empty string for no citations", () => {
			expect(formatCitationFooter([])).toBe("");
		});

		it("renders a Sources section with markdown links", () => {
			const out = formatCitationFooter([{ index: 1, url: "https://a.com", title: "A", source: "exa" }]);
			expect(out).toContain("## Sources");
			expect(out).toContain("[1] [A](https://a.com)");
		});
	});
});
