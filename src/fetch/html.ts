import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

export type HtmlExtractResult = {
	text: string;
	title: string | null;
	method: "readability" | "strip";
};

export function extractFromHtml(html: string, _pageUrl: string): HtmlExtractResult {
	const { document } = parseHTML(html);
	const title = document.title?.trim() || null;

	try {
		const article = new Readability(document, { charThreshold: 100 }).parse();
		if (article?.textContent && article.textContent.trim().length > 0) {
			const text = article.textContent.trim();
			return { text, title: article.title?.trim() || title, method: "readability" };
		}
	} catch {
		// fall through
	}

	const bodyHtml = document.body?.innerHTML ?? html;
	let text = turndown.turndown(bodyHtml);
	text = text.replace(/\n{3,}/g, "\n\n").trim();
	return { text, title, method: "strip" };
}

const CONSENT_MARKERS = [
	"cookie",
	"consent",
	"gdpr",
	"accept all",
	"before you continue",
	"enable javascript",
	"please enable javascript",
	"access denied",
	"bot detection",
	"verify you are human",
];

/** True when extracted text looks like a shell/consent page rather than article body. */
export function isThinOrConsentPage(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length < 400) return true;
	const lower = trimmed.toLowerCase();
	const hits = CONSENT_MARKERS.filter((m) => lower.includes(m)).length;
	if (hits >= 2 && trimmed.length < 2500) return true;
	if (hits >= 3) return true;
	const alphaRatio = (trimmed.match(/[a-zA-Z]/g)?.length ?? 0) / Math.max(trimmed.length, 1);
	if (alphaRatio < 0.35 && trimmed.length < 1500) return true;
	return false;
}
