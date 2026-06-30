import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StoredFetchRecord } from "./content-store.js";
import { isValidStoredFetchPayload } from "./content-store.js";

const CACHE_DIR = join(homedir(), ".pi", "pi-search-fetch-cache");
const DISK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DISK_FILES = 200;

function cachePath(id: string): string {
	const safe = id.replace(/[^a-f0-9]/gi, "");
	return join(CACHE_DIR, `${safe}.json`);
}

export function getFetchDiskCacheDir(): string {
	return CACHE_DIR;
}

export function writeFetchToDiskCache(record: StoredFetchRecord): void {
	mkdirSync(CACHE_DIR, { recursive: true });
	writeFileSync(cachePath(record.id), JSON.stringify(record), "utf-8");
	pruneDiskCache();
}

export function readFetchFromDiskCache(id: string): StoredFetchRecord | null {
	try {
		const raw = readFileSync(cachePath(id), "utf-8");
		const data = JSON.parse(raw) as unknown;
		if (!isValidStoredFetchPayload(data)) return null;
		if (Date.now() - data.createdAt > DISK_TTL_MS) {
			try {
				unlinkSync(cachePath(id));
			} catch {
				// ignore
			}
			return null;
		}
		return data;
	} catch {
		return null;
	}
}

export function loadAllFetchFromDiskCache(): StoredFetchRecord[] {
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		const now = Date.now();
		const out: StoredFetchRecord[] = [];
		for (const name of readdirSync(CACHE_DIR)) {
			if (!name.endsWith(".json")) continue;
			const id = name.slice(0, -5);
			const record = readFetchFromDiskCache(id);
			if (record && now - record.createdAt <= DISK_TTL_MS) out.push(record);
		}
		return out.sort((a, b) => b.createdAt - a.createdAt);
	} catch {
		return [];
	}
}

function pruneDiskCache(): void {
	try {
		const files = readdirSync(CACHE_DIR)
			.filter((n) => n.endsWith(".json"))
			.map((n) => {
				const p = join(CACHE_DIR, n);
				return { p, mtime: statSync(p).mtimeMs };
			})
			.sort((a, b) => a.mtime - b.mtime);
		while (files.length > MAX_DISK_FILES) {
			const oldest = files.shift();
			if (oldest)
				try {
					unlinkSync(oldest.p);
				} catch {
					// ignore
				}
		}
	} catch {
		// ignore
	}
}

export function diskCacheKeyForUrl(url: string): string {
	return createHash("sha256").update(url).digest("hex").slice(0, 24);
}

/** Wipe disk cache files (tests). */
export function clearFetchDiskCache(): void {
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		for (const name of readdirSync(CACHE_DIR)) {
			if (name.endsWith(".json"))
				try {
					unlinkSync(join(CACHE_DIR, name));
				} catch {
					// ignore
				}
		}
	} catch {
		// ignore
	}
}
