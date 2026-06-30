import { randomBytes } from "node:crypto";
import { loadAllFetchFromDiskCache, readFetchFromDiskCache, writeFetchToDiskCache } from "./disk-cache.js";

export type StoredFetchRecord = {
	id: string;
	url: string;
	title: string | null;
	text: string;
	extraction: string;
	createdAt: number;
};

/** Pi session JSONL custom entry type (not sent to the model). */
export const FETCH_CONTENT_CUSTOM_TYPE = "pi-search-fetch-content";

/** Drop restored entries older than this (limits session file + memory). */
export const SESSION_RESTORE_TTL_MS = 60 * 60 * 1000;

const MAX_STORED_CHARS = 2_000_000;
const MAX_ENTRIES = 50;

const store = new Map<string, StoredFetchRecord>();

function newId(): string {
	return randomBytes(6).toString("hex");
}

function upsertRecord(record: StoredFetchRecord): void {
	if (store.size >= MAX_ENTRIES && !store.has(record.id)) {
		const oldest = [...store.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
		if (oldest) store.delete(oldest[0]);
	}
	store.set(record.id, record);
}

export function putFetchContent(input: { url: string; title: string | null; text: string; extraction: string }): {
	id: string;
	record: StoredFetchRecord;
	storedChars: number;
	truncatedForStore: boolean;
} {
	let text = input.text;
	let truncatedForStore = false;
	if (text.length > MAX_STORED_CHARS) {
		text = `${text.slice(0, MAX_STORED_CHARS)}\n\n[stored content truncated at ${MAX_STORED_CHARS} chars]`;
		truncatedForStore = true;
	}

	const id = newId();
	const record: StoredFetchRecord = {
		id,
		url: input.url,
		title: input.title,
		text,
		extraction: input.extraction,
		createdAt: Date.now(),
	};
	upsertRecord(record);
	writeFetchToDiskCache(record);

	return { id, record, storedChars: text.length, truncatedForStore };
}

export function getFetchContent(id: string): StoredFetchRecord | null {
	const mem = store.get(id);
	if (mem) return mem;
	const disk = readFetchFromDiskCache(id);
	if (disk) upsertRecord(disk);
	return disk;
}

export function listFetchContent(): StoredFetchRecord[] {
	return [...store.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function clearFetchContentStore(): void {
	store.clear();
}

export function isValidStoredFetchPayload(data: unknown): data is StoredFetchRecord {
	if (!data || typeof data !== "object") return false;
	const d = data as Record<string, unknown>;
	return (
		typeof d.id === "string" &&
		d.id.length > 0 &&
		typeof d.url === "string" &&
		typeof d.text === "string" &&
		typeof d.extraction === "string" &&
		typeof d.createdAt === "number" &&
		(d.title === null || typeof d.title === "string")
	);
}

type SessionBranchEntry = {
	type: string;
	customType?: string;
	data?: unknown;
};

export type FetchSessionRestoreContext = {
	sessionManager: {
		getBranch: () => SessionBranchEntry[];
	};
};

/** Rebuild in-memory store from Pi session custom entries (resume / branch). */
export function restoreFetchContentFromSession(ctx: FetchSessionRestoreContext, options?: { ttlMs?: number }): number {
	const ttlMs = options?.ttlMs ?? SESSION_RESTORE_TTL_MS;
	const now = Date.now();
	store.clear();

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== FETCH_CONTENT_CUSTOM_TYPE) continue;
		if (!isValidStoredFetchPayload(entry.data)) continue;
		if (now - entry.data.createdAt > ttlMs) continue;
		upsertRecord(entry.data);
	}

	for (const record of loadAllFetchFromDiskCache()) {
		if (!store.has(record.id)) upsertRecord(record);
	}

	return store.size;
}

/** Characters returned inline from web_fetch before pointing at stored full text. */
export const WEB_FETCH_INLINE_MAX_CHARS = 30_000;
