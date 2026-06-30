import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearFetchContentStore, getFetchContent, putFetchContent } from "../../src/fetch/content-store.js";

describe("disk cache integration", () => {
	const tempHome = mkdtempSync(join(tmpdir(), "pi-search-cache-"));

	beforeEach(() => {
		vi.stubEnv("HOME", tempHome);
		clearFetchContentStore();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(tempHome, { recursive: true, force: true });
	});

	it("writes and reads via getFetchContent after memory clear", () => {
		const { id, record } = putFetchContent({
			url: "https://cache.test",
			title: null,
			text: "cached body",
			extraction: "direct",
		});
		clearFetchContentStore();
		const loaded = getFetchContent(id);
		expect(loaded?.text).toBe("cached body");
		expect(loaded?.id).toBe(record.id);
	});
});
