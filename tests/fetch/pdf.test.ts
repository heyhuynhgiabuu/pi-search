import { describe, expect, it } from "vitest";
import { extractPdfTextFromBytes } from "../../src/fetch/pdf.js";

// Minimal valid PDF (single empty page) — may yield no text
const MINIMAL_PDF_BASE64 =
	"JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZwovUGFnZXMgMiAwIFIKPj4KZW5kb2JqCjIgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFszIDAgUl0KL0NvdW50IDEKPD4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL1BhcmVudCAyIDAgUgovTWVkaWFCb3ggWzAgMCA2MTIgNzkyXQo+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE5IDAwMDAwIG4gCjAwMDAwMDAwNzggMDAwMDAgbiAKMDAwMDAwMDE1NyAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDQKL1Jvb3QgMSAwIFIKPj4Kc3RhcnR4cmVmCjI0NAolJUVPRg==";

describe("extractPdfTextFromBytes", () => {
	it("rejects oversized PDF", async () => {
		const huge = new ArrayBuffer(26 * 1024 * 1024);
		await expect(extractPdfTextFromBytes(huge, { url: "https://x.com/a.pdf" })).rejects.toMatchObject({
			code: "fetch_error",
		});
	});

	it("parses minimal PDF or reports no text", async () => {
		const buf = Buffer.from(MINIMAL_PDF_BASE64, "base64");
		try {
			const result = await extractPdfTextFromBytes(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), {
				url: "https://example.com/t.pdf",
			});
			expect(result.totalPages).toBeGreaterThanOrEqual(1);
		} catch (err) {
			expect((err as { message?: string }).message).toMatch(/no extractable text/i);
		}
	});
});
