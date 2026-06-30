import { FetchError } from "../errors.js";
import { fetchError } from "./errors.js";

const JINA_PREFIX = "https://r.jina.ai/";

export async function fetchViaJinaReader(
	targetUrl: string,
	options: { signal?: AbortSignal; timeoutMs: number },
): Promise<{ text: string; title: string | null }> {
	const jinaUrl = `${JINA_PREFIX}${targetUrl}`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;

	try {
		const response = await fetch(jinaUrl, {
			method: "GET",
			headers: { Accept: "text/plain", "User-Agent": "pi-search/1.0" },
			signal,
		});
		if (!response.ok) {
			throw fetchError("fetch_error", `Jina Reader HTTP ${response.status}`, {
				url: targetUrl,
				status: response.status,
			});
		}
		const text = (await response.text()).trim();
		if (!text) {
			throw fetchError("fetch_error", "Jina Reader returned empty body", { url: targetUrl });
		}
		const title = parseJinaTitle(text);
		return { text, title };
	} catch (err) {
		if (err instanceof FetchError) throw err;
		if (err instanceof Error && err.name === "AbortError") {
			throw fetchError("fetch_timeout", "Jina Reader timed out", { url: targetUrl });
		}
		const message = err instanceof Error ? err.message : String(err);
		throw fetchError("fetch_error", `Jina Reader failed: ${message}`, { url: targetUrl });
	} finally {
		clearTimeout(timeout);
	}
}

function parseJinaTitle(text: string): string | null {
	const line = text.split("\n")[0]?.trim() ?? "";
	if (line.startsWith("Title:")) return line.slice(6).trim() || null;
	return null;
}
