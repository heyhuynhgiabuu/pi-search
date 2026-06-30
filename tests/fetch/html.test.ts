import { describe, expect, it } from "vitest";
import { extractFromHtml, isThinOrConsentPage } from "../../src/fetch/html.js";

describe("extractFromHtml", () => {
	it("extracts article text from simple HTML", () => {
		const html = `<!DOCTYPE html><html><head><title>Test Page</title></head><body><article><p>${"Hello world. ".repeat(40)}</p></article></body></html>`;
		const result = extractFromHtml(html, "https://example.com");
		expect(result.text.length).toBeGreaterThan(100);
		expect(result.title).toBe("Test Page");
	});
});

describe("isThinOrConsentPage", () => {
	it("flags short cookie banners", () => {
		expect(isThinOrConsentPage("We use cookies. Accept all cookies to continue.")).toBe(true);
	});

	it("accepts long article text", () => {
		expect(isThinOrConsentPage("word ".repeat(500))).toBe(false);
	});
});
