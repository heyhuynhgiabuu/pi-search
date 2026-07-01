import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown } from "@earendil-works/pi-tui";

/** Theme color for tool result panel background (matches pi-pretty `toolSuccess`). */
const TOOL_RESULT_BG: Parameters<Theme["bg"]>[0] = "toolSuccessBg";
const ESC_RE = "\u001b";
const ANSI_CAPTURE_RE = new RegExp(`${ESC_RE}\\[([0-9;]*)m`, "g");
const RESET_WITHOUT_BG = "\x1b[22;23;24;25;27;28;29;39m";

/** Collapsed preview length (chars). */
export const COLLAPSED_PREVIEW_CHARS = 1_500;

/** Default page size for expanded results (chars). */
export const DEFAULT_PAGE_CHARS = 4000;

export type RenderOptions = {
	expanded?: boolean;
	isPartial?: boolean;
};

export type MarkdownTheme = {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (url: string) => string;
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

/** Map Pi Theme → MarkdownTheme for pi-tui Markdown component. */
export function toMarkdownTheme(theme: Theme): MarkdownTheme {
	return {
		heading: (text) => theme.fg("mdHeading", text),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (url) => theme.fg("mdLinkUrl", url),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => `\x1b[1m${text}\x1b[0m`,
		italic: (text) => `\x1b[3m${text}\x1b[0m`,
		strikethrough: (text) => `\x1b[9m${text}\x1b[0m`,
		underline: (text) => `\x1b[4m${text}\x1b[0m`,
	};
}

export type PaginatedText = {
	page: string;
	totalChars: number;
	totalPages: number;
};

/** Paginate long text for expanded view; collapsed returns a short preview. */
export function paginateText(text: string, expanded: boolean, pageChars = DEFAULT_PAGE_CHARS): PaginatedText {
	const totalChars = text.length;
	if (!text) return { page: "", totalChars: 0, totalPages: 0 };

	if (!expanded) {
		const preview =
			text.length > COLLAPSED_PREVIEW_CHARS ? `${text.slice(0, COLLAPSED_PREVIEW_CHARS)}… (ctrl+o to expand)` : text;
		return { page: preview, totalChars, totalPages: 1 };
	}

	const totalPages = Math.max(1, Math.ceil(totalChars / pageChars));
	const page = text.slice(0, pageChars);
	const footer = totalPages > 1 ? `\n\n---\n[page 1/${totalPages} — ${totalChars.toLocaleString()} chars total]` : "";
	return { page: page + footer, totalChars, totalPages };
}

function firstText(result: { content?: Array<{ type?: string; text?: string }> }): string {
	const block = result.content?.find((c) => c.type === "text");
	return block?.text ?? "";
}

/** Wrap Markdown so pi-tui Box paints full-width `toolSuccess` background (see pi-tui Box.setBgFn). */
function wrapToolResultMarkdown(theme: Theme, markdown: string): InstanceType<typeof Box> {
	const md = new Markdown(markdown, 0, 0, toMarkdownTheme(theme));
	const box = new Box(0, 0);
	box.addChild(md);
	box.setBgFn((text) => theme.bg(TOOL_RESULT_BG, preserveBoxBackground(text)));
	return box;
}

function preserveBoxBackground(ansi: string): string {
	return ansi.replace(ANSI_CAPTURE_RE, (_seq, params: string) => {
		if (!params || params === "0") return RESET_WITHOUT_BG;
		const parts = params.split(";").filter(Boolean);
		const kept: string[] = [];
		let i = 0;
		while (i < parts.length) {
			const code = Number(parts[i]);
			if (code === 38) {
				kept.push(parts[i]);
				if (parts[i + 1] === "5") {
					kept.push(parts[i + 1], parts[i + 2]);
					i += 3;
				} else if (parts[i + 1] === "2") {
					kept.push(parts[i + 1], parts[i + 2], parts[i + 3], parts[i + 4]);
					i += 5;
				} else {
					i++;
				}
			} else if (code === 48) {
				if (parts[i + 1] === "5") i += 3;
				else if (parts[i + 1] === "2") i += 6;
				else i++;
			} else if (code === 49 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
				i++;
			} else {
				kept.push(parts[i]);
				i++;
			}
		}
		return kept.length ? `\x1b[${kept.join(";")}m` : "";
	});
}

function renderMarkdownResult(
	result: { content?: Array<{ type?: string; text?: string }> },
	options: RenderOptions,
	theme: Theme,
): InstanceType<typeof Box> {
	const raw = firstText(result);
	const { page } = paginateText(raw, options.expanded ?? false);
	return wrapToolResultMarkdown(theme, page);
}

export function renderWebsearchResult(
	result: { content?: Array<{ type?: string; text?: string }> },
	options: RenderOptions,
	theme: Theme,
	_context: unknown,
) {
	return renderMarkdownResult(result, options, theme);
}

export const renderCodesearchResult = renderWebsearchResult;

export function renderWebFetchResult(
	result: { content?: Array<{ type?: string; text?: string }> },
	options: RenderOptions,
	theme: Theme,
	_context: unknown,
) {
	return renderMarkdownResult(result, options, theme);
}

export function renderContext7Result(
	result: { content?: Array<{ type?: string; text?: string }> },
	options: RenderOptions,
	theme: Theme,
	_context: unknown,
) {
	return renderMarkdownResult(result, options, theme);
}

export function renderDeepwikiResult(
	result: { content?: Array<{ type?: string; text?: string }> },
	options: RenderOptions,
	theme: Theme,
	_context: unknown,
) {
	return renderMarkdownResult(result, options, theme);
}
