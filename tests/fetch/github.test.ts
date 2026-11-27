import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGitHubContent, parseGitHubUrl } from "../../src/fetch/github.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("parseGitHubUrl", () => {
	it("parses repo root", () => {
		expect(parseGitHubUrl(new URL("https://github.com/facebook/react"))).toEqual({
			kind: "repo",
			owner: "facebook",
			repo: "react",
		});
	});

	it("parses blob", () => {
		expect(parseGitHubUrl(new URL("https://github.com/o/r/blob/main/src/index.ts"))).toEqual({
			kind: "blob",
			owner: "o",
			repo: "r",
			ref: "main",
			path: "src/index.ts",
		});
	});

	it("returns null for non-GitHub", () => {
		expect(parseGitHubUrl(new URL("https://example.com"))).toBeNull();
	});

	it("fetches commit even when unread author field has unexpected type", async () => {
		globalThis.fetch = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					commit: { message: "fix: bug", author: { date: 12345 } },
					html_url: "https://github.com/o/r/commit/abc1234",
				}),
				{ status: 200 },
			),
		);

		const out = await fetchGitHubContent(
			{ kind: "commit", owner: "o", repo: "r", sha: "abc1234" },
			{ timeoutMs: 5000 },
		);

		expect(out.text).toContain("fix: bug");
	});
});
