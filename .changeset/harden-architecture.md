---
"@heyhuynhgiabuu/pi-search": patch
---

Architecture hardening + TUI rendering: split the monolithic `src/index.ts` into focused modules (`config`, `errors`, `types`, `mcp/client`, `exa/client`, `exa/params`, `tools/*`), adopt coded errors (`validation_error`, `config_error`, `provider_error`, `mcp_error`, `mcp_timeout`, `mcp_unavailable`, `fetch_error`, etc.), add streaming progress via `onUpdate` for multi-step tools, add per-tool DI tests with coverage thresholds, and ship a per-tool `renderResult` for the host's TUI (collapsed preview by default, full content on Ctrl+O, themed via the host's `Theme`).

`websearch` and `codesearch` now use direct REST `https://api.exa.ai/search` when `EXA_API_KEY` is set, unlocking the full Exa capability surface (`searchType: auto|neural|instant|deep|deep-reasoning|deep-max`, `recencyFilter: day|week|month|year`, `startPublishedDate`/`endPublishedDate`, `includeDomains`/`excludeDomains`/`domainFilter` with `-` prefix, configurable `highlightsMaxCharacters`). MCP path is kept as a zero-config fallback.

DX: added `Makefile` (mirrors npm scripts), `AGENTS.md` change map, GitHub Actions CI (biome + tsc + vitest with coverage), and Changesets for versioned changelog.

TUI work adapted from PR #1 by x4cc3 (earendil fork) — ported to the mainline `@mariozechner/pi-coding-agent` + `pi-tui` APIs so no extra peer deps are required.

Public API is unchanged — same five tools (`websearch`, `codesearch`, `context7`, `deepwiki`, `web_fetch`), same env/file resolution, same `disabledTools` config key. Bumping patch because no user-facing behavior changed.
