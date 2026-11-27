import { arr, compile, nullable, obj, opt, str, union, unknown } from "@earendil-works/pi-schema";
import { FetchError } from "../errors.js";
import { fetchError } from "./errors.js";

const stringValidator = compile(str());

const GitHubRepoMetaSchema = obj(
	{
		default_branch: opt(unknown()),
		description: opt(unknown()),
	},
	{ open: true },
);

const gitHubRepoMetaValidator = compile(GitHubRepoMetaSchema);

const GitHubContentFileSchema = obj(
	{
		content: opt(unknown()),
		encoding: opt(unknown()),
		name: opt(unknown()),
	},
	{ open: true },
);

const gitHubContentFileValidator = compile(GitHubContentFileSchema);

const GitHubTreeEntrySchema = obj(
	{
		path: opt(unknown()),
		type: opt(unknown()),
	},
	{ open: true },
);

const GitHubTreeResponseSchema = obj(
	{
		tree: opt(nullable(arr(GitHubTreeEntrySchema))),
	},
	{ open: true },
);

const gitHubTreeResponseValidator = compile(GitHubTreeResponseSchema);

const GitHubDirEntrySchema = obj(
	{
		name: opt(unknown()),
		type: opt(unknown()),
	},
	{ open: true },
);

const GitHubDirEntriesSchema = union([GitHubDirEntrySchema, arr(GitHubDirEntrySchema)]);

const gitHubDirEntriesValidator = compile(GitHubDirEntriesSchema);

const GitHubCommitSchema = obj(
	{
		commit: opt(
			nullable(
				obj(
					{
						message: opt(unknown()),
					},
					{ open: true },
				),
			),
		),
		html_url: opt(unknown()),
	},
	{ open: true },
);

const gitHubCommitValidator = compile(GitHubCommitSchema);

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
	const headers = new Headers({
		Accept: "application/vnd.github+json",
		"User-Agent": "pi-search",
		"X-GitHub-Api-Version": "2022-11-28",
	});

	if (githubToken) headers.set("Authorization", `Bearer ${githubToken}`);

	return fetch(`https://api.github.com${path}`, { headers, signal });
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

	const metaRaw: unknown = await metaRes.json();

	if (!gitHubRepoMetaValidator.check(metaRaw)) {
		throw fetchError("fetch_error", "Unexpected GitHub repository response", { owner, repo });
	}

	const branch =
		stringValidator.check(metaRaw.default_branch) && metaRaw.default_branch ? metaRaw.default_branch : "main";

	let text = `# ${owner}/${repo}\n\n`;

	if (stringValidator.check(metaRaw.description) && metaRaw.description) text += `${metaRaw.description}\n\n`;

	const readmeRes = await ghGet(`/repos/${owner}/${repo}/readme`, signal, githubToken);

	if (readmeRes.ok) {
		const readmeRaw: unknown = await readmeRes.json();

		if (
			gitHubContentFileValidator.check(readmeRaw) &&
			readmeRaw.encoding === "base64" &&
			stringValidator.check(readmeRaw.content) &&
			readmeRaw.content
		) {
			const decoded = Buffer.from(readmeRaw.content.replace(/\n/g, ""), "base64").toString("utf-8");
			text += `## README (${branch})\n\n${decoded}`;
		}
	} else {
		const treeRes = await ghGet(`/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, signal, githubToken);

		if (treeRes.ok) {
			const treeRaw: unknown = await treeRes.json();

			if (gitHubTreeResponseValidator.check(treeRaw)) {
				const paths: string[] = [];

				for (const entry of treeRaw.tree ?? []) {
					if (entry.type === "blob" && stringValidator.check(entry.path)) {
						paths.push(entry.path);

						if (paths.length >= 80) break;
					}
				}

				text += `## Tree (${branch}, first ${paths.length} files)\n\n${paths.map((p) => `- ${p}`).join("\n")}`;
			}
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

	const data: unknown = await res.json();

	if (
		!gitHubContentFileValidator.check(data) ||
		data.encoding !== "base64" ||
		!stringValidator.check(data.content) ||
		!data.content
	) {
		throw fetchError("fetch_error", "GitHub content is not a text file", { path });
	}

	const decoded = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf-8");
	const title = stringValidator.check(data.name) ? data.name : path;
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

	const data: unknown = await res.json();

	if (!gitHubDirEntriesValidator.check(data)) {
		throw fetchError("fetch_error", "Unexpected GitHub directory response", { path: apiPath });
	}

	const entries = Array.isArray(data) ? data : [data];

	const lines = entries.map(
		(e) => `- ${e.type === "dir" ? "[dir]" : "[file]"} ${stringValidator.check(e.name) ? e.name : "?"}`,
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

	const data: unknown = await res.json();

	if (!gitHubCommitValidator.check(data)) {
		throw fetchError("fetch_error", "Unexpected GitHub commit response", { sha });
	}

	const message = stringValidator.check(data.commit?.message) ? data.commit.message : "";
	const htmlUrl = stringValidator.check(data.html_url) ? data.html_url : "";
	const text = `# Commit ${sha.slice(0, 7)} — ${owner}/${repo}\n\n${message}\n\n${htmlUrl}`.trim();

	return { text, title: `commit ${sha.slice(0, 7)}`, github: parsed };
}
