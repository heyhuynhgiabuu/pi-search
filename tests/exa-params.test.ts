import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/errors.js";
import { DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS, normalizeExaParams } from "../src/exa/params.js";

const NOW = new Date("2026-06-15T12:00:00Z");

describe("normalizeExaParams", () => {
	it("accepts a single query", () => {
		const out = normalizeExaParams({ query: "foo" }, { now: () => NOW });
		expect(out.queries).toEqual(["foo"]);
		expect(out.searchType).toBe("auto");
		expect(out.numResults).toBe(DEFAULT_NUM_RESULTS);
	});

	it("accepts multiple queries and dedupes whitespace", () => {
		const out = normalizeExaParams({ queries: ["  a  ", "b", "a"] }, { now: () => NOW });
		expect(out.queries).toEqual(["a", "b"]);
	});

	it("rejects both query and queries", () => {
		expect(() => normalizeExaParams({ query: "x", queries: ["y"] })).toThrowError(ValidationError);
	});

	it("rejects empty query list", () => {
		expect(() => normalizeExaParams({ query: "" })).toThrowError(ValidationError);
		expect(() => normalizeExaParams({ queries: [] })).toThrowError(ValidationError);
		expect(() => normalizeExaParams({ queries: [" ", "\t"] })).toThrowError(ValidationError);
	});

	it("clamps numResults to 1..MAX_NUM_RESULTS", () => {
		expect(() => normalizeExaParams({ query: "x", numResults: 0 })).toThrowError(ValidationError);
		expect(() => normalizeExaParams({ query: "x", numResults: MAX_NUM_RESULTS + 1 })).toThrowError(ValidationError);
		expect(() => normalizeExaParams({ query: "x", numResults: 2.5 })).toThrowError(ValidationError);
	});

	it("rejects invalid searchType", () => {
		expect(() => normalizeExaParams({ query: "x", searchType: "lol" as never })).toThrowError(ValidationError);
	});

	it("rejects recencyFilter + startPublishedDate mix", () => {
		expect(() =>
			normalizeExaParams({ query: "x", recencyFilter: "week", startPublishedDate: "2026-01-01" }, { now: () => NOW }),
		).toThrowError(ValidationError);
	});

	it("converts recencyFilter to a startPublishedDate", () => {
		const out = normalizeExaParams({ query: "x", recencyFilter: "day" }, { now: () => NOW });
		expect(out.startPublishedDate).toBe("2026-06-14T12:00:00.000Z");
	});

	it("normalizes YYYY-MM-DD bounds to start of day / end of day UTC", () => {
		const out = normalizeExaParams(
			{ query: "x", startPublishedDate: "2026-01-01", endPublishedDate: "2026-01-31" },
			{ now: () => NOW },
		);
		expect(out.startPublishedDate).toBe("2026-01-01T00:00:00.000Z");
		expect(out.endPublishedDate).toBe("2026-01-31T23:59:59.999Z");
	});

	it("rejects start > end", () => {
		expect(() =>
			normalizeExaParams(
				{ query: "x", startPublishedDate: "2026-02-01", endPublishedDate: "2026-01-01" },
				{ now: () => NOW },
			),
		).toThrowError(ValidationError);
	});

	it("merges domainFilter with include/exclude and dedupes", () => {
		const out = normalizeExaParams(
			{
				query: "x",
				domainFilter: ["reuters.com", "-reddit.com"],
				includeDomains: ["nytimes.com", "reuters.com"],
			},
			{ now: () => NOW },
		);
		expect(out.includeDomains.sort()).toEqual(["nytimes.com", "reuters.com"]);
		expect(out.excludeDomains).toEqual(["reddit.com"]);
	});

	it("rejects conflicting include + exclude domain", () => {
		expect(() =>
			normalizeExaParams({ query: "x", includeDomains: ["x.com"], excludeDomains: ["x.com"] }, { now: () => NOW }),
		).toThrowError(ValidationError);
	});

	it("strips www. and lowercases domains", () => {
		const out = normalizeExaParams({ query: "x", includeDomains: ["WWW.Example.com"] }, { now: () => NOW });
		expect(out.includeDomains).toEqual(["example.com"]);
	});

	it("accepts full URLs in domain filters and extracts hostname", () => {
		const out = normalizeExaParams({ query: "x", includeDomains: ["https://Example.com/path"] }, { now: () => NOW });
		expect(out.includeDomains).toEqual(["example.com"]);
	});

	it("rejects invalid domains", () => {
		expect(() => normalizeExaParams({ query: "x", includeDomains: ["not a domain"] }, { now: () => NOW })).toThrowError(
			ValidationError,
		);
	});
});
