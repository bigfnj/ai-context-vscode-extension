# Changelog

All notable changes to AI Context Runner are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [2.8.2] — 2026-04-30

### Fixed

- `kilo` agent target corrected from `KILO.md` to `AGENTS.md` — Kilo reads `AGENTS.md`
  not `KILO.md`, so users with `kilo` in their agents list were writing to a file that
  was never picked up.
- `getInjectionTargets()` now deduplicates across agents — enabling both `codex` and
  `kilo` (both resolve to `AGENTS.md`) no longer causes a redundant double-write.

---

## [2.8.1] — 2026-04-30

### Fixed

- Codex injection now writes `AGENTS.md` into nested Git repository roots under a
  context root, not only the top-level context folder. This fixes projects where
  VS Code is opened at a parent folder but Codex runs from a child Git repo.
- Auto `.gitignore` updates are now Git-root aware, so generated nested `AGENTS.md`
  files are ignored by the nested repository that actually sees them.

---

## [2.8.0] — 2026-04-30

### Changed

- Replaced the verbose injected context block with a compact `AI_CONTEXT_V3=...`
  projection plus one instruction line.
- Agent-facing injection now groups durable memory under `mem` and omits bookkeeping
  fields such as `createdAt`, `lastUsed`, and compaction metadata.
- Full context JSON is still preserved on disk in `~/.ai-context/`.

---

## [2.7.0] — 2026-04-30

### Added

- Context schema v3 `h` field for compacted summaries of older actions.
- Deterministic action compaction: when `a[]` exceeds `aiContext.maxActions`, the
  oldest overflow is summarized into `h[]` before recent actions are trimmed.
- Compaction metadata under `m.compactedAt` and `m.compactionVersion`.

### Changed

- Injected agent context now includes `History` alongside `Actions`.
- Claude handoff prompt now documents `h[]` and emits schema version 3.
- `AI: Run Task` now merges partial `CTX_UPDATE` payloads onto the existing context,
  so omitted fields are preserved.

---

## [2.6.0] — 2026-04-30

### Added

- Context schema v2 memory fields:
  - `n` for the next concrete action
  - `b` for blockers
  - `d` for durable decisions
  - `c` for constraints
  - `f` for important files
  - `m` for metadata
- No-dependency unit test harness for context normalization, path containment,
  injection marker repair, invalid-root skips, and `CTX_UPDATE` parsing.

### Changed

- Default `aiContext.maxActions` increased from 20 to 40.
- `saveContext()` now normalizes context files, deduplicates list fields, and trims
  each memory list by purpose.
- Auto-detection now uses path containment instead of raw string-prefix matching, so
  `/Project` no longer matches `/ProjectX`.
- Injection now skips missing or invalid context roots instead of falling back to the
  home directory.
- The Claude handoff prompt now tells the agent which fields are durable memory and
  which field is recent activity.

### Fixed

- Replacing or clearing an injected block is now safe when the end marker is missing.
- README setup instructions now match the current extension version and command count.

---

## [2.5.0] — 2026-04-29

### Added

- **`AI: Config` command** (`Ctrl+Alt+C`) — interactive configuration menu that stays
  open after each change, showing current values inline. Covers all 8 settings without
  needing to edit `settings.json` manually.
- **`aiContext.scanOnLaunch`** — on every VS Code launch, scans `projectsRoot` and
  auto-creates context entries for any subdirectories not already tracked. Notifications
  report newly discovered projects.
- **`aiContext.cliPath`** — full path to the `claude` binary for WSL setups where it
  isn't on PATH. Used in `AI: Run Task`; error message now includes the configured path.
- **`aiContext.autoDetect`** — toggle to disable automatic context detection on folder
  open (manual-only mode via `Ctrl+Alt+S`).
- **`aiContext.showNotifications`** — toggle all informational notification messages.
- **`aiContext.autoGitignore`** — when enabled, automatically appends injected file
  names to `.gitignore` in the project root on every inject.
- **`aiContext.contextDir`** — override the context store from `~/.ai-context` to any
  absolute path. `getCtxDir()` and `getArchiveDir()` both respect this setting.
- **`aiContext.maxActions`** — cap the `a[]` action history array; enforced in
  `saveContext()` on every write.
- **`scanAndCreateContexts()`** in `context.js` — scans a directory, checks existing
  roots, and creates minimal context entries for untracked projects.
- **`getCliPath()`** exported from `claude.js` — used in Run Task progress title so
  the user always sees which binary is being called.

### Changed

- `getCtxDir()` reads `aiContext.contextDir` before falling back to `~/.ai-context`.
- `getArchiveDir()` derives from `getCtxDir()` instead of hardcoding the path.
- `saveContext()` trims `ctx.a` to `maxActions` on every write.
- `createContextWithRoot()` pre-fills the path input with `getProjectsRoot()` instead
  of always showing `~/projects`.
- `AI: Run Task` progress title now shows the CLI path being invoked.
- CLI not-found error message includes the configured path for easier debugging.

---

## [2.4.0] — 2026-04-29

### Added

- **Multi-agent injection** — context is now written to all configured AI agent files
  simultaneously. Supported agents: `claude` (CLAUDE.md), `codex` (AGENTS.md),
  `copilot` (.github/copilot-instructions.md), `cursor` (.cursorrules),
  `windsurf` (.windsurfrules), `kilo` (KILO.md). Default: `claude`, `codex`, `copilot`.
- **`aiContext.agents` setting** — VS Code setting to choose which agents receive
  injection. Configurable per workspace or globally.
- **`aiContext.projectsRoot` setting** — point the project picker at any folder
  (e.g. `/home/Vibe-Projects` for WSL setups where projects live outside `~/projects`).
- **`normalizePath()`** in `context.js` — resolves `~`, strips trailing slashes,
  trims whitespace for consistent path matching in WSL.
- **Silent auto-detection** — auto-load on startup only shows a notification when
  the active context actually changes; reload/re-inject is silent.

### Changed

- `listProjectDirs()` now reads from `aiContext.projectsRoot` config instead of
  always using `~/projects`.
- `createContextWithRoot()` default path input pre-filled with configured
  `projectsRoot` instead of `~/projects`.
- `AI: Set Active Context` and `AI: New Context` now show which agents will be
  injected in the notification message.
- `detectContextForPath()` extracted as a standalone function — used for both
  startup detection and workspace-folder-change detection.

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
