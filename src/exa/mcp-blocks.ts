import type { NormalizedExaResult } from "../types.js";

const METADATA_PREFIXES = ["Title:", "URL:", "Highlights:", "Published date:", "Author:", "Score:"];

function isMetadataLine(line: string): boolean {
	const t = line.trim();
	return METADATA_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * Parse Exa MCP prose blocks separated by --- (ketch search/exa.go parseContent).
 */
export function parseExaMcpTextToResults(raw: string, limit: number): NormalizedExaResult[] {
	const results: NormalizedExaResult[] = [];
	for (const block of raw.split("\n---\n")) {
		if (results.length >= limit) break;
		let title = "";
		let url = "";
		const highlightLines: string[] = [];
		for (const line of block.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.startsWith("Title:")) title = trimmed.slice(6).trim();
			else if (trimmed.startsWith("URL:")) url = trimmed.slice(4).trim();
			else if (trimmed.startsWith("Published date:")) {
				// stored in publishedDate below via first highlight pass - skip line
			} else if (trimmed !== "" && !isMetadataLine(trimmed)) {
				highlightLines.push(trimmed);
			}
		}
		if (!title || !url) continue;
		let publishedDate: string | undefined;
		for (const line of block.split("\n")) {
			const t = line.trim();
			if (t.startsWith("Published date:")) {
				publishedDate = t.slice(15).trim() || undefined;
				break;
			}
		}
		results.push({
			title,
			url,
			publishedDate,
			highlights: highlightLines.length > 0 ? [highlightLines[0]] : [],
			summary: highlightLines.join("\n"),
		});
	}
	return results;
}
