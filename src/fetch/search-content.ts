import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ResolvedConfig } from "../types.js";
import { FETCH_CONTENT_CUSTOM_TYPE, putFetchContent } from "./content-store.js";
import { writeFetchToDiskCache } from "./disk-cache.js";
import { resolveUrlContent } from "./resolve-content.js";

const MAX_URLS = 5;
const MAX_CONCURRENT = 2;

export async function fetchSearchResultUrlsInBackground(
	pi: ExtensionAPI,
	config: ResolvedConfig,
	urls: string[],
	signal: AbortSignal | undefined,
): Promise<void> {
	const unique = [...new Set(urls.map((u) => u.trim()).filter((u) => u.startsWith("http")))].slice(0, MAX_URLS);
	if (unique.length === 0) return;

	let index = 0;
	const worker = async () => {
		while (index < unique.length) {
			if (signal?.aborted) return;
			const i = index++;
			const url = unique[i];
			if (!url) continue;
			try {
				const resolved = await resolveUrlContent(url, config, { signal, maxOutputChars: 2_000_000 });
				const { record } = putFetchContent({
					url: resolved.url,
					title: resolved.title,
					text: resolved.text,
					extraction: resolved.extraction,
				});
				pi.appendEntry(FETCH_CONTENT_CUSTOM_TYPE, record);
				writeFetchToDiskCache(record);
			} catch {
				// skip failed URLs
			}
		}
	};

	await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, unique.length) }, () => worker()));
}
