/**
 * Try common llms.txt paths for bare documentation domains (ketch-style).
 */

export function llmsTxtCandidateUrls(pageUrl: URL): string[] {
	const path = pageUrl.pathname.replace(/\/+$/, "") || "/";
	if (path !== "/" && path !== "") return [];

	const origin = pageUrl.origin;
	return [`${origin}/llms.txt`, `${origin}/.well-known/llms.txt`, `${origin}/llms-full.txt`];
}

export async function fetchFirstLlmsTxt(
	candidates: string[],
	options: { signal?: AbortSignal; timeoutMs: number },
): Promise<{ url: string; text: string } | null> {
	for (const url of candidates) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
		const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
		try {
			const response = await fetch(url, {
				headers: { Accept: "text/plain,text/markdown,*/*", "User-Agent": "pi-search/1.0" },
				signal,
				redirect: "follow",
			});
			if (!response.ok) continue;
			const text = (await response.text()).trim();
			if (text.length < 80) continue;
			if (!looksLikeLlmsIndex(text)) continue;
			return { url, text };
		} catch {
			// try next
		} finally {
			clearTimeout(timeout);
		}
	}
	return null;
}

function looksLikeLlmsIndex(text: string): boolean {
	const lower = text.slice(0, 2000).toLowerCase();
	return lower.includes("http") && (lower.includes("llms") || lower.includes("documentation") || text.includes("# "));
}
