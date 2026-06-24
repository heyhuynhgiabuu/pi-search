/**
 * Citation extraction and formatting helpers.
 *
 * Every tool that returns external content should produce
 * a structured `citations` array in its `details` so the
 * model (or a downstream UI) can render sources without
 * re-parsing prose.
 */

import type { Citation } from "../types.js";

/** Extract citations from MCP text payloads (Exa/DeepWiki format). */
export function extractCitationsFromMcpText(text: string, source: Citation["source"]): Citation[] {
	const citations: Citation[] = [];
	const lines = text.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		// Common MCP citation format: "Title: <title>\nURL: <url>\n..."
		const titleMatch = trimmed.match(/^Title:\s*(.+)$/i);
		if (!titleMatch) continue;
		const url = extractUrlFromSurroundingContext(lines, lines.indexOf(line));
		if (url) {
			citations.push({
				index: citations.length + 1,
				url,
				title: titleMatch[1].trim(),
				source,
			});
		}
	}
	return citations;
}

function extractUrlFromSurroundingContext(lines: string[], around: number): string | null {
	for (let i = Math.max(0, around - 2); i <= Math.min(lines.length - 1, around + 2); i++) {
		const urlMatch = lines[i].match(/URL:\s*(\S+)/i);
		if (urlMatch) return urlMatch[1];
		const bareUrlMatch = lines[i].match(/https?:\/\/[^\s)]+/i);
		if (bareUrlMatch) return bareUrlMatch[0];
	}
	return null;
}

/** Format a citation block at the end of a tool result. */
export function formatCitationFooter(citations: Citation[]): string {
	if (citations.length === 0) return "";
	const lines = ["", "## Sources"];
	for (const c of citations) {
		lines.push(`[${c.index}] [${c.title}](${c.url})`);
	}
	return lines.join("\n");
}

/** Best-effort de-duplication of citations by URL. */
export function dedupeCitations(citations: Citation[]): Citation[] {
	const seen = new Set<string>();
	const out: Citation[] = [];
	for (const c of citations) {
		if (seen.has(c.url)) continue;
		seen.add(c.url);
		out.push({ ...c, index: out.length + 1 });
	}
	return out;
}
