# Changelog

All notable changes to HemSoft Buddy Extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- Current session stats in status bar, tooltip, and totals panel
- ESLint flat config with typescript-eslint for code quality
- Markdown linting with markdownlint-cli2
- Husky pre-commit hooks enforcing lint and markdown checks
- lint-staged for efficient staged-file-only linting

## [0.1.0] - 2026-03-01

### Added

- Initial scaffold with TypeScript, ESLint, and VS Code test infrastructure
- Custom codicon font pipeline (PNG → SVG → WOFF2) with `hs-buddy-icon`
- Status bar with live session data and Quick Pick context menu
- Copilot session tracker with real-time chatSessions JSONL parser
- Real API token counts (promptTokens, outputTokens) from chatSessions format
- Legacy transcript parser for old GitHub.copilot-chat format
- Incremental byte-offset parsing for efficient live file watching
- Polling-based watcher (2s interval) for both chatSessions and transcripts
- Session history browser, data export, and totals panel
- `HemSoft Buddy: Copilot Sessions` command and `Hello World` command
- Marketplace listing with icon, banner, badges, and roadmap
