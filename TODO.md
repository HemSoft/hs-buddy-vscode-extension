# TODO

| Status | Priority | Task | Notes |
|--------|----------|------|-------|
| 📋 | High | [Add Explorer panel and extension icon](#add-explorer-panel-and-extension-icon) | Tree view in Activity Bar for session data |
| 📋 | High | [Fix status bar icon clipping](#fix-status-bar-icon-clipping) | Custom icon font glyph is cut off |

## Progress

- 0/2 done

---

## Remaining Items

### Add Explorer panel and extension icon

Register a `TreeDataProvider` and a `viewsContainers` / `views` contribution in `package.json` so the extension appears in the Activity Bar with its own icon and a dedicated Explorer panel. The panel should surface session data (totals, history) without requiring the Quick Pick menu.

Key steps:

1. Add `viewsContainers.activitybar` entry with an icon (SVG or icon font reference).
2. Add a `views` entry under that container.
3. Implement a `TreeDataProvider` in a new `src/sessionTreeProvider.ts`.
4. Register the provider in `extension.ts` activate.

### Fix status bar icon clipping

The custom icon font glyph (`hs-buddy-icon`, char `\EA01`) renders cut off in the status bar. Investigate:

1. Glyph metrics in the WOFF2 font — ascent, descent, and advance width may not leave enough padding.
2. The `codemap.json` mapping and whether the codepoint is correct.
3. Consider switching to a built-in Codicon (e.g., `$(hubot)`) as a fallback if the custom font can't be fixed cleanly.
4. Test on multiple platforms / DPI scales.
