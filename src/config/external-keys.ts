import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Optional: reuse Brave key from ketch (~/.config/ketch/config.json). */
export function readKetchBraveApiKey(homeDir = homedir()): string | undefined {
	const path = join(homeDir, ".config", "ketch", "config.json");
	if (!existsSync(path)) return undefined;
	try {
		const data = JSON.parse(readFileSync(path, "utf-8")) as { brave_api_key?: unknown };
		return typeof data.brave_api_key === "string" && data.brave_api_key.trim() ? data.brave_api_key.trim() : undefined;
	} catch {
		return undefined;
	}
}
