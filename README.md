# pi-search

[![npm version](https://img.shields.io/npm/v/@heyhuynhgiabuu/pi-search)](https://www.npmjs.com/package/@heyhuynhgiabuu/pi-search)

`pi-search` is a standalone [pi](https://pi.dev) extension that bundles the search and research tools you reach for most often into one package.

It combines:
- real-time **web search** via Exa AI
- **technical docs and API search** via Exa AI web search
- **official documentation lookup** via Context7
- **public repository documentation and Q&A** via DeepWiki
- **structured source citations** on Exa-backed retrieval tools

The goal is simple: install one extension and get a practical research toolkit for current docs, code examples, library references, and repository architecture.

## Tools

| Tool | Source | Description |
|------|--------|-------------|
| **`websearch`** | [Exa AI](https://exa.ai) | Real-time web search. No API key required. |
| **`codesearch`** | [Exa AI](https://exa.ai) | Technical doc/example search tuned for programming queries and powered by Exa web search. No API key required. |
| **`context7`** | [Context7](https://context7.com) | Resolve library IDs and fetch library documentation. Optional `CONTEXT7_API_KEY` for higher rate limits. |
| **`deepwiki`** | [DeepWiki](https://docs.devin.ai/work-with-devin/deepwiki-mcp) | Read generated docs and ask repo-grounded questions for public GitHub repositories. No API key required. |
| **`web_fetch`** | [Exa AI](https://exa.ai) | Fetch a webpage's full content as clean markdown. Use after `websearch`/`codesearch` to read a specific result. |

## Install

```bash
pi install npm:@heyhuynhgiabuu/pi-search
```

Or load locally during development:

```bash
pi -e ./src/index.ts
```

Optional for higher Context7 rate limits:

```bash
export CONTEXT7_API_KEY=your_key_here
```

## Configuration

Create `~/.pi/agent/pi-search.json` to customize the extension.

### Disable specific tools

```json
{
  "disabledTools": ["context7", "codesearch"]
}
```

Valid tool names: `websearch`, `codesearch`, `context7`, `deepwiki`, `web_fetch`.

If the file doesn't exist or is invalid JSON, all tools are enabled by default.

## Usage

```ts
websearch({ query: "Next.js 15 server actions" })
codesearch({ query: "Go context.WithCancel usage" })
context7({ operation: "resolve", libraryName: "react" })
context7({ operation: "query", libraryId: "/reactjs/react.dev", topic: "hooks" })
deepwiki({ operation: "ask", repo: "facebook/react", question: "How does reconciliation work?" })
```

## When to use which tool

- `websearch` → current information, blog posts, docs, release notes, discussions
- `codesearch` → programming docs, API examples, framework usage, and technical references
- `context7` → official library documentation after resolving the right library ID
- `deepwiki` → generated documentation and Q&A for public GitHub repositories

## DeepWiki limitations

`deepwiki` uses Devin's public, no-auth DeepWiki MCP endpoint. It only supports public GitHub repositories. Treat results as generated documentation that can be incomplete or stale; use the repository source for exact code truth.

## Citations

`websearch`, `codesearch`, and `web_fetch` return source metadata in `details.citations` when source URLs are available. Their text output also includes a `## Sources` section with numbered source markers so the model can see the same source IDs that are exposed as structured metadata.

Important limitation: these citations are attached to individual tool results. They do **not** prove which sources a final assistant response used unless the Pi host/runtime links assistant messages to tool calls and tool result details.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
```

## License

MIT — [huynhgiabuu](https://github.com/buddingnewinsights)
