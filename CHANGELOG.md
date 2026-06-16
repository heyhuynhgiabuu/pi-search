# Changelog

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
