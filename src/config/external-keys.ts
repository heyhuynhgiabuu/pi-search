import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compile, obj, opt, str } from "@earendil-works/pi-schema";

const KetchConfigSchema = obj({ brave_api_key: opt(str()) }, { open: true });

const ketchConfigValidator = compile(KetchConfigSchema);

/** Optional: reuse Brave key from ketch (~/.config/ketch/config.json). */
export function readKetchBraveApiKey(homeDir = homedir()): string | undefined {
	const path = join(homeDir, ".config", "ketch", "config.json");

	if (!existsSync(path)) return undefined;

	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));

		if (!ketchConfigValidator.check(raw)) return undefined;
		const key = raw.brave_api_key?.trim();

		return key ? key : undefined;
	} catch {
		return undefined;
	}
}
