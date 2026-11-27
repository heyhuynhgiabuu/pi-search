import { arr, compile, nullable, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import { ProviderError } from "../errors.js";
import type { NormalizedExaResult } from "../types.js";

const BRAVE_WEB_SEARCH = "https://api.search.brave.com/res/v1/web/search";

const BraveResultSchema = obj(
	{
		title: opt(unknown()),
		url: opt(unknown()),
		description: opt(unknown()),
		age: opt(unknown()),
	},
	{ open: true },
);

const BraveResponseSchema = obj(
	{
		web: opt(
			nullable(
				obj(
					{
						results: opt(nullable(arr(BraveResultSchema))),
					},
					{ open: true },
				),
			),
		),
	},
	{ open: true },
);

const braveResponseValidator = compile(BraveResponseSchema);

const stringValidator = compile(str());

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

	let parsed: ReturnType<typeof braveResponseValidator.validate>;

	try {
		parsed = braveResponseValidator.validate(await response.json());
	} catch {
		throw new ProviderError("Brave Search returned invalid JSON.", { provider: "brave" });
	}

	if (!parsed.ok) {
		const first = parsed.errors[0];
		const detail = first ? `${first.path || "/"}: ${first.message}` : "schema validation failed";
		throw new ProviderError(`Brave Search returned invalid JSON (${detail}).`, { provider: "brave" });
	}

	const results = parsed.value.web?.results ?? [];
	const normalized: NormalizedExaResult[] = [];

	for (const r of results) {
		if (!stringValidator.check(r.url) || !r.url) continue;

		const title = stringValidator.check(r.title) ? r.title : r.url;
		const description = stringValidator.check(r.description) && r.description ? [r.description] : [];
		const age = stringValidator.check(r.age) ? r.age : undefined;

		normalized.push({
			title,
			url: r.url,
			publishedDate: age,
			highlights: description,
		});
	}

	return normalized;
}
