export type UrlRewriteRule = {
	match: string;
	replace: string;
};

export function applyUrlRewrites(urlString: string, rules: UrlRewriteRule[]): string {
	if (rules.length === 0) return urlString;
	let out = urlString;
	for (const rule of rules) {
		if (!rule.match) continue;
		out = out.split(rule.match).join(rule.replace);
	}
	return out;
}

export function parseUrlRewriteRules(raw: unknown): UrlRewriteRule[] {
	if (!Array.isArray(raw)) return [];
	const out: UrlRewriteRule[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const r = item as Record<string, unknown>;
		if (typeof r.match !== "string" || typeof r.replace !== "string") continue;
		const match = r.match.trim();
		if (!match) continue;
		out.push({ match, replace: r.replace });
	}
	return out;
}
