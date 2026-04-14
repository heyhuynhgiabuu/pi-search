# pi-search

[![npm version](https://img.shields.io/npm/v/@heyhuynhgiabuu/pi-search)](https://www.npmjs.com/package/@heyhuynhgiabuu/pi-search)

`pi-search` is a standalone [pi](https://pi.dev) extension that bundles the search and research tools you reach for most often into one package.

It combines:
- real-time **web search** via Exa AI
- **code and API search** via Exa AI's code index
- **official documentation lookup** via Context7
- **real-world GitHub code search** via grep.app

The goal is simple: install one extension and get a practical research toolkit for current docs, code examples, library references, and production usage patterns.

## Tools

| Tool | Source | Description |
|------|--------|-------------|
| **`grepsearch`** | [grep.app](https://grep.app) | Search real-world code on GitHub. Use literal patterns like `"useState("`, not keywords. |
| **`websearch`** | [Exa AI](https://exa.ai) | Real-time web search. No API key required. |
| **`codesearch`** | [Exa AI](https://exa.ai) | Code-specific doc/example search. No API key required. |
| **`context7`** | [Context7](https://context7.com) | Resolve library IDs and fetch library documentation. Optional `CONTEXT7_API_KEY` for higher rate limits. |

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

## Usage

```ts
grepsearch({ query: "getServerSession", language: "TypeScript" })
websearch({ query: "Next.js 15 server actions" })
codesearch({ query: "Go context.WithCancel usage" })
context7({ operation: "resolve", libraryName: "react" })
context7({ operation: "query", libraryId: "/reactjs/react.dev", topic: "hooks" })
```

## When to use which tool

- `websearch` → current information, blog posts, docs, release notes, discussions
- `codesearch` → programming docs, API examples, framework usage
- `context7` → official library documentation after resolving the right library ID
- `grepsearch` → how real repositories use an API in practice

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
```

## License

MIT — [huynhgiabuu](https://github.com/buddingnewinsights)
