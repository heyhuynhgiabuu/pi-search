# pi-search roadmap

This document tracks planned work. Architectural rationale lives in [`.pi/artifacts/DECISIONS.md`](../.pi/artifacts/DECISIONS.md).

**Positioning:** pi-search is the **coding-agent research** extension — Exa discovery (including deep search), library docs (Context7), public-repo Q&A (DeepWiki), and simple URL fetch. It is not a general multimedia web stack; see [Coexistence with pi-web-access](#coexistence-with-pi-web-access) in the README.

## Now (maintain)

- Keep five-tool surface stable; behavior changes stay in the narrowest module (`AGENTS.md` change map).
- `make check` (Biome, `tsc`, Vitest coverage) before release; Changesets for user-visible changes.
- Document overlap when users install multiple web extensions.

## Next (high value, in scope)

| Priority | Item | Outcome | Status |
| --- | --- | --- | --- |
| P1 | **Smarter `web_fetch`** | Readability + turndown; Jina Reader fallback on thin/consent HTML. | **Done** (0.2.5+) |
| P1 | **GitHub URL routing** | `github.com` repo / blob / tree / commit via GitHub REST API in `web_fetch`. | **Done** (0.2.5+) |
| P2 | **SSRF / proxy guard** | Block private/reserved IPs; optional `ssrf.allowRanges` in `~/.pi/pi-search.json`. | **Done** (0.2.5+) |
| P2 | **Large content retrieval** | `web_fetch` stores full body; inline cap 30k; **`get_fetch_content`** with `fetchId` / `list` / slice. | **Done** |
| P3 | **Optional search failover** | **`BRAVE_API_KEY`** / `braveApiKey` when Exa REST/MCP fails or returns no results. | **Done** |

## Later (explicit opt-in / separate concerns)

| Item | Notes |
| --- | --- |
| **X Docs MCP** | Remote `https://docs.x.com/mcp` (`search_x`, `get_page_x`) for X API documentation; no xurl/OAuth in pi-search. |
| **PDF extraction** | Text-only PDF in `web_fetch` (unpdf). | **Done** |
| **`websearch` + background fetch** | `includeContent: true` → up to 5 URLs stored for `get_fetch_content`. | **Done** |
| **Disk cache** | `~/.pi/pi-search-fetch-cache/` merged on session restore. | **Done** |
| **Synthesized answer mode** | Optional “answer + sources” layer on Exa results — off by default to preserve discovery-first behavior. |

## Out of scope (by design)

- Browser search **curator**, Gemini Web **cookie** auth, YouTube/local **video** understanding, OpenAI/Codex search as core tools.
- Full **X API MCP** via xurl stdio bridge — users should use Pi MCP config + [X MCP docs](https://docs.x.com/tools/mcp).
- Parity with [pi-web-access](https://github.com/nicobailon/pi-web-access) breadth; install that extension for general web + video + curation.

## Coexistence with pi-web-access

If both extensions are installed, disable overlapping tools in one package:

| pi-search | pi-web-access | Suggestion |
| --- | --- | --- |
| `websearch` | `web_search` | Keep pi-search for Exa deep modes + `codesearch`; disable `web_search` via `webSearch.enabled: false` in `~/.pi/web-search.json`, **or** add `websearch` to pi-search `disabledTools`. |
| `web_fetch` | `fetch_content` | Keep pi-web-access for rich fetch; add `web_fetch` to pi-search `disabledTools`. |
| `context7`, `codesearch`, `deepwiki` | — | Keep enabled on pi-search only. |

## How to propose changes

Open an issue or PR with: user-visible behavior, affected `src/tools/*` file, and whether README + Changeset are required.