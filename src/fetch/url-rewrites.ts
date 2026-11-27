import { compile, obj, type Static, str } from "@earendil-works/pi-schema";

export const UrlRewriteRuleSchema = obj(
	{
		match: str(),
		replace: str(),
	},
	{ open: true },
);

export type UrlRewriteRule = Static<typeof UrlRewriteRuleSchema>;

export type UrlRewriteJsonValue =
	| string
	| number
	| boolean
	| null
	| readonly UrlRewriteJsonValue[]
	| { readonly [key: string]: UrlRewriteJsonValue };

const urlRewriteRuleValidator = compile(UrlRewriteRuleSchema);

export function applyUrlRewrites(urlString: string, rules: UrlRewriteRule[]): string {
	if (rules.length === 0) return urlString;
	let out = urlString;

	for (const rule of rules) {
		if (!rule.match) continue;
		out = out.split(rule.match).join(rule.replace);
	}

	return out;
}

export function parseUrlRewriteRules(raw?: UrlRewriteJsonValue): UrlRewriteRule[] {
	if (!Array.isArray(raw)) return [];
	const out: UrlRewriteRule[] = [];

	for (const item of raw) {
		if (!urlRewriteRuleValidator.check(item)) continue;
		const match = item.match.trim();

		if (!match) continue;
		out.push({ match, replace: item.replace });
	}

	return out;
}
