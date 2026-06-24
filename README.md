# @heyhuynhgiabuu/pi-search

[![Version](https://img.shields.io/badge/dynamic/json?url=https://raw.githubusercontent.com/heyhuynhgiabuu/pi-search/main/package.json&query=%24.version&label=version&style=for-the-badge)](https://github.com/heyhuynhgiabuu/pi-search/blob/main/package.json)
[![CI](https://img.shields.io/github/actions/workflow/status/heyhuynhgiabuu/pi-search/ci.yml?branch=main&label=CI&style=for-the-badge)](https://github.com/heyhuynhgiabuu/pi-search/actions/workflows/ci.yml)
[![Versioning](https://img.shields.io/badge/versioning-Changesets-7C3AED?style=for-the-badge)](https://github.com/changesets/changesets)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

Five research tools for the Pi coding agent: `websearch`, `codesearch`, `context7`, `deepwiki`, `web_fetch`.

- **Zero-config by default** — works with no API key via the Exa MCP server
- **Full feature access when configured** — set `EXA_API_KEY` to unlock `searchType: deep`, `recencyFilter`, `domainFilter`, `highlights` etc. via direct REST
- **Disable any tool** you don't need via `disabledTools` config
- **Coded errors** for reliable model reasoning on failure
- **Streaming progress** for multi-query research

## Install

```bash
pi install npm:@heyhuynhgiabuu/pi-search
```

That's it. No API key required.

## Tools

| Tool | Purpose | When to use |
| --- | --- | --- |
| `websearch` | Search the open web | Default research tool. `recencyFilter: "day"` for sitreps. `domainFilter: ["reuters.com", "-reddit.com"]` to shape source set. `searchType: "deep"` for thorough coverage. |
| `codesearch` | Code/library search | Looking for API references, library patterns, implementation examples. |
| `context7` | Up-to-date library docs | Fetch current documentation for a library: `libraryName: "react"`, `topic: "hooks"`. |
| `deepwiki` | Ask about a public GitHub repo | `repo: "facebook/react"`, `question: "How does the reconciler work?"`. |
| `web_fetch` | Extract full text from a URL | Follow-up after `websearch` to read the best articles. |

## Configuration

Optional. Create `~/.pi/pi-search.json`:

```json
{
  "exaApiKey": "your-exa-api-key",
  "disabledTools": ["codesearch"],
  "mcpTimeoutMs": 30000
}
```

Or set environment variables:

```bash
export EXA_API_KEY=your-key
export PI_SEARCH_DISABLED_TOOLS=codesearch,deepwiki
export PI_SEARCH_USE_REST=true        # force direct REST (default: false; auto-enabled when EXA_API_KEY is set)
export PI_SEARCH_CONFIG_PATH=/path/to/config.json
```

Resolution order (highest priority first):
1. environment variables
2. `~/.pi/pi-search.json` (or `PI_SEARCH_CONFIG_PATH`)
3. defaults

## Direct REST vs MCP

`websearch` and `codesearch` choose their provider at execution time:

- If `EXA_API_KEY` is set (or `PI_SEARCH_USE_REST=true`), they call `https://api.exa.ai/search` directly. This unlocks the full Exa feature surface.
- Otherwise they fall back to `https://mcp.exa.ai/mcp` (the public MCP server, no key required). Feature set is narrower.

`context7`, `deepwiki`, and `web_fetch` always use their respective providers regardless.

## Architecture

```
src/
├── index.ts          # extension entrypoint, wires the 5 tools
├── config.ts         # env + ~/.pi/pi-search.json resolution
├── errors.ts         # coded errors (validation_error, mcp_error, …)
├── types.ts          # shared types
├── mcp/client.ts     # JSON-RPC 2.0 MCP client
├── exa/client.ts     # direct REST client for api.exa.ai
├── exa/params.ts     # parameter normalization
└── tools/            # one file per tool + shared citations.ts
```

See `AGENTS.md` for the change map.

## Development

```bash
make install        # npm ci
make check          # biome + tsc + vitest --coverage
make test           # vitest
make build          # tsc → dist/
make format         # biome format --write .
make lint           # biome lint
make typecheck      # tsc --noEmit
make release-dry-run
make version-packages
make release
```

## License

MIT
