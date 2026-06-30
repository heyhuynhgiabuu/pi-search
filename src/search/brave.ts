import { ProviderError } from "../errors.js";
import type { NormalizedExaResult } from "../types.js";

const BRAVE_WEB_SEARCH = "https://api.search.brave.com/res/v1/web/search";

export async function braveWebSearch(
	query: string,
	options: { apiKey: string; numResults: number; signal?: AbortSignal },
): Promise<NormalizedExaResult[]> {
	const count = Math.min(20, Math.max(1, options.numResults));
	const url = new URL(BRAVE_WEB_SEARCH);
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(count));
	url.searchParams.set("text_decorations", "false");
	url.searchParams.set("result_filter", "web");

	const response = await fetch(url.toString(), {
		headers: {
			Accept: "application/json",
			"X-Subscription-Token": options.apiKey,
		},
		signal: options.signal,
	});

	if (response.status === 401) {
		throw new ProviderError(
			"Brave: invalid API key. Get a free key at https://brave.com/search/api/ then set BRAVE_API_KEY or braveApiKey in ~/.pi/pi-search.json",
			{ provider: "brave", status: 401 },
		);
	}
	if (response.status === 429) {
		throw new ProviderError("Brave: rate limited", { provider: "brave", status: 429 });
	}
	if (!response.ok) {
		throw new ProviderError(`Brave Search HTTP ${response.status}`, { provider: "brave", status: response.status });
	}

	const data = (await response.json()) as {
		web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string }> };
	};

	const results = data.web?.results ?? [];
	return results
		.filter((r) => typeof r.url === "string" && r.url.length > 0)
		.map((r) => ({
			title: r.title ?? r.url ?? "Untitled",
			url: r.url as string,
			publishedDate: r.age,
			highlights: r.description ? [r.description] : [],
		}));
}
