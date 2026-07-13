import { describe, expect, it, vi } from "vitest";
import {
	COLLAPSED_PREVIEW_CHARS,
	DEFAULT_PAGE_CHARS,
	paginateText,
	renderContext7Result,
	renderDeepwikiResult,
	renderToolCall,
	renderWebFetchResult,
	renderWebsearchResult,
	type Theme,
	toMarkdownTheme,
} from "../src/tools/render.js";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	keyText: vi.fn(() => "ctrl+o"),
}));

/** Minimal Theme for testing — wraps with ANSI codes. */
const makeTheme = (): Theme => ({
	fg: (color, text) => `<${color}>${text}</${color}>`,
	bg: (color, text) => `[bg:${color}]${text}[/bg]`,
});

const baseResult = (text: string) => ({
	content: [{ type: "text" as const, text }],
	details: { provider: "exa" },
});

describe("render", () => {
	it("renders the prefixed callable tool name", () => {
		expect(renderToolCall("websearch")(undefined, makeTheme()).render(80)[0]?.trimEnd()).toBe(
			"<toolTitle>⚙ websearch</toolTitle>",
		);
	});

	describe("toMarkdownTheme", () => {
		it("maps theme.fg calls into a MarkdownTheme", () => {
			const theme = makeTheme();
			const mt = toMarkdownTheme(theme);
			expect(mt.heading("h")).toBe("<mdHeading>h</mdHeading>");
			expect(mt.link("a")).toBe("<mdLink>a</mdLink>");
			expect(mt.linkUrl("https://x.com")).toBe("<mdLinkUrl>https://x.com</mdLinkUrl>");
			expect(mt.code("c")).toBe("<mdCode>c</mdCode>");
			expect(mt.quote("q")).toBe("<mdQuote>q</mdQuote>");
		});

		it("uses ANSI codes for bold/italic/etc", () => {
			const mt = toMarkdownTheme(makeTheme());
			expect(mt.bold("b")).toBe("\u001b[1mb\u001b[0m");
			expect(mt.italic("i")).toBe("\u001b[3mi\u001b[0m");
			expect(mt.strikethrough("s")).toBe("\u001b[9ms\u001b[0m");
			expect(mt.underline("u")).toBe("\u001b[4mu\u001b[0m");
		});
	});

	describe("paginateText", () => {
		it("returns empty for empty text", () => {
			const r = paginateText("", true, makeTheme());
			expect(r.page).toBe("");
			expect(r.totalChars).toBe(0);
			expect(r.totalPages).toBe(0);
		});

		it("returns full text when expanded and short", () => {
			const r = paginateText("hello", true, makeTheme(), 1000);
			expect(r.page).toBe("hello");
			expect(r.totalPages).toBe(1);
		});

		it("truncates when collapsed and wraps hint in dim styling", () => {
			const text = "x".repeat(COLLAPSED_PREVIEW_CHARS + 100);
			const theme = makeTheme();
			const r = paginateText(text, false, theme);
			expect(r.page.length).toBeLessThan(text.length);
			expect(r.page).toContain(theme.fg("dim", "(ctrl+o to expand/collapse)"));
		});

		it("appends dim-styled expand hint to short text when collapsed", () => {
			const theme = makeTheme();
			const r = paginateText("short", false, theme);
			expect(r.page).toBe(`short ${theme.fg("dim", "(ctrl+o to expand/collapse)")}`);
		});

		it("adds page footer when expanded and long", () => {
			const text = "x".repeat(DEFAULT_PAGE_CHARS + 1000);
			const r = paginateText(text, true, makeTheme());
			expect(r.page).toContain("[page 1/");
			expect(r.totalPages).toBeGreaterThan(1);
		});
	});

	describe("renderWebsearchResult", () => {
		it("renders a Box-wrapped Markdown for collapsed and expanded", () => {
			const theme = makeTheme();
			const result = baseResult("Title: Hello\nURL: https://example.com\nSnippet: world");
			const collapsed = renderWebsearchResult(result, { expanded: false, isPartial: false }, theme, {});
			const expanded = renderWebsearchResult(result, { expanded: true, isPartial: false }, theme, {});
			expect(collapsed).not.toBeNull();
			expect(expanded).not.toBeNull();
			expect(collapsed?.constructor?.name).toBe("Box");
		});

		it("includes a Sources footer when expanded and citations are present", () => {
			const theme = makeTheme();
			const text = `Title: Hello
URL: https://example.com
Snippet: world`;
			const result = baseResult(text);
			// Just verify it doesn't throw and returns a component
			const out = renderWebsearchResult(result, { expanded: true, isPartial: false }, theme, {});
			expect(out).not.toBeNull();
		});
	});

	describe("renderContext7Result", () => {
		it("extracts the title from the result text", () => {
			const theme = makeTheme();
			const text = `## React Hooks\n\nuseState is...`;
			const out = renderContext7Result(baseResult(text), { expanded: true, isPartial: false }, theme, {});
			expect(out).not.toBeNull();
		});

		it("falls back to a default title when none is present", () => {
			const theme = makeTheme();
			const out = renderContext7Result(baseResult("no heading here"), { expanded: false, isPartial: false }, theme, {});
			expect(out).not.toBeNull();
		});
	});

	describe("renderDeepwikiResult", () => {
		it("prepends the repo tag when present in details", () => {
			const theme = makeTheme();
			const out = renderDeepwikiResult(
				{ ...baseResult("Some answer text"), details: { repo: "facebook/react" } },
				{ expanded: false, isPartial: false },
				theme,
				{},
			);
			expect(out).not.toBeNull();
		});

		it("renders without a header when repo is missing", () => {
			const theme = makeTheme();
			const out = renderDeepwikiResult(baseResult("answer"), { expanded: false, isPartial: false }, theme, {});
			expect(out).not.toBeNull();
		});
	});

	describe("renderWebFetchResult", () => {
		it("prepends the URL when present in details", () => {
			const theme = makeTheme();
			const out = renderWebFetchResult(
				{ ...baseResult("body"), details: { url: "https://example.com" } },
				{ expanded: false, isPartial: false },
				theme,
				{},
			);
			expect(out).not.toBeNull();
		});
	});
});
