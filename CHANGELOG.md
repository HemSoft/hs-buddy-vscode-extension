# Changelog

All notable changes to HemSoft Buddy Extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- **Copilot Dashboard** — rich webview panel with SVG bar charts, turn timeline, tool breakdown, model usage, and cost estimation
- Dashboard command (`hs-buddy.showDashboard`) accessible from Command Palette and Quick Pick menu
- Auto-refreshing dashboard that updates on new session data via `onDidUpdate` event
- Current session stats in status bar, tooltip, and totals panel
- Strict type-checked ESLint config (`strictTypeChecked` + `stylisticTypeChecked`)
- Markdown linting with markdownlint-cli2
- Husky pre-commit hooks with `tsc --noEmit` and lint-staged
- lint-staged for efficient staged-file-only linting
- Knip dead code detection with unused export and dependency tracking

### Changed

- Upgraded typescript-eslint from `recommended` to `strictTypeChecked` + `stylisticTypeChecked`
- Typed all `JSON.parse` results with explicit interfaces to eliminate unsafe-any errors
- Replaced `.match()` with `RegExp#exec()` per strict lint rules
- Used nullish coalescing (`??=`) and optional chaining where appropriate

### Removed

- Dead code: unused exports (`enrichSessionsFromStore`, `getWorkspacePath`, `extractModelFromInteractiveSession`, `parseChatSessionFile`, `parseTranscriptFile`, `estimateTokensFromChars`)
- Unused type interfaces (`SessionStoreEntry`, `InteractiveSessionEntry`, `ChatSessionParseResult`)
- Unused devDependencies (`@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`)

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
