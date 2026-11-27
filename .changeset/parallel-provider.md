---
"@heyhuynhgiabuu/pi-search": minor
---

Add Parallel (`api.parallel.ai`) as an optional `websearch` provider. Set `PARALLEL_API_KEY` / `parallelApiKey` and optionally `PI_SEARCH_PROVIDER` / `searchProvider` (`exa` | `parallel`). Exa stays the default when `EXA_API_KEY` is set; Brave failover applies to both. `codesearch` still uses Exa.
