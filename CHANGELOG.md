# Changelog

All notable changes to AI Context Runner are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [4.2.0] — stop CTX_UPDATE from leaking into interactive chat surfaces

The `ai.runTask` CLI path has always stripped `CTX_UPDATE:` from the rendered
response via `stripContextUpdate`, but the AI Context Runner injection block
is also read by interactive agents whose chat output the extension cannot
proxy (Claude Code, Codex in IDE, etc.). When such an agent echoed the
`CTX_UPDATE:` line into the visible reply, the user saw the raw JSON wall.
This release closes that gap on two fronts: the prompt now explicitly forbids
inline emission, and the agent file is defensively scrubbed before every
re-inject.

### Changed

- `buildInjectionBlock` and `buildMultiInjectionBlock` (inject.js) now
  append an explicit *"Do NOT include the `CTX_UPDATE:` line anywhere in
  your visible chat reply — only the sidecar file is consumed by the
  extension; chat output is not parsed and shows the raw JSON to the
  user."* directive. Both single-context and multi-context variants get
  the wording. Existing injection blocks refresh on next context
  activation or workspace open.

### Added

- `scrubLeakedContextUpdates(content)` in `inject.js` — strips stray
  `CTX_UPDATE:` lines from regions outside the `<!-- AI_CTX_START -->` /
  `AI_CTX_END` marker pair. Content inside the marker block is preserved
  unchanged because the injected instruction itself embeds the literal
  `CTX_UPDATE:{"v":3,…}` template the agent must read.
- `injectIntoFile` now calls `scrubLeakedContextUpdates` on the existing
  file content before re-injecting the marker block, so any leaked
  `CTX_UPDATE:` line that landed in `CLAUDE.md` / `AGENTS.md` /
  `.cursorrules` / etc. gets cleaned on the next sweep instead of
  accumulating.

### Tests

- `testInjectionForbidsInlineCtxUpdate` pins the "Do NOT include" wording
  in both injection variants.
- `testScrubLeakedContextUpdatesOutsideMarker` verifies leaks before and
  after the marker block are stripped, the template inside the block is
  preserved, and `injectIntoFile` applies the scrub end-to-end.
- `testScrubLeakedContextUpdatesWithoutMarker` covers the marker-less
  case including indented leaks.

---

## [4.1.2] — `approval_policy = "untrusted"` fallback under cloud cap

Stops fighting the silent downgrade. On managed-account installs where the
cloud forbids `approval_policy = "never"`, the global policy line now falls
back to `"untrusted"` — the strongest value cloud requirements accept. This
restores the original quality-of-life intent of the sandbox toggle: combined
with per-project `trust_level = "trusted"` (already wired) and the
`~/.codex/rules/default.rules` wildcards harvested from your sessions
(already wired), Codex skips prompts for any command **not** in the cloud's
mandatory-prompt prefix-rule groups.

### Changed

- `syncCodexApprovalPolicyToSandbox` (extension.js) now delegates to
  `deriveApprovalPolicyForSandboxModes()` and writes the result via
  `setCodexApprovalPolicy()`. Selection logic:
  - any context in **danger-full-access** → `"never"` if cloud allows it;
    else `"untrusted"` if allowed; else clear the line.
  - any context in **workspace-write** + cloud cap active → `"untrusted"`
    (the cloud would downgrade `"never"` to `"on-request"` anyway, and
    `"untrusted"` gives you the wildcard-driven prompt-skip we already
    wired for trusted projects).
  - **workspace-write on personal/unmanaged install** → policy line
    untouched (matches v4.1.0 contract — only `danger-full-access` flips
    global policy when no cloud cap is in force).
  - all contexts off → clear our managed line (leaves user-set values
    like `"on-request"` alone).

### Added

- `setCodexApprovalPolicy(value)` in `permissions.js` — generalized writer
  accepting `'never' | 'untrusted' | null`. Removes our line only when the
  current value is one we managed (`never`/`untrusted`), preserving any
  manually-set policy like `on-request`.
- `deriveApprovalPolicyForSandboxModes({ anyDanger, anyWsWrite })` — pure
  function that picks the strongest cloud-allowed value for the given mode
  union. Single source of truth shared between extension.js and
  settingsView.js handlers.
