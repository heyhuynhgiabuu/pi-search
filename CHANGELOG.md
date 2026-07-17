# Changelog

## 0.3.0

### Minor Changes

- Add optional native `firecrawl_scrape` and `firecrawl_crawl` tools

  Adds Firecrawl REST client at `src/firecrawl/client.ts` with bearer auth, injected fetch seam, and provider error mapping. Exposes two new tools:

  - `firecrawl_scrape` — scrape a URL via Firecrawl v2, returns stored content
  - `firecrawl_crawl` — async crawl via Firecrawl v2 with polling, pagination, cancellation, and stored results

  Configuration via `FIRECRAWL_API_KEY` env var or `firecrawlApiKey` in `~/.pi/pi-search.json`. Error codes: `firecrawl_auth_error` (401/403), `firecrawl_rate_limited` (429), `firecrawl_timeout` (crawl timeout).

  ### Changes

  - **firecrawl_scrape**: defaults `onlyMainContent` to `true` and `formats` to `['markdown']`; validates URLs are http/https; passes `AbortSignal` for cancellation.
  - **firecrawl_crawl**: accepts `onUpdate` callback for progress; follows pagination via `next` URLs (absolute, origin-validated) instead of re-polling by ID; persists content store records via `pi.appendEntry`; passes `AbortSignal` to all fetches; attempts remote DELETE cancellation on user abort and timeout (with bounded signal for the DELETE call); defaults `maxPages` to 5 (max 20).
  - **Client**: validates all API responses from `unknown` with manual type guards (no `as T`); validates pagination URLs belong to the Firecrawl API origin; passes `AbortSignal` through all request methods.

## 0.2.7 - 2026-07-13

### Patch Changes

- Prefix tool titles with `⚙` icon with theme-aware dim expand/collapse keybinding hints across all tools. Fix the DeepWiki `ask_question` request to use its required `repoName` argument.

## 0.2.6 - 2026-07-01

### Fixed

- **context7:** Docs URL uses `type=txt`; responses are Markdown/plain text. `fetchDocs()`
  reads text and JSON-parses only when appropriate (fixes `Unexpected token '#'` on `###` headings).
- **Tool result TUI:** Markdown ANSI resets no longer clear `toolSuccessBg` mid-line
  (`preserveBoxBackground` in `render.ts`).

### Changed

- **Pi 0.80 alignment:** peers and devDependencies use
  `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` ^0.80.0.
- All extension imports updated from `@mariozechner/*` to `@earendil-works/*`.
- Dev/CI tests now resolve against the same host stack as Pi 0.80.x.
- **Tool result TUI:** `websearch`, `web_fetch`, `context7`, and `deepwiki` wrap Markdown in a
  `Box` with `setBgFn(theme.bg("toolSuccessBg"))` for full terminal-width panel background.
- Collapsed preview hint: `ctrl+o to expand` (lowercase).

## 0.2.5

### Minor Changes

- 68243df: ### Added

  - **`get_fetch_content`** — retrieve full text from `web_fetch` / `websearch` background fetches (`fetchId`, `list`, slices).
  - **Rich `web_fetch`** — Readability/turndown, Jina fallback, GitHub API, PDF text (unpdf), SSRF guard, `llms.txt` on doc roots, optional `urlRewrites`.
  - **Session + disk cache** — `appendEntry` restore (1h TTL) and `~/.pi/pi-search-fetch-cache/` (7d).
  - **`websearch`** — `includeContent` (up to 5 URLs), Brave failover when Exa fails, Exa MCP block parser.

  ### Changed

  - Brave API parity (query params, onboarding errors); optional Brave key from `~/.config/ketch/config.json`.
  - GitHub API auth chain: `githubToken` / `GITHUB_TOKEN` / `GH_TOKEN` / `gh auth token`.
  - Docs: roadmap, pi-web-access coexistence, Pi agent workflow.

## 0.2.4

### Patch Changes

- a729bb9: Architecture hardening: split the monolithic `src/index.ts` into focused modules (`config`, `errors`, `types`, `mcp/client`, `exa/client`, `exa/params`, `tools/*`), adopt coded errors (`validation_error`, `config_error`, `provider_error`, `mcp_error`, `mcp_timeout`, `mcp_unavailable`, `fetch_error`, etc.), add streaming progress via `onUpdate` for multi-step tools, and add per-tool DI tests with coverage thresholds.

  `websearch` and `codesearch` now use direct REST `https://api.exa.ai/search` when `EXA_API_KEY` is set, unlocking the full Exa capability surface (`searchType: auto|neural|instant|deep|deep-reasoning|deep-max`, `recencyFilter: day|week|month|year`, `startPublishedDate`/`endPublishedDate`, `includeDomains`/`excludeDomains`/`domainFilter` with `-` prefix, configurable `highlightsMaxCharacters`). MCP path is kept as a zero-config fallback.

  DX: added `Makefile` (mirrors npm scripts), `AGENTS.md` change map, GitHub Actions CI (biome + tsc + vitest with coverage), and Changesets for versioned changelog.

  Public API is unchanged — same five tools (`websearch`, `codesearch`, `context7`, `deepwiki`, `web_fetch`), same env/file resolution, same `disabledTools` config key. Bumping patch because no user-facing behavior changed.

## [0.2.3] - 2026-06-16

### Removed

- **grepsearch tool** — grep.app is behind Vercel Security Checkpoint (JS challenge),
  making it permanently unavailable for programmatic access. Removed the tool registration,
  all grep.app API code, browser header workarounds, retry logic, and cache infrastructure.

### Added

- **deepwiki integration** — documentation and Q&A for public GitHub repositories.

### Fixed

- Cleaned up stale references to grep.app/grepsearch in module comments, type definitions,
  and documentation.
