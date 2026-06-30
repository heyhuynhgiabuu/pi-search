import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** ketch-style: config → GITHUB_TOKEN → GH_TOKEN → `gh auth token`. */
export async function resolveGithubToken(configured?: string): Promise<{ token: string | null; source: string }> {
	if (configured?.trim()) return { token: configured.trim(), source: "config" };
	const fromEnv = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
	if (fromEnv) return { token: fromEnv, source: "env" };
	try {
		const { stdout } = await execFileAsync("gh", ["auth", "token"], { timeout: 2000 });
		const t = stdout.trim();
		if (t) return { token: t, source: "gh-cli" };
	} catch {
		// gh not installed or not logged in
	}
	return { token: null, source: "none" };
}
