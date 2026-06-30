/**
 * Parameter normalization for Exa search.
 *
 * Adapted from najibninaba/pi-exa-search's params.ts to:
 *  - reuse our existing `EffectiveExaParams` type
 *  - validate Exa-specific search types + recency filters
 *  - normalize domain filters (with `-` exclude prefix)
 *  - normalize date bounds + reject recencyFilter+date mixing
 *
 * Pure functions, no I/O. Trivially unit-testable.
 */

import { ValidationError } from "../errors.js";
import {
	type EffectiveExaParams,
	EXA_RECENCY_FILTERS,
	EXA_SEARCH_TYPES,
	type ExaRecencyFilter,
	type ExaSearchType,
} from "../types.js";

export const DEFAULT_NUM_RESULTS = 5;
export const MAX_NUM_RESULTS = 10;
export const DEFAULT_HIGHLIGHTS_MAX_CHARACTERS = 800;
export const MIN_HIGHLIGHTS_MAX_CHARACTERS = 200;
export const MAX_HIGHLIGHTS_MAX_CHARACTERS = 4000;

export type RawExaParams = {
	query?: string;
	queries?: string[];
	numResults?: number;
	searchType?: ExaSearchType;
	recencyFilter?: ExaRecencyFilter;
	startPublishedDate?: string;
	endPublishedDate?: string;
	domainFilter?: string[];
	includeDomains?: string[];
	excludeDomains?: string[];
	highlightsMaxCharacters?: number;
	includeContent?: boolean;
};

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

function normalizeQueryList(query?: string, queries?: string[]): string[] {
	if (query && queries) {
		throw new ValidationError("Provide either query or queries, not both.", { param: "query" });
	}
	const rawValues = query ? [query] : (queries ?? []);
	const normalized = unique(rawValues.map((v) => v.trim()).filter(Boolean));
	if (normalized.length === 0) {
		throw new ValidationError("Provide query or queries with at least one non-empty search string.", {
			param: "query",
		});
	}
	return normalized;
}

function normalizeDomainValue(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) throw new ValidationError("Domain filters cannot contain empty values.");
	const withoutPrefix = trimmed.startsWith("-") ? trimmed.slice(1) : trimmed;
	const candidate =
		withoutPrefix.startsWith("http://") || withoutPrefix.startsWith("https://")
			? new URL(withoutPrefix).hostname
			: withoutPrefix.split("/")[0];
	const normalized = candidate.toLowerCase().replace(/^www\./, "");
	if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(normalized)) {
		throw new ValidationError(`Invalid domain filter: ${raw}`, { value: raw });
	}
	return normalized;
}

function mergeDomains(raw: RawExaParams): { includeDomains: string[]; excludeDomains: string[] } {
	const includeDomains = [...(raw.includeDomains ?? [])];
	const excludeDomains = [...(raw.excludeDomains ?? [])];
	for (const entry of raw.domainFilter ?? []) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith("-")) excludeDomains.push(trimmed.slice(1));
		else includeDomains.push(trimmed);
	}
	const normalizedIncludes = unique(includeDomains.map(normalizeDomainValue));
	const normalizedExcludes = unique(excludeDomains.map(normalizeDomainValue));
	const conflicts = normalizedIncludes.filter((d) => normalizedExcludes.includes(d));
	if (conflicts.length > 0) {
		throw new ValidationError(`The same domain cannot be both included and excluded: ${conflicts.join(", ")}`, {
			conflicts,
		});
	}
	return { includeDomains: normalizedIncludes, excludeDomains: normalizedExcludes };
}

function normalizeDate(value: string, bound: "start" | "end"): string {
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		const [year, month, day] = value.split("-").map(Number);
		const date =
			bound === "start"
				? new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0))
				: new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
		return date.toISOString();
	}
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		throw new ValidationError(`Invalid ${bound}PublishedDate: ${value}`, { value });
	}
	return parsed.toISOString();
}

function recencyStartDate(now: Date, recencyFilter: ExaRecencyFilter): string {
	const date = new Date(now.getTime());
	if (recencyFilter === "day") date.setUTCDate(date.getUTCDate() - 1);
	if (recencyFilter === "week") date.setUTCDate(date.getUTCDate() - 7);
	if (recencyFilter === "month") date.setUTCMonth(date.getUTCMonth() - 1);
	if (recencyFilter === "year") date.setUTCFullYear(date.getUTCFullYear() - 1);
	return date.toISOString();
}

export function normalizeExaParams(raw: RawExaParams, options: { now?: () => Date } = {}): EffectiveExaParams {
	if (raw.recencyFilter && !EXA_RECENCY_FILTERS.includes(raw.recencyFilter)) {
		throw new ValidationError(`Invalid recencyFilter: ${raw.recencyFilter}`, {
			allowed: [...EXA_RECENCY_FILTERS],
		});
	}
	if (raw.searchType && !EXA_SEARCH_TYPES.includes(raw.searchType)) {
		throw new ValidationError(`Invalid searchType: ${raw.searchType}`, {
			allowed: [...EXA_SEARCH_TYPES],
		});
	}

	if (raw.recencyFilter && (raw.startPublishedDate || raw.endPublishedDate)) {
		throw new ValidationError("Use either recencyFilter or explicit published date bounds, not both.", {
			param: "recencyFilter",
		});
	}

	const queries = normalizeQueryList(raw.query, raw.queries);
	const { includeDomains, excludeDomains } = mergeDomains(raw);

	const numResults = raw.numResults ?? DEFAULT_NUM_RESULTS;
	if (!Number.isInteger(numResults) || numResults < 1 || numResults > MAX_NUM_RESULTS) {
		throw new ValidationError(`numResults must be an integer between 1 and ${MAX_NUM_RESULTS}.`, {
			param: "numResults",
			value: numResults,
		});
	}

	const highlightsMaxCharacters = raw.highlightsMaxCharacters ?? DEFAULT_HIGHLIGHTS_MAX_CHARACTERS;
	if (
		!Number.isInteger(highlightsMaxCharacters) ||
		highlightsMaxCharacters < MIN_HIGHLIGHTS_MAX_CHARACTERS ||
		highlightsMaxCharacters > MAX_HIGHLIGHTS_MAX_CHARACTERS
	) {
		throw new ValidationError(
			`highlightsMaxCharacters must be an integer between ${MIN_HIGHLIGHTS_MAX_CHARACTERS} and ${MAX_HIGHLIGHTS_MAX_CHARACTERS}.`,
			{ param: "highlightsMaxCharacters", value: highlightsMaxCharacters },
		);
	}

	const now = options.now?.() ?? new Date();
	const startPublishedDate = raw.startPublishedDate
		? normalizeDate(raw.startPublishedDate, "start")
		: raw.recencyFilter
			? recencyStartDate(now, raw.recencyFilter)
			: undefined;
	const endPublishedDate = raw.endPublishedDate ? normalizeDate(raw.endPublishedDate, "end") : undefined;

	if (startPublishedDate && endPublishedDate && startPublishedDate > endPublishedDate) {
		throw new ValidationError("startPublishedDate must be before or equal to endPublishedDate.", {
			start: startPublishedDate,
			end: endPublishedDate,
		});
	}

	return {
		queries,
		numResults,
		searchType: raw.searchType ?? "auto",
		...(raw.recencyFilter ? { recencyFilter: raw.recencyFilter } : {}),
		includeDomains,
		excludeDomains,
		...(startPublishedDate ? { startPublishedDate } : {}),
		...(endPublishedDate ? { endPublishedDate } : {}),
		highlightsMaxCharacters,
		includeContent: raw.includeContent === true,
	};
}
