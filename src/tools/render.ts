/**
 * TUI rendering for the 5 pi-search tools.
 *
 * Each tool's `renderResult` produces a `Markdown` widget that:
 *  - shows a concise summary by default
 *  - expands to the full result on demand (user toggles Ctrl+O)
 *  - paginates long outputs into readable chunks
 *  - colors citations, headings, and metadata per the host's theme
 *
 * Adapted from TUI work contributed via PR #1 by x4cc3 — the earendil
 * fork they used is not required; we use the mainline
 * `@earendil-works/pi-coding-agent` + `pi-tui` APIs and adapt between
 * `Theme` (pi-coding-agent) and `MarkdownTheme` (pi-tui) via
 * `toMarkdownTheme()` below.
 *
 * Pure functions over `result.content[0].text`; the tool's own text
 * output is the source of truth so this renderer can be swapped or
 * disabled without changing the tool's behavior.
 */

import type { Component } from "@earendil-works/pi-tui";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { dedupeCitations, extractCitationsFromMcpText } from "./citations.js";

// ---- Types ----------------------------------------------------------------

/** Subset of pi-coding-agent's Theme we use. */
export type Theme = {
	fg: (color: string, text: string) => string;
	bg: (color: string, text: string) => string;
};

/** Subset of pi-tui's MarkdownTheme we adapt to. */
type MarkdownTheme = {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
};

export type RenderOptions = {
	expanded: boolean;
	isPartial: boolean;
};

export type RenderHelpers = Record<string, never>;

export type RenderResult = (
	result: {
		content: Array<{ type: "text"; text: string }>;
		details?: Record<string, unknown>;
	},
	options: RenderOptions,
	theme: Theme,
	helpers: RenderHelpers,
) => Component | null;

// ---- Theme adapter --------------------------------------------------------

/** Map pi-coding-agent's `theme.fg("mdX", text)` API to pi-tui's MarkdownTheme. */
export function toMarkdownTheme(theme: Theme): MarkdownTheme {
	const wrap = (ansi: string) => (t: string) => `${ansi}${t}\u001b[0m`;
	return {
		heading: (t) => theme.fg("mdHeading", t),
		link: (t) => theme.fg("mdLink", t),
		linkUrl: (t) => theme.fg("mdLinkUrl", t),
		code: (t) => theme.fg("mdCode", t),
		codeBlock: (t) => theme.fg("mdCodeBlock", t),
		codeBlockBorder: (t) => theme.fg("mdCodeBlockBorder", t),
		quote: (t) => theme.fg("mdQuote", t),
		quoteBorder: (t) => theme.fg("mdQuoteBorder", t),
		hr: (t) => theme.fg("mdHr", t),
		listBullet: (t) => theme.fg("mdListBullet", t),
		bold: wrap("\u001b[1m"),
		italic: wrap("\u001b[3m"),
		strikethrough: wrap("\u001b[9m"),
		underline: wrap("\u001b[4m"),
	};
}

// ---- Pagination -----------------------------------------------------------

export const DEFAULT_PAGE_CHARS = 8_000;
export const COLLAPSED_PREVIEW_CHARS = 1_500;

export function paginateText(
	text: string,
	expanded: boolean,
	pageChars: number = DEFAULT_PAGE_CHARS,
): { page: string; totalChars: number; totalPages: number; pageNumber: number } {
	const totalChars = text.length;
	if (totalChars === 0) {
		return { page: "", totalChars, totalPages: 0, pageNumber: 0 };
	}

	if (!expanded) {
		const previewLen = Math.min(COLLAPSED_PREVIEW_CHARS, totalChars);
		return {
			page: `${text.slice(0, previewLen)}${previewLen < totalChars ? "\n\n[…expand with Ctrl+O]" : ""}`,
			totalChars,
			totalPages: Math.ceil(totalChars / pageChars),
			pageNumber: 1,
		};
	}

	const totalPages = Math.max(1, Math.ceil(totalChars / pageChars));
	const page = text.slice(0, pageChars);
	return {
		page: totalChars > pageChars ? `${page}\n\n[page 1/${totalPages} — ${totalChars} chars total]` : page,
		totalChars,
		totalPages,
		pageNumber: 1,
	};
}

// ---- Markdown helpers -----------------------------------------------------

const mdHeading = (mt: MarkdownTheme, level: number, text: string) => `${"#".repeat(level)} ${mt.heading(text)}`;

const mdLink = (mt: MarkdownTheme, label: string, url: string) => `[${mt.link(label)}](${mt.linkUrl(url)})`;

const mdMuted = (mt: MarkdownTheme, text: string) => `\u001b[2m${mt.heading(text)}\u001b[0m`;

// ---- Per-tool renderers ---------------------------------------------------

function renderSearchResult(
	result: { content: Array<{ type: "text"; text: string }> },
	options: RenderOptions,
	theme: Theme,
	_label: string,
): Component {
	const text = result.content[0]?.text ?? "";
	const { page } = paginateText(text, options.expanded);
	const mt = toMarkdownTheme(theme);

	const citations = options.expanded ? dedupeCitations(extractCitationsFromMcpText(text, "exa")) : [];
	let body = page;
	if (citations.length > 0) {
		body += "\n\n---\n\n**Sources**\n\n";
		body += citations.map((c, i) => `${i + 1}. ${mdLink(mt, c.title, c.url)}`).join("\n");
	}

	return new Markdown(body, 0, 0, mt);
}

export const renderWebsearchResult: RenderResult = (result, options, theme) =>
	renderSearchResult(result, options, theme, "Web Search");

export const renderCodesearchResult: RenderResult = (result, options, theme) =>
	renderSearchResult(result, options, theme, "Code Search");

export const renderContext7Result: RenderResult = (result, options, theme) => {
	const text = result.content[0]?.text ?? "";
	const { page } = paginateText(text, options.expanded);
	const mt = toMarkdownTheme(theme);
	const titleMatch = text.match(/^##\s+(.+)$/m);
	const title = titleMatch ? titleMatch[1] : "Context7 Docs";
	return new Markdown(`${mdHeading(mt, 2, title)}\n\n${page}`, 0, 0, mt);
};

export const renderDeepwikiResult: RenderResult = (result, options, theme) => {
	const text = result.content[0]?.text ?? "";
	const { page } = paginateText(text, options.expanded);
	const mt = toMarkdownTheme(theme);
	const repo = (result.details?.repo as string | undefined) ?? "";
	const header = repo ? `${mdMuted(mt, `DeepWiki · ${repo}`)}\n\n` : "";
	return new Markdown(`${header}${page}`, 0, 0, mt);
};

export const renderWebFetchResult: RenderResult = (result, options, theme) => {
	const text = result.content[0]?.text ?? "";
	const { page } = paginateText(text, options.expanded);
	const mt = toMarkdownTheme(theme);
	const url = (result.details?.url as string | undefined) ?? "";
	const header = url ? `${mdMuted(mt, url)}\n\n` : "";
	return new Markdown(`${header}${page}`, 0, 0, mt);
};

// ---- Partial-result helper ------------------------------------------------

/** Render a "still working…" line for streaming updates. */
export function renderPartial(_theme: Theme, message: string): Component {
	return new Text(message, 0, 0);
}
