import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearFetchContentStore,
	FETCH_CONTENT_CUSTOM_TYPE,
	getFetchContent,
	isValidStoredFetchPayload,
	putFetchContent,
	restoreFetchContentFromSession,
	WEB_FETCH_INLINE_MAX_CHARS,
} from "../../src/fetch/content-store.js";
import { clearFetchDiskCache } from "../../src/fetch/disk-cache.js";

describe("content-store", () => {
	const tempHome = mkdtempSync(join(tmpdir(), "pi-search-store-"));

	beforeEach(() => {
		vi.stubEnv("HOME", tempHome);
		clearFetchContentStore();
		clearFetchDiskCache();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("stores and retrieves by id", () => {
		const { id } = putFetchContent({
			url: "https://example.com",
			title: "T",
			text: "body",
			extraction: "direct",
		});
		expect(getFetchContent(id)?.text).toBe("body");
	});

	it("exports inline cap constant", () => {
		expect(WEB_FETCH_INLINE_MAX_CHARS).toBe(30_000);
	});

	it("restores from session branch custom entries", () => {
		clearFetchContentStore();
		const { record } = putFetchContent({
			url: "https://saved.com",
			title: null,
			text: "persisted",
			extraction: "readability",
		});
		clearFetchContentStore();

		const count = restoreFetchContentFromSession({
			sessionManager: {
				getBranch: () => [
					{ type: "custom", customType: FETCH_CONTENT_CUSTOM_TYPE, data: record },
					{ type: "message", customType: "other" },
				],
			},
		});
		expect(count).toBe(1);
		expect(getFetchContent(record.id)?.text).toBe("persisted");
	});

	it("skips expired entries on restore", () => {
		const stale: ReturnType<typeof putFetchContent>["record"] = {
			id: "deadbeef",
			url: "https://old.com",
			title: null,
			text: "old",
			extraction: "direct",
			createdAt: Date.now() - 2 * 60 * 60 * 1000,
		};
		expect(isValidStoredFetchPayload(stale)).toBe(true);
		restoreFetchContentFromSession(
			{
				sessionManager: {
					getBranch: () => [{ type: "custom", customType: FETCH_CONTENT_CUSTOM_TYPE, data: stale }],
				},
			},
			{ ttlMs: 60 * 60 * 1000 },
		);
		expect(getFetchContent("deadbeef")).toBeNull();
	});
});
