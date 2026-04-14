# pi-search

[![npm version](https://img.shields.io/npm/v/@heyhuynhgiabuu/pi-search)](https://www.npmjs.com/package/@heyhuynhgiabuu/pi-search)

A [pi](https://pi.dev) extension that adds web search, code search, and GitHub code grep — three tools in one package.

## Tools

| Tool | Source | Description |
|------|--------|-------------|
| **`grepsearch`** | [grep.app](https://grep.app) | Search real-world code on GitHub. Use literal patterns like `"useState("`, not keywords. |
| **`websearch`** | [Exa AI](https://exa.ai) | Real-time web search. No API key required. |
| **`codesearch`** | [Exa AI](https://exa.ai) | Code-specific doc/example search. No API key required. |

## Install

```bash
pi install npm:@heyhuynhgiabuu/pi-search
```

Or load locally:

```bash
pi -e ./src/index.ts
```

## Usage

```
grepsearch({ query: "getServerSession", language: "TypeScript" })
websearch({ query: "Next.js 15 server actions" })
codesearch({ query: "Go context.WithCancel usage" })
```

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
```

## License

MIT — [huynhgiabuu](https://github.com/buddingnewinsights)
