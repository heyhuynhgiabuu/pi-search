---
"@heyhuynhgiabuu/pi-search": minor
---

### Added
- **`get_fetch_content`** — retrieve full text from `web_fetch` / `websearch` background fetches (`fetchId`, `list`, slices).
- **Rich `web_fetch`** — Readability/turndown, Jina fallback, GitHub API, PDF text (unpdf), SSRF guard, `llms.txt` on doc roots, optional `urlRewrites`.
- **Session + disk cache** — `appendEntry` restore (1h TTL) and `~/.pi/pi-search-fetch-cache/` (7d).
- **`websearch`** — `includeContent` (up to 5 URLs), Brave failover when Exa fails, Exa MCP block parser.

### Changed
- Brave API parity (query params, onboarding errors); optional Brave key from `~/.config/ketch/config.json`.
- GitHub API auth chain: `githubToken` / `GITHUB_TOKEN` / `GH_TOKEN` / `gh auth token`.
- Docs: roadmap, pi-web-access coexistence, Pi agent workflow.