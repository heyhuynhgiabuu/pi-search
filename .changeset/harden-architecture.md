---
"@heyhuynhgiabuu/pi-search": minor
---

Major architecture hardening: split the monolithic `src/index.ts` into focused modules (`config`, `errors`, `types`, `mcp/client`, `exa/client`, `exa/params`, `tools/*`), adopt coded errors (`validation_error`, `config_error`, `provider_error`, `mcp_error`, `mcp_timeout`, `mcp_unavailable`, `fetch_error`, etc.), add streaming progress via `onUpdate` for multi-step tools, and add per-tool DI tests with coverage thresholds.

New: `websearch` and `codesearch` now use direct REST `https://api.exa.ai/search` when `EXA_API_KEY` is set, unlocking the full Exa capability surface (`searchType: auto|neural|instant|deep|deep-reasoning|deep-max`, `recencyFilter: day|week|month|year`, `startPublishedDate`/`endPublishedDate`, `includeDomains`/`excludeDomains`/`domainFilter` with `-` prefix, configurable `highlightsMaxCharacters`). MCP path is kept as a zero-config fallback.

DX: added `Makefile` (mirrors npm scripts), `AGENTS.md` change map, GitHub Actions CI (biome + tsc + vitest with coverage), and Changesets for versioned changelog.
