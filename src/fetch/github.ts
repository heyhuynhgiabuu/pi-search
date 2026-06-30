import { FetchError } from "../errors.js";
import { fetchError } from "./errors.js";

export type ParsedGitHubUrl =
	| { kind: "repo"; owner: string; repo: string }
	| { kind: "tree"; owner: string; repo: string; ref: string; path: string }
	| { kind: "blob"; owner: string; repo: string; ref: string; path: string }
	| { kind: "commit"; owner: string; repo: string; sha: string };

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

export function parseGitHubUrl(url: URL): ParsedGitHubUrl | null {
	if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return null;
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length < 2) return null;
	const [owner, repo, ...rest] = parts;
	if (!owner || !repo) return null;
	if (rest[0] === "tree" && rest.length >= 3) {
		const ref = rest[1];
		const path = rest.slice(2).join("/");
		return { kind: "tree", owner, repo, ref, path };
	}
	if (rest[0] === "blob" && rest.length >= 3) {
		const ref = rest[1];
		const path = rest.slice(2).join("/");
		return { kind: "blob", owner, repo, ref, path };
	}
	if (rest[0] === "commit" && rest[1]) {
		return { kind: "commit", owner, repo, sha: rest[1] };
	}
	if (rest.length === 0) {
		return { kind: "repo", owner, repo };
	}
	return null;
}

export async function fetchGitHubContent(
	parsed: ParsedGitHubUrl,
	options: { signal?: AbortSignal; timeoutMs: number; githubToken?: string },
): Promise<{ text: string; title: string; github: ParsedGitHubUrl }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;

	try {
		switch (parsed.kind) {
			case "repo":
				return await fetchRepoRoot(parsed, signal, options.githubToken);
			case "blob":
				return await fetchBlob(parsed, signal, options.githubToken);
			case "tree":
				return await fetchTree(parsed, signal, options.githubToken);
			case "commit":
				return await fetchCommit(parsed, signal, options.githubToken);
		}
	} catch (err) {
		if (err instanceof FetchError) throw err;
		if (err instanceof Error && err.name === "AbortError") {
			throw fetchError("fetch_timeout", "GitHub API timed out", { owner: parsed.owner, repo: parsed.repo });
		}
		const message = err instanceof Error ? err.message : String(err);
		throw fetchError("fetch_error", `GitHub fetch failed: ${message}`, { owner: parsed.owner, repo: parsed.repo });
	} finally {
		clearTimeout(timeout);
	}
}

async function ghGet(path: string, signal: AbortSignal, githubToken?: string): Promise<Response> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": "pi-search",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
	const response = await fetch(`https://api.github.com${path}`, { headers, signal });
	return response;
}

async function fetchRepoRoot(
	parsed: Extract<ParsedGitHubUrl, { kind: "repo" }>,
	signal: AbortSignal,
	githubToken?: string,
): Promise<{ text: string; title: string; github: ParsedGitHubUrl }> {
	const { owner, repo } = parsed;
	const metaRes = await ghGet(`/repos/${owner}/${repo}`, signal, githubToken);
	if (!metaRes.ok) {
		throw fetchError("fetch_error", `GitHub API HTTP ${metaRes.status}`, { url: `repos/${owner}/${repo}` });
	}
	const meta = (await metaRes.json()) as { default_branch?: string; description?: string | null };
	const branch = meta.default_branch ?? "main";

	let text = `# ${owner}/${repo}\n\n`;
	if (meta.description) text += `${meta.description}\n\n`;

	const readmeRes = await ghGet(`/repos/${owner}/${repo}/readme`, signal, githubToken);
	if (readmeRes.ok) {
		const readme = (await readmeRes.json()) as { content?: string; encoding?: string };
		if (readme.encoding === "base64" && readme.content) {
			const decoded = Buffer.from(readme.content.replace(/\n/g, ""), "base64").toString("utf-8");
			text += `## README (${branch})\n\n${decoded}`;
		}
	} else {
		const treeRes = await ghGet(`/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, signal, githubToken);
		if (treeRes.ok) {
			const tree = (await treeRes.json()) as { tree?: Array<{ path?: string; type?: string }> };
			const paths = (tree.tree ?? [])
				.filter((t): t is { path: string; type?: string } => t.type === "blob" && typeof t.path === "string")
				.map((t) => t.path)
				.slice(0, 80);
			text += `## Tree (${branch}, first ${paths.length} files)\n\n${paths.map((p) => `- ${p}`).join("\n")}`;
		}
	}

	return { text: text.trim(), title: `${owner}/${repo}`, github: parsed };
}

async function fetchBlob(
	parsed: Extract<ParsedGitHubUrl, { kind: "blob" }>,
	signal: AbortSignal,
	githubToken?: string,
): Promise<{ text: string; title: string; github: ParsedGitHubUrl }> {
	const { owner, repo, ref, path } = parsed;
	const res = await ghGet(
		`/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
		signal,
		githubToken,
	);
	if (!res.ok) {
		throw fetchError("fetch_error", `GitHub API HTTP ${res.status}`, { path });
	}
	const data = (await res.json()) as { content?: string; encoding?: string; name?: string };
	if (data.encoding !== "base64" || !data.content) {
		throw fetchError("fetch_error", "GitHub content is not a text file", { path });
	}
	const decoded = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf-8");
	const title = data.name ?? path;
	const text = `# ${owner}/${repo}/${path} @ ${ref}\n\n\`\`\`\n${decoded}\n\`\`\``;
	return { text, title, github: parsed };
}

async function fetchTree(
	parsed: Extract<ParsedGitHubUrl, { kind: "tree" }>,
	signal: AbortSignal,
	githubToken?: string,
): Promise<{ text: string; title: string; github: ParsedGitHubUrl }> {
	const { owner, repo, ref, path } = parsed;
	const apiPath = path
		? `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`
		: `/repos/${owner}/${repo}/contents?ref=${encodeURIComponent(ref)}`;
	const res = await ghGet(apiPath, signal, githubToken);
	if (!res.ok) {
		throw fetchError("fetch_error", `GitHub API HTTP ${res.status}`, { path: apiPath });
	}
	const data = await res.json();
	const entries = Array.isArray(data) ? data : [data];
	const lines = entries.map(
		(e: { name?: string; type?: string }) => `- ${e.type === "dir" ? "[dir]" : "[file]"} ${e.name ?? "?"}`,
	);
	const text = `# ${owner}/${repo}/${path || ""} @ ${ref}\n\n${lines.join("\n")}`;
	return { text, title: `${owner}/${repo}`, github: parsed };
}

async function fetchCommit(
	parsed: Extract<ParsedGitHubUrl, { kind: "commit" }>,
	signal: AbortSignal,
	githubToken?: string,
): Promise<{ text: string; title: string; github: ParsedGitHubUrl }> {
	const { owner, repo, sha } = parsed;
	const res = await ghGet(`/repos/${owner}/${repo}/commits/${sha}`, signal, githubToken);
	if (!res.ok) {
		throw fetchError("fetch_error", `GitHub API HTTP ${res.status}`, { sha });
	}
	const data = (await res.json()) as {
		commit?: { message?: string; author?: { date?: string } };
		html_url?: string;
	};
	const message = data.commit?.message ?? "";
	const text = `# Commit ${sha.slice(0, 7)} — ${owner}/${repo}\n\n${message}\n\n${data.html_url ?? ""}`.trim();
	return { text, title: `commit ${sha.slice(0, 7)}`, github: parsed };
}
