# Changelog

All notable changes to AI Context Runner are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [2.3.0] — 2026-04-28

### Added

- `createdAt` field — set once on context creation, never modified by subsequent saves.
- `lastUsed` field — automatically updated on every `saveContext` call; no manual tracking needed.
- `AI: Clean Up Contexts` command — scans all contexts, flags orphans (root path missing on
  disk) with ⚠, pre-selects them, shows last-used age for all. Multi-select then
  choose Archive or Delete permanently.
- `AI: Restore Archived Context` command — lists `~/.ai-context/archive/` with last-used
  and created timestamps; restores selected context back to active store.
- Archive action moves context to `~/.ai-context/archive/` (recoverable) instead of
  permanent delete. Timestamp suffix prevents overwriting an existing archive entry.
- `AI: Set Active Context`, `AI: View Context`, `AI: Delete Context` pickers now show
  `last used` and `created` age in the detail line.

### Fixed

- `createdAt` and `root` are now explicitly preserved in `runTask` after AI response —
  both fields are exempt from AI modification.

---

## [2.2.0] — 2026-04-28

### Fixed

- Multiple VS Code windows now work independently — active context is stored in
  VS Code `workspaceState` (per-window) instead of `~/.ai-context/.active` (shared file).
  Window A can have BriefingAgent active while Window B has AIContext active simultaneously.
- File watcher correctly ignores changes from other windows — each window only
  re-injects when its OWN active context file changes.
- Removed `.active` file from context store entirely.

---

## [2.1.0] — 2026-04-28

### Changed

- Context store moved to global `~/.ai-context/` — decoupled from VS Code workspace root
  so single-workspace workflows (home dir open, projects as subfolders) work correctly.
- Each context now has a `root` field (absolute path to its project folder) — `CLAUDE.md`
  and `copilot-instructions.md` are injected into that folder, not the VS Code workspace root.
- `AI: New Context` and `AI: Run Task` (first context) now prompt for project root — shows
  a picker of `~/projects/` subdirectories plus a manual path option.
- `AI: Set Active Context` and `AI: View Context` pickers now show the `root` path as
  the description for each context.
- File watcher now watches `~/.ai-context/*.json` instead of the workspace-relative path.
- `ctx.root` is always re-applied after a task run — AI response cannot overwrite the path binding.

---

## [2.0.0] — 2026-04-28

### Added

- Auto-injection on VS Code startup via `onStartupFinished` activation event.
- `AI: Set Active Context` command (`Ctrl+Alt+S`) — one-time setup per workspace.
- File watcher on `.ai-context/*.json` — re-injects into CLAUDE.md and
  copilot-instructions.md automatically after every task run.
- `AI: Delete Context` command with confirmation dialog; clears injection blocks
  when active context is deleted.
- `AI: New Context` command offers to set new context as active immediately after creation.
- Active context indicator (● active) shown in all QuickPick lists.
- `clearInjection` — removes AI_CTX block from target files when no active context is set.

### Changed

- Codebase split from single `extension.js` monolith into four modules:
  `context.js`, `inject.js`, `claude.js`, `extension.js`.
- Context files now stored in `.ai-context/` inside the workspace root —
  never inside the extension folder.
- Context extraction now uses `CTX_UPDATE:` sentinel on last matching line
  instead of fragile `indexOf('{')`.
- Save always uses original `ctxName` — never derives save path from `ctx.p` in AI response.
- Project list is dynamically discovered from `.ai-context/*.json` — no hardcoded names.
- `package.json` main entry updated to `./src/extension.js`.

### Fixed

- `extractJSON` replaced — old implementation would extract the original context from
  the injected prompt, not the AI's update.
- `onDidSaveTextDocument` hook removed — Copilot Chat does not write into open documents;
  hook was a no-op.
- Null guard on all QuickPick and InputBox results — cancelling no longer crashes.
- `ensureDir` guard added before every write — `ENOENT` on missing directories eliminated.
- `loadContext` wrapped in try/catch — corrupted JSON returns blank context instead of crashing.
- `CTX_DIR` no longer resolves to `__dirname` — extension update no longer wipes saved contexts.

---

## [1.0.0] — 2026-04-28

### Added

- Initial implementation: `AI: Run Task`, `AI: View Context`, `AI: New Context`, `AI: Delete Context`.
- Claude Code CLI backend (`claude -p`) — no API keys required.
- Context files in `.ai-context/` per workspace.
- `CTX_UPDATE:` sentinel for reliable context extraction from Claude responses.
- `Ctrl+Alt+A` keybinding for Run Task.
