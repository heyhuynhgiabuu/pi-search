import { fetchError } from "./errors.js";

const MAX_PDF_BYTES = 25 * 1024 * 1024;

export async function extractPdfTextFromBytes(
	buffer: ArrayBuffer,
	options: { url: string },
): Promise<{ text: string; totalPages: number }> {
	if (buffer.byteLength > MAX_PDF_BYTES) {
		throw fetchError("fetch_error", `PDF exceeds ${MAX_PDF_BYTES} byte limit`, {
			url: options.url,
			bytes: buffer.byteLength,
		});
	}

	const { extractText, getDocumentProxy } = await import("unpdf");
	const pdf = await getDocumentProxy(new Uint8Array(buffer));
	const { totalPages, text } = await extractText(pdf, { mergePages: true });
	const merged = Array.isArray(text) ? text.join("\n\n") : String(text ?? "");
	const trimmed = merged.trim();
	if (!trimmed) {
		throw fetchError("fetch_error", "PDF contains no extractable text (scanned/OCR not supported)", {
			url: options.url,
			totalPages,
		});
	}
	return { text: trimmed, totalPages };
}
