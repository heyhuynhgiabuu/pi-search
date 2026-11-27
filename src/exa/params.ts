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

import { arr, bool, nullable, num, obj, opt, str } from "@earendil-works/pi-schema";
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

export const ExaExecuteParamsSchema = obj(
	{
		query: opt(nullable(str())),
		queries: opt(nullable(arr(str()))),
		numResults: opt(nullable(num())),
		searchType: opt(nullable(str())),
		recencyFilter: opt(nullable(str())),
		startPublishedDate: opt(nullable(str())),
		endPublishedDate: opt(nullable(str())),
		domainFilter: opt(nullable(arr(str()))),
		includeDomains: opt(nullable(arr(str()))),
		excludeDomains: opt(nullable(arr(str()))),
		highlightsMaxCharacters: opt(nullable(num())),
		includeContent: opt(nullable(bool())),
	},
	{ open: true },
);

export type RawExaParams = {
	query?: string | null;
	queries?: string[] | null;
	numResults?: number | null;
	searchType?: string | null;
	recencyFilter?: string | null;
	startPublishedDate?: string | null;
	endPublishedDate?: string | null;
	domainFilter?: string[] | null;
	includeDomains?: string[] | null;
	excludeDomains?: string[] | null;
	highlightsMaxCharacters?: number | null;
	includeContent?: boolean | null;
};

function isExaRecencyFilter(value: string): value is ExaRecencyFilter {
	return EXA_RECENCY_FILTERS.some((filter) => filter === value);
}

function isExaSearchType(value: string): value is ExaSearchType {
	return EXA_SEARCH_TYPES.some((searchType) => searchType === value);
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

function normalizeQueryList(query?: string | null, queries?: string[] | null): string[] {
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

type MergedDomains = {
	includeDomains: string[];
	excludeDomains: string[];
};

function mergeDomains(raw: RawExaParams): MergedDomains {
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
	let recencyFilter: ExaRecencyFilter | undefined;

	if (raw.recencyFilter) {
		if (!isExaRecencyFilter(raw.recencyFilter)) {
			throw new ValidationError(`Invalid recencyFilter: ${raw.recencyFilter}`, {
				allowed: [...EXA_RECENCY_FILTERS],
			});
		}

		recencyFilter = raw.recencyFilter;
	}

	let searchType: ExaSearchType = "auto";

	if (raw.searchType) {
		if (!isExaSearchType(raw.searchType)) {
			throw new ValidationError(`Invalid searchType: ${raw.searchType}`, {
				allowed: [...EXA_SEARCH_TYPES],
			});
		}

		searchType = raw.searchType;
	}

	if (recencyFilter && (raw.startPublishedDate || raw.endPublishedDate)) {
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
		: recencyFilter
			? recencyStartDate(now, recencyFilter)
			: undefined;

	const endPublishedDate = raw.endPublishedDate ? normalizeDate(raw.endPublishedDate, "end") : undefined;

	if (startPublishedDate && endPublishedDate && startPublishedDate > endPublishedDate) {
		throw new ValidationError("startPublishedDate must be before or equal to endPublishedDate.", {
			start: startPublishedDate,
			end: endPublishedDate,
		});
	}

	const effective: EffectiveExaParams = {
		queries,
		numResults,
		searchType,
		includeDomains,
		excludeDomains,
		highlightsMaxCharacters,
		includeContent: raw.includeContent === true,
	};

	if (recencyFilter) effective.recencyFilter = recencyFilter;

	if (startPublishedDate) effective.startPublishedDate = startPublishedDate;

	if (endPublishedDate) effective.endPublishedDate = endPublishedDate;

	return effective;
}
