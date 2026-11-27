import { beforeEach, describe, expect, it } from "vitest";
import { clearFetchContentStore, putFetchContent } from "../../src/fetch/content-store.js";
import { createGetFetchContentTool } from "../../src/tools/get-fetch-content.js";

describe("get_fetch_content tool", () => {
	beforeEach(() => clearFetchContentStore());

	it("lists stored fetches", async () => {
		putFetchContent({ url: "https://a.com", title: null, text: "x", extraction: "direct" });
		const tool = createGetFetchContentTool();
		const result = await tool.execute("id", { list: true }, undefined);
		expect(result.content[0]?.text).toContain("https://a.com");
	});

	it("returns slice by fetchId", async () => {
		const { id } = putFetchContent({
			url: "https://b.com",
			title: "Page",
			text: "abcdefghij",
			extraction: "direct",
		});

		const tool = createGetFetchContentTool();
		const result = await tool.execute("id", { fetchId: id, offset: 2, maxChars: 4 }, undefined);
		expect(result.content[0]?.text).toContain("cdef");
	});

	it("accepts null optionals, out-of-bound offset/maxChars, and extra keys", async () => {
		const { id } = putFetchContent({
			url: "https://c.com",
			title: null,
			text: "0123456789",
			extraction: "direct",
		});

		const tool = createGetFetchContentTool();

		const result = await tool.execute(
			"id",
			{ fetchId: id, list: null, offset: -5.4, maxChars: null, extraKey: "ignored" },
			undefined,
		);

		expect(result.content[0]?.text).toBe("0123456789");
		expect(result.details).toMatchObject({ offset: 0, returnedChars: 10 });
	});
});