- `setCodexApprovalPolicyNever(enabled)` retained as a thin back-compat
  wrapper around the new writer.
- Unit tests cover personal-install paths, cloud-cap-allows-untrusted-only,
  cloud-cap-allows-neither, user-set non-managed value preservation, and
  invalid-value rejection.

### Notes

The cloud's `[[rules.prefix_rules]]` (`shells`, `runtimes`, `network`,
`containers`, `package managers`) still force prompts. Per the v4.1.1
research, local rules cannot relax cloud rules — the merged policy uses
`max(Allow, Prompt) = Prompt`. This release squeezes the maximum value out
of what local config CAN do under policy.

---

## [4.1.1] — Detect cloud-managed Codex requirements

Surfaces restrictions imposed by enterprise / managed-account Codex
deployments before the user picks a sandbox mode that would be silently
downgraded at runtime.

### Added

- `probeCloudRequirements()` in `permissions.js` — reads
  `~/.codex/cloud-requirements-cache.json` (the local cache of the signed
  cloud-requirements payload), parses `allowed_sandbox_modes`,
  `allowed_approval_policies`, `allowed_web_search_modes`, and counts
  `decision = "prompt"` prefix-rule groups. Returns `null` for personal /
  unmanaged installs (no cache file).
- Settings panel **cloud requirements banner** (above the radio group) when
  restrictions are active — shows allowed sandbox modes, allowed approval
  policies, prefix-rule prompt count, and the cache expiry timestamp.
- Sandbox-mode radio options that fall outside the allowed set render with
  a `⛔ blocked by policy` tag, dimmed appearance, disabled input, and a
  tooltip explaining that Codex would downgrade the value at runtime.
- Defense-in-depth: the `setCodexSandboxMode` handler also verifies the
  picked mode against the cloud allow set and refuses to write a value
  Codex would reject.
- Unit tests for the parser cover active / expired / malformed / empty
  caches and missing keys.

### Notes for managed-account users

Cloud requirements also include `[[rules.prefix_rules]]` with
`decision = "prompt"` for command groups like `python`, `node`, `npm`, `pip`,
`docker`, `kubectl`, `curl`, `wget`, `ssh`, `bash`, `zsh`. Those prompts
**cannot** be skipped via local `~/.codex/rules/default.rules` or
`approval_policy = "untrusted"` — the cloud rules override local rules.
Only commands not covered by the cloud's prefix-rule groups can be
short-circuited via the per-project trust + local rules path.

---

## [4.1.0] — Codex sandbox mode: tri-state with workspace-write

Reshapes the per-project Codex sandbox toggle around the three modes the
Codex CLI actually supports, surfaces the platform sandbox runtime, and
decouples the global approval-policy flip from `workspace-write` so the
"safer default" is actually the safer default.

### Changed (behavior change)

- **`workspace-write` no longer suppresses approval prompts.** In v3.10 the
  toggle wrote `approval_policy = "never"` globally whenever any context had
  sandbox bypass enabled, because the only available mode was
  `danger-full-access` and the goal was zero friction. Now that
  `workspace-write` is selectable, only `danger-full-access` flips the global
  policy. Pick `workspace-write` if you want the workspace boundary AND
  Codex's normal approval prompts (e.g. on `python3 …`, network calls,
  writes outside the workspace). Pick `danger-full-access` if you still want
  the prior zero-friction posture.
- Per-project setting renamed: `perms.sandboxMode: bool` →
  `perms.codexSandboxMode: 'workspace-write' | 'danger-full-access' | null`.
  Stored context JSONs were cleaned of the legacy boolean as part of the
  release; no migration is performed at load time.

### Added

- **Tri-state radio group** in the settings panel: Off / Workspace-write /
  Danger-full-access. Quick-pick menu offers the same three options.
- **`network_access` sub-toggle** for `workspace-write`. When enabled, writes
  `[sandbox_workspace_write] network_access = true` to the project's
  `.codex/config.toml`; removed otherwise. Hidden in any other mode.
- **"Recommended setup" button** — sets `workspace-write` +
  `network_access = false` in one click. Matches Codex's documented default
  for normal development.
- **Sandbox runtime probe** — the panel shows whether the platform's sandbox
  prerequisite is satisfied:
  - macOS / Windows native: always green (Seatbelt / PowerShell built-in).
  - Linux / WSL2: scans PATH for `bwrap`. If missing, surfaces the
    `sudo apt install bubblewrap` advice inline.
- **VS Code extension caveat** noted in the panel — some Codex VS Code
  extension versions ignore `config.toml` overrides
  ([openai/codex#10540](https://github.com/openai/codex/issues/10540));
  hover for guidance on verifying the toggle landed.
- `applyCodexSandboxNetworkAccess(projectRoot, enabled)` and
  `probeSandboxRuntime()` in `permissions.js`.
- Unit tests covering all three modes' write/remove correctness, the
  `network_access` section round-trip, runtime probe shape, and
  context normalization (legacy boolean stripped, invalid enum coerced).

---

## [4.0.0] — AI Understanding: feature-complete

Closes out the five-phase rollout of AI Understanding. The major bump signals
that a new top-level capability area lands alongside the existing AI Context
Runner — both ship in the same extension, both are independent, and both
auto-inject into the same agent files behind separate fenced blocks.

### Added

- **Phase 3 — CLAUDE.md / AGENTS.md auto-injection** (`97ee4cf`).
  - `understanding.buildAiuInjectionBlock(status)` — pure formatter for the
    fenced block: `AIU_STALE=[…]` / `AIU_UNTRACKED=[…]` / `AIU_ORPHAN=[…]`
    plus the spec §8 agent rules (same-turn sidecar updates; work the list
    before other work; only bump `last_audit_commit` when all lists are
    empty; no mass edits outside bootstrap; no orphan creation).
  - `inject.AIU_INJECT_START` / `AIU_INJECT_END` — separate fence pair from
    AI_CTX so the two injectors never overlap.
  - `inject.injectMarkedBlock` is now idempotent: skips writes when content
    is unchanged. Prevents the AIU file watcher from looping on its own
    writes. (Side benefit: the AI_CTX path also avoids needless writes.)
  - `aiu.refreshStatus()` syncs the AIU block into target files that already
    exist (the AI_CTX path owns first-time CLAUDE.md/AGENTS.md creation).
    Clears the block when `AI_UNDERSTANDING/` is removed.

- **Phase 4 — Pre-commit hook + settings UI** (`54be1a9`).
  - `cli/aiu-precommit.js` — self-contained Node hook driver per spec §9
    (block-narrow mode). Reads `tracked_globs` from `_meta.json`. For each
    staged source file: blocks if its `.aiu.json` sidecar is missing in the
    staged tree or sha1 differs from sha1 of the staged source. Blocks
    deletion of a `.aiu.json` when the matching source is not also deleted.
    No `_meta.json` = no contract = exit 0. Override:
    `git commit --no-verify`.
  - `src/hook.js` — installer. Copies the driver into `.git/hooks/` so the
    hook is self-contained per-repo and survives extension upgrades. Backs
    up any pre-existing user `pre-commit` hook to `pre-commit.aiu-backup`;
    uninstall restores from backup.
  - Two new commands: `AI Understanding: Install Pre-Commit Hook` and
    `…: Uninstall Pre-Commit Hook`.
  - Settings webview gains an "AI Understanding" section: workspace
    name (with full path on hover), status summary, fresh/stale/untracked/
    orphan counts, hook install state, and context-sensitive action buttons
    (Initialize / Show Status / Refresh / Install or Uninstall Hook).
    The workspace label disambiguates which window's panel you are looking
    at when several VS Code windows are open.

- **Project-scoped throughout** (`01b81b9`). AIU follows the active AI
  Context, not the VS Code workspace folder. The status bar, settings
  panel, and the injected CLAUDE.md / AGENTS.md AIU block all read the
  active context's `root`. The AIU block now leads with
  `AIU_PROJECT="..."` + `AIU_ROOT="..."` and tells the agent explicitly:
  after ingesting `AI_CONTEXT` above, also ingest this AI Understanding
  block — both belong to the same project. Switching the active context
  re-targets AIU immediately. Workspace folder remains a fallback when
  no context is active.

- **Phase 5 — Self-bootstrap** (`4b5016f`).
  - `AI_UNDERSTANDING/` now ships with the extension as a populated,
    full-fidelity tree: 13 entries (package.json + 9 `src/*` + 2 `test/*` +
    `cli/aiu-precommit.js`) with real purpose / exports / imports /
    called_by / calls_out_to / invariants / gotchas. `_meta.json` extends
    `DEFAULT_TRACKED_GLOBS` with `cli/**` so the standalone hook driver is
    in scope; `last_audit_commit` anchors to the parent commit.

### Changed

- **`tracked_globs.exclude` defaults** — projects extending the defaults can
  opt to add `AI_UNDERSTANDING/**` themselves. The extension's own
  `_meta.json` does so to prevent recursion.

### Tests

- Total goes from 37 (3.12.0) to 56. New coverage:
  - Block formatter for uninitialized / clean / populated states + agent-rule
    presence assertions.
  - `injectMarkedBlock` idempotence and in-place update without
    duplication.
  - Hook installer: install / reinstall / backup / uninstall / restore-backup
    / noop / non-git-rejection.
  - End-to-end pre-commit: spawn the actual driver against tmp git repos —
    no-meta no-op, clean-commit pass, missing-sidecar block, stale-sidecar
    block, orphan-deletion block, paired-deletion pass.

### Notes

- No breaking changes to the AI Context Runner side. The major bump reflects
  the introduction of a new capability area, not API churn.

---

## [3.12.0] — AI Understanding: commands + status bar (preview)

Introduces a per-project, git-tracked, machine-edited model of the codebase
(`AI_UNDERSTANDING/`) — sidecar JSON entries capturing per-file purpose,
exports, imports, invariants, and gotchas. See `AI_UNDERSTANDING_FORMAT.md`
for the schema-v1 contract.

### Added

- **`AI_UNDERSTANDING_FORMAT.md`** — full spec: directory layout, per-file
  and meta schemas, validator rules, update protocol for AI agents, hook
  policy, versioning rules.
- **`src/understanding.js`** — pure-Node implementation (no new deps):
  - `sha1` / `sha1File` over file bytes for staleness detection.
  - `validateEntry`, `validateMeta`, `validateOperation` enforcing §7 rules
    (33 % mass-edit cap with bootstrap bypass, schema-v1 lock, 40-hex
    lowercase sha1, path identity, no unknown fields).
  - Per-file CRUD: `readEntry`, `writeEntry`, `deleteEntry`, `readMeta`,
    `writeMeta`, `listEntries`.
  - `generateSkeleton(projectRoot, opts?)` — bootstrap walks tracked globs,
    emits skeleton entries (`purpose: "TODO"`) and a populated `_meta.json`
    with auto-detected frameworks from `package.json`.
  - `computeStatus(projectRoot)` — categorized `fresh / stale / untracked /
    orphan` arrays per spec §6, plus `isClean` and `formatStatusBar` helpers.
  - Minimal in-tree glob matcher (`**`, `*`, `?`, brace alternation) — no
    `minimatch` dependency.
- **`src/aiu.js`** — VS Code adapter. Three commands:
  - `AI Understanding: Initialize` (`ai.aiuInit`)
  - `AI Understanding: Show Status` (`ai.aiuStatus`)
  - `AI Understanding: Refresh` (`ai.aiuRefresh`)
- **Status bar item** (left, priority 9): `AIU: clean` / `AIU: 3 stale,
  1 untracked` / `AIU: not initialized`. 250 ms-debounced filesystem watcher
  keeps the bar in sync with workspace changes.
- **37 unit tests** wired into `npm test` covering hashing, glob matching,
  validator success/failure paths, CRUD round-trip, path-traversal
  rejection, end-to-end skeleton generation, and all `computeStatus`
  staleness states.

### Notes

- Preview surface — Phases 3–5 (CLAUDE.md auto-block injection, pre-commit
  hook, self-bootstrap) follow in subsequent releases. See `[Unreleased]`.
- Failures during AI Understanding activation are caught and logged; they
  cannot break the rest of the extension.

---

## [3.10.0] — Sandbox toggle also writes `approval_policy = "never"` globally

### Changed

- The per-project Codex sandbox-mode toggle now also writes
  `approval_policy = "never"` to global `~/.codex/config.toml` whenever **any**
  context has sandbox bypass enabled, and removes it when the last sandboxed
  context is disabled. Reason: `sandbox_mode` and `approval_policy` are
  independent gates in Codex's pipeline (approval gate runs **before** sandbox
  execution), so enabling sandbox bypass alone does nothing about the prompts
  that fire on language runtimes / network calls / etc. Without the policy
  flip, the user kept getting prompted (e.g. on `python3 …`) even though they'd
  asked for "no friction" via the sandbox toggle.
- Cross-project semantics: enabling sandbox in any one project sets the global
  policy. Disabling only removes the policy line if **no other context** still
  has sandbox enabled.
- Always strips the legacy `[approval_policy.granular]` section when writing,
  because current Codex CLI rejects it ("granular is not a unit variant") and
  silently falls back to `on-request`, overriding our scalar `approval_policy`.
- Bootstrap on context switch also re-derives the global policy line, keeping
  `~/.codex/config.toml` in sync with the per-context store across restarts.

### Added

- `setCodexApprovalPolicyNever(enabled)` in `permissions.js` — clean toggle for
  the global scalar `approval_policy` line. Respects user-set non-`"never"`
  values on disable (only removes the line if it equals `"never"`).

---

## [3.9.4] — Sandbox probe recognises OpenAI's `openai.chatgpt` extension id

### Fixed

- `probeCodexVSCodeExtension()` was searching for the substring `"codex"` in the
  installed extension's id and `packageJSON.name`. OpenAI publishes the official
  Codex extension as **`openai.chatgpt`** (with `displayName` "Codex – OpenAI's
  coding agent"), so the substring scan never matched and the sandbox toggle
  always warned "Codex VS Code extension not installed" even when it was.
- Probe now matches a known-id allow-list (`openai.chatgpt`, `openai.codex`)
  first, then falls back to substring scans on `id`, `name`, and `displayName`
  for forward compatibility with future renames.

---

## [2.9.7] — Live permission capture from Claude & Codex

### Added

- **Claude permission watcher:** Extension now watches `~/.claude/settings.json`.
  Any command approved via "Allow always" in a Claude Code session is automatically
  captured, wildcarded (e.g. `Bash(git log --oneline -5)` → `Bash(git *)`), and
  stored in the active project's `perms.claude` array. No manual capture step needed.
- **Codex trust watcher:** Extension watches `~/.codex/config.toml`. If Codex
  updates the trust level for the active project's root, it is synced back into
  `perms.codex` automatically.
- Both watchers are loop-safe: permissions written by the extension during project
  switch are already covered by stored perms and produce no false captures.
- Settings panel refreshes automatically when new permissions are captured.

---

## [2.9.5] — Settings panel (sidebar WebviewView)

### Added

- **Activity bar panel:** New sidebar view (database icon) showing active context,
  all tracked projects, behaviour toggles, agent checkboxes, and version info.
  Refreshes automatically on every context switch or context store change.
- Behaviour toggles (followActiveEditor, followTerminalCwd, autoDetect, etc.) are
  editable directly from the panel — no need to open VS Code Settings.
- Agent checkboxes (claude, codex, copilot, cursor, windsurf, kilo) toggle inject
  targets live without reloading.
- Collapsible sections with VS Code-native theming.

---

## [2.9.4] — Fix redundant re-injection on same-project tab switches

### Fixed

- `syncActiveContextForPath` now only calls `injectAndApplyPerms` and `bootstrapFromGit`
  when the context actually changes (`matched !== previous`). Previously it re-injected
  on every editor tab switch even when staying in the same project, causing constant
  file writes and masking the notification for real project switches.

---

## [2.9.3] — Shell CWD hook auto-switching

### Added

- **Shell PROMPT_COMMAND hook:** A one-line addition to `~/.bashrc` writes `$PWD` to
  `~/.ai-context/.cwd` on every terminal prompt. The extension watches this file and
  calls `syncActiveContextForPath` whenever it changes, so context switches automatically
  when you `cd` into a project — no editor file open required.

---

## [Unreleased]

### Added

- **Per-project permission capture & reinjection:** The extension now captures
  permissions granted to Claude Code during `AI: Run Task` sessions, generalizes
  them conservatively (e.g., `Bash(python3 -c 'long script')` → `Bash(python3 -c *)`),
  and stores them in the context. On every context load, permissions are reinjected
  into `~/.claude/settings.json` and `~/.codex/config.toml`, eliminating
  re-prompting for already-approved commands.

- **Auto-consolidation:** At VS Code startup, the extension scans all projects.
  Permissions appearing in 2+ projects are automatically promoted to global config
  and removed from individual projects, building a global allowlist naturally over time.

- **AI: Manage Permissions command:** New command to view, remove, or adjust
  per-project Claude/Codex permissions. Integrated into `AI: Config` menu.

- **New field `perms` in context schema:** Stores `claude` (command allowlist) and
  `codex` (trust level) per-project. Never injected into agent files — only used
  for config management.

### Changed

- Version count: 9 commands (added `AI: Manage Permissions`).

---

## [2.9.2] - 2026-04-30

### Changed

- Renamed `AI_CONTEXT_V3` to `AI_CONTEXT` in all injected agent files. The `V3`
  suffix was redundant — schema versioning is tracked by the `v` field inside the
  JSON. Existing files are updated automatically on the next reinject.

---

## [2.9.1] - 2026-04-30

### Added

- **AI: Reinject Active Context** command (`Ctrl+Alt+R` / `Cmd+Alt+R`): re-injects
  the current active context into all configured agent files (CLAUDE.md, AGENTS.md,
  .github/copilot-instructions.md, etc.) in one keystroke. Intended as a manual
  recovery after a Claude Code or Codex conversation compaction — re-inject, then
  tell the agent to re-read its context file and resume from `AI_CONTEXT_V3`.

---

## [2.9.0] - 2026-04-30

### Fixed

- **Schema consistency (critical):** `buildAgentContext` now uses flat top-level
  `b/d/c/f` fields instead of a nested `mem:{}` object. Both the injection block
  and `buildPrompt` now present the same schema to Claude, eliminating silent
  data loss when Claude emitted CTX_UPDATE using the `mem` format it saw in
  AGENTS.md/CLAUDE.md.
- **Backward compatibility:** `normalizeContext` now accepts the old `mem:{b,d,c,f}`
  format as a fallback, so existing contexts or sidecars written with the previous
  schema are promoted correctly rather than silently dropped.
- `buildPrompt` (Run Task path) now uses `buildAgentContext` for the context
  payload — Run Task and interactive sessions now give Claude an identical schema.

### Added

- **Git bootstrap for fresh contexts:** when a context is first activated
  (`t === 'init'`), the extension runs `git log --oneline -8` and
  `git status --short` in the project root and pre-populates `a`, `n`, and `s`
  fields. New projects no longer start with a blank slate.
- **Status bar item:** a persistent `$(database) [context-name]` indicator in
  the VS Code status bar shows the active context at a glance. Clicking it opens
  the context switcher. Updates automatically on every context switch.
- Two new unit tests: `testMemFormatFallback` (old mem format round-trip) and
  `testSidecarRoundTrip` (CTX_UPDATE merge and field survival).

---

## [2.8.4] - 2026-04-30

### Added

- Per-turn state persistence for interactive sessions: the injection block now
  instructs the AI agent to write `CTX_UPDATE:{...}` to a sidecar file
  (`~/.ai-context/[project].json.update`) after every response.
- File watcher now consumes `.json.update` sidecars automatically — reads the
  `CTX_UPDATE`, merges it into the context store, deletes the sidecar, and
  re-injects. State is now captured after each interactive turn, not only when
  the built-in Run Task command is used.

---

## [2.8.3] - 2026-04-30

### Added

- Active-editor and integrated-terminal following: the window can now switch to
  the matching context when the current file or VS Code shell-integration cwd
  moves into another tracked project.
- `aiContext.followActiveEditor` and `aiContext.followTerminalCwd` settings to
  control the new current-location following behavior.
- `aiContext.codexProjectSwitchBootstrap`, which writes a lightweight
  `projectsRoot/AGENTS.md` bootstrap for Codex sessions launched from the parent
  projects folder. The bootstrap tells Codex to read the target project's nearest
  `AGENTS.md` after a project switch request.

### Changed

- Auto-detection logic is centralized so startup, workspace-folder changes,
  active-editor changes, and terminal cwd changes all use the same best-match
  context selection.

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
