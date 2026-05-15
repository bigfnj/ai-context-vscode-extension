# AI Context Runner

A VS Code extension that gives **any AI agent** (Claude Code, Codex, GitHub Copilot,
Cursor, Windsurf, Kilo) persistent memory across sessions — automatically, with no
manual steps after first-time setup per project.

## How it works

On every VS Code launch, the extension **auto-detects** which project you've opened
by matching the workspace folder path against stored context roots. It then injects
the matching context into every configured AI agent file simultaneously.

```
VS Code opens a project folder
  → extension matches path against context store *.json roots
  → finds best containing root (most specific wins)
  → injects into CLAUDE.md + AGENTS.md + .github/copilot-instructions.md
  → open Claude Code, Codex, Copilot — context already there

Active editor or terminal moves into another tracked project
  → extension matches that current path
  → switches the window's active context
  → refreshes the same agent files for the new project

Task runs → Claude responds with CTX_UPDATE:
  → context JSON merged into the context store
  → file watcher fires
  → all agent files updated automatically
  → next session picks up the new state

Claude or Codex approves a new command in their settings:
  → extension detects the change via file watcher
  → generalizes and stores the permission in the context
  → reinjects on next session so you're never re-prompted
  → permissions shared across Claude and Codex via unified allow list
```

Context JSON files live in the context store directory (default `~/.ai-context/`,
configurable via `aiContext.contextDir`). The injected files (`CLAUDE.md`,
`AGENTS.md`, etc.) are materialized into each project folder on demand and are
always derived from the store.

## Sidebar panel

Click the **AI Context** icon in the VS Code Activity Bar to open the sidebar panel.
It shows:

- **Active Context** — name, path, health indicator (●), and action buttons:
  - **↺ Reinject** — re-write all agent files from the current context state
  - **⇄ Switch** — pick a different active context
  - **⧉ Duplicate** — clone the active context with a new name
  - **⊞ Save as Template** — save the active context as a reusable template (strips actions/state)
  - Previous context card appears below on switch; click "Make Active" to swap back instantly.
- **Projects** — all tracked contexts with last-used times. Create new contexts here.
- **Templates** — list of saved templates. Use **+ New from Template** to create a pre-filled context.
- **Codex Settings** — sandbox mode toggle and trust level dropdown.
- **Permissions** — unified allow list for the active context (shared by Claude and
  Codex), Codex safe commands, and an Advanced Permissions button.
- **Behaviour** — toggles for all extension settings.
- **Agents** — checkboxes for which AI agents receive context injection.
- **AI Understanding** — workspace name and full path, status summary
  (fresh / stale / untracked / orphan counts), hook install state, and
  context-sensitive action buttons (Initialize / Show Status / Refresh /
  Install or Uninstall Hook). See the AI Understanding section below.
- **About** — version and projects root.

## Permissions

The extension automatically captures, stores, and reinjects permissions for Claude Code
and Codex so you are not re-prompted for already-approved commands in new sessions.

### How capture works

1. **Live watcher** — A file watcher on `~/.claude/settings.json` detects any new
   entries in `permissions.allow` the moment Claude Code writes them. Each new entry
   is generalized and stored in the active context.

2. **Generalize** — Raw permissions are conservatively wildcarded before storage:
   - `Bash(python3 -c 'long script here')` → `Bash(python3 -c *)`
   - `Bash(git log --oneline -5)` → `Bash(git *)`
   - Deduplication prevents redundant rules.

3. **Unified allow list** — Stored under `perms.allow[]`. Applied to Claude's
   `~/.claude/settings.json` on every context load. Also used to infer Codex trust
   level (non-empty allow list → `trusted`).

4. **Auto-consolidate** — At VS Code startup, the extension scans all projects.
   Permissions appearing in 2+ projects are promoted to your global Claude allowlist
   and removed from individual project contexts.

### Codex sandbox mode

Per-project radio group in the sidebar (Codex Settings section) selects one of
three modes for the project's `.codex/config.toml`:

| Mode | What it writes | Approval prompts | Use when |
|---|---|---|---|
| **Off** | no `sandbox_mode` line | Codex default | you want Codex's built-in default behavior |
| **Workspace-write** *(recommended)* | `sandbox_mode = "workspace-write"` | Codex default — you'll see prompts on commands that touch outside the workspace, network, etc. | normal development |
| **Danger-full-access** | `sandbox_mode = "danger-full-access"` plus global `approval_policy = "never"` | suppressed | authorized testing / environments where sandbox restrictions aren't needed |

Switching to **Danger-full-access** shows a confirmation modal before writing.

A **"Recommended setup"** button below the radio group sets Workspace-write +
`network_access = false` in one click — the everyday default the Codex docs
suggest.

#### Network access sub-toggle (Workspace-write only)

When in Workspace-write, an additional toggle controls network access:

- **Off** (default) — no `[sandbox_workspace_write]` section in `.codex/config.toml`;
  Codex blocks network calls.
- **On** — writes `[sandbox_workspace_write]\nnetwork_access = true`. Use when
  the task genuinely needs package downloads, API calls, doc fetches, etc.

The section is automatically stripped when leaving Workspace-write so stale
config doesn't linger in any other mode.

#### Cross-project approval policy

Only **Danger-full-access** flips the global `approval_policy = "never"` line in
`~/.codex/config.toml` — the policy is set whenever any context is in
Danger-full-access and removed when the last one steps back. Workspace-write
intentionally does not touch the global policy, so its approval-prompt behavior
matches Codex's documented intent. The legacy
`[approval_policy.granular]` section is stripped on write, because current
Codex rejects it as an invalid TOML form and silently falls back to
`on-request`, defeating the policy override.

#### Platform sandbox runtime

The panel shows whether your platform's sandbox prerequisite is in place:

- **macOS** — Seatbelt is built in; always green.
- **Windows native** — PowerShell native sandbox is built in; always green.
- **Linux / WSL2** — needs `bwrap` (bubblewrap) on `PATH`. If missing, the
  panel surfaces `sudo apt install bubblewrap` inline.

#### Caveat

Some Codex VS Code extension versions ignore `config.toml` overrides for
`sandbox_mode` and `approval_policy`
([openai/codex#10540](https://github.com/openai/codex/issues/10540)). After
toggling, verify by asking Codex to write outside the workspace — it should
refuse or prompt according to the mode you picked.

#### Cloud-managed Codex requirements

On managed-account installs (Business / Enterprise plans), the cloud
publishes a signed requirements payload cached at
`~/.codex/cloud-requirements-cache.json` that caps `allowed_sandbox_modes`,
`allowed_approval_policies`, and `allowed_web_search_modes`. The extension
probes this cache at sidebar render time:

- Sandbox-mode radio options outside the cloud allow set render with a
  `⛔ blocked by policy` tag, dimmed appearance, and a tooltip explaining
  that Codex would silently downgrade the value at runtime.
- The settings panel surfaces a **cloud requirements banner** showing the
  active allowed-mode set, allowed approval policies, prefix-rule prompt
  count, and cache expiry timestamp.
- `approval_policy` falls back to `"untrusted"` when the cloud forbids
  `"never"` — the strongest cloud-allowed value, which still lets the
  per-project `trust_level = "trusted"` + harvested
  `~/.codex/rules/default.rules` wildcards skip prompts for any command
  not covered by the cloud's mandatory `[[rules.prefix_rules]]` groups.
- **Cloud-shadowed allow-list filtering** — when the cloud forces a
  prompt on a fixed set of argv[0] tokens (shells, runtimes, package
  managers, network tools), any local `prefix_rule(... decision="allow")`
  whose first token is in that set is dead weight: it gets written to
  `~/.codex/rules/default.rules` but the cloud rule fires anyway. The
  extension detects those entries up front and skips them when deriving
  Codex rules from Claude's allow list. Per-context `ctx.perms.allow`
  still stores the full intent, so a plan / cap change replays correctly.
  Claude's permission store is never affected by the Codex cap.

Personal / unmanaged installs (no cache file) bypass all of the above —
the radio group, approval-policy writer, and rules deriver behave as
documented in the preceding sections.

### Codex trust level

Codex uses a project-level trust model rather than a per-command allow list. The
trust dropdown in the sidebar supports:

| Level | Effect |
|---|---|
| `full-auto` | Writes `approval_policy = "never"` globally in `~/.codex/config.toml` and adds `alias codex='codex --approval-mode full-auto'` to `~/.bashrc`. Maximum automation. |
| `trusted` | Sets `trust_level = "trusted"` for this project in `~/.codex/config.toml`. |
| `auto` | Codex uses its own heuristic. |
| `untrusted` | Sets `trust_level = "untrusted"`. Codex prompts for every action. |

When Sandbox Mode is set to **Danger-full-access**, the Trust Level setting is
inactive (greyed out) since sandbox bypass supersedes trust-based restrictions.
Trust is fully active in Off and Workspace-write modes.

Setting `full-auto` on a project activates it globally (not just for that project),
since Codex's full-auto mode is a session-level flag. The `aiContext.codexFullAuto`
setting in VS Code settings is a global override that applies regardless of
per-project trust.

### Codex project switch bootstrap

Codex builds its prompt from files visible at session start. A later shell `cd`,
tool `workdir` change, or user instruction to "move into ProjectB" does not make an
already-running Codex conversation re-read ProjectB's `AGENTS.md`.

When `aiContext.codexProjectSwitchBootstrap` is enabled, AI Context Runner writes a
small instruction block into `projectsRoot/AGENTS.md`. That block tells Codex to:

1. Read the target project's nearest `AGENTS.md` after a project switch.
2. Treat any `AI_CONTEXT` found there as the authoritative session state.
3. Run `echo "$PWD" > {ctxDir}/.cwd` after switching, so the VS Code extension
   auto-detects the change and updates the sidebar panel.

### Codex and nested Git repos

Codex reads `AGENTS.md` from the working root it runs in. If VS Code is opened at
a parent project folder but Codex operates in a nested Git repo, the parent
`AGENTS.md` may not be visible in Codex's prompt. AI Context Runner handles this
by scanning for nested Git roots and injecting the same compact context into each
nested repo's `AGENTS.md`.

Verify what Codex sees with its local debugger:

```bash
codex debug prompt-input "probe context"
```

The output should include an `AGENTS.md instructions for ...` block containing `AI_CONTEXT`.

## AI Understanding

A second, independent capability shipped alongside the context runner: a per-project,
git-tracked, machine-edited model of the codebase under `AI_UNDERSTANDING/`. Each
tracked source file gets a sidecar `AI_UNDERSTANDING/<path>.aiu.json` with its
purpose, exports, imports, called-by edges, invariants, and gotchas. The
extension auto-injects a freshness signal into the same agent files (CLAUDE.md /
AGENTS.md / etc.) every session so AI agents see — and update — the model as
they edit.

Spec and contract: [`AI_UNDERSTANDING_FORMAT.md`](AI_UNDERSTANDING_FORMAT.md).
That file is the source of truth for the schema, validator rules, update
protocol, and pre-commit hook policy.

```text
You: AI Understanding: Initialize
  → extension walks tracked globs (src/**, test/**, package.json, etc.)
  → writes skeleton AI_UNDERSTANDING/<path>.aiu.json per file (purpose:"TODO")
  → writes AI_UNDERSTANDING/_meta.json with detected frameworks

Have your AI agent fill in purpose / exports / imports / invariants
  → (just open Claude or Codex; CLAUDE.md / AGENTS.md auto-injection
     tells the agent the rules and which entries are stale)

You edit a source file
  → file watcher recomputes status (250ms debounce)
  → status bar updates: "AIU: 1 stale"
  → CLAUDE.md / AGENTS.md AIU block updates with AIU_STALE=["src/foo.js"]
  → next AI session sees the stale list and refreshes that sidecar

You commit
  → optional pre-commit hook (block-narrow): rejects the commit if
    any staged source file is missing its sidecar or its sha1 doesn't
    match the staged content
  → override per commit: git commit --no-verify
```

A status bar item on the left shows current state:

| State | Reading |
|---|---|
| Not initialized | `AIU: not initialized` |
| All entries match source | `AIU: clean` |
| Some entries are out of date | `AIU: 3 stale, 1 untracked` |
| A `.aiu.json` exists for a deleted file | `AIU: 1 orphan` |

Click the status bar to open a quick pick of the offending entries; pick one to
open it.

The pre-commit hook is opt-in. Install it from the **AI Context Runner** sidebar
(AI Understanding section → "Install Pre-Commit Hook") or via the command
`AI Understanding: Install Pre-Commit Hook`. The hook is self-contained per
repo (a copy of the driver lives in `.git/hooks/`), so it survives extension
upgrades and works for collaborators after they install it themselves. Any
pre-existing user `pre-commit` hook is backed up to `pre-commit.aiu-backup` and
restored on uninstall.

The extension itself dogfoods this: see [`AI_UNDERSTANDING/`](AI_UNDERSTANDING/)
in this repo for a fully populated example.

## Requirements

- VS Code 1.80+
- [Claude Code CLI](https://claude.ai/code) installed and accessible (WSL: inside WSL, not Windows)

## Installation (WSL)

The extension runs server-side inside WSL. Install via symlink so edits to the source
take effect on reload without repackaging:

```bash
mkdir -p ~/.vscode-server/extensions
ln -s /path/to/AIContext \
      ~/.vscode-server/extensions/local.ai-context-runner-4.3.0
```

Match the version suffix to the `version` field in `package.json` so VS Code
registers the right edition; rename the symlink on each bump.

Then reload VS Code:

```
Ctrl+Shift+P → Developer: Reload Window
```

Verify installation:

```
Ctrl+Shift+P → type "AI:" — all commands should appear
```

## Configuration

Open VS Code Settings (`Ctrl+,`) and search for **AI Context**, or use the
sidebar panel's Behaviour section, or press `Ctrl+Alt+C` for the interactive menu.

| Setting | Default | Description |
|---|---|---|
| `aiContext.projectsRoot` | _(empty)_ | Root folder for the project picker and launch scan. Falls back to `~/projects`. |
| `aiContext.agents` | `["claude","codex","copilot"]` | Which AI agents receive context injection. |
| `aiContext.cliPath` | _(empty)_ | Full path to the `claude` binary. Uses `claude` from PATH when blank. |
| `aiContext.autoDetect` | `true` | Auto-load matching context when opening a project folder. |
| `aiContext.followActiveEditor` | `true` | Auto-switch context when the active editor belongs to another tracked project. |
| `aiContext.followTerminalCwd` | `true` | Auto-switch context when VS Code shell integration reports a new active terminal directory. |
| `aiContext.codexProjectSwitchBootstrap` | `true` | Write `projectsRoot/AGENTS.md` bootstrap so Codex reads target project context after switches. |
| `aiContext.codexFullAuto` | `false` | Set Codex to `--approval-mode full-auto` globally — writes alias to `~/.bashrc` and `approval_policy = "never"` to `~/.codex/config.toml`. |
| `aiContext.scanOnLaunch` | `true` | Scan `projectsRoot` on launch and create context files for new projects. |
| `aiContext.showNotifications` | `true` | Show informational context load/switch notifications. |
| `aiContext.autoGitignore` | `false` | Add injected agent files to project `.gitignore`. |
| `aiContext.contextDir` | _(empty)_ | Override the context store directory. Falls back to `~/.ai-context`. |
| `aiContext.maxActions` | `40` | Maximum recent actions kept in context history (1–200). |

### Supported agents

| Value | File written |
|---|---|
| `claude` | `CLAUDE.md` |
| `codex` | `AGENTS.md` in the context root and all nested Git repo roots |
| `copilot` | `.github/copilot-instructions.md` |
| `cursor` | `.cursorrules` |
| `windsurf` | `.windsurfrules` |
| `kilo` | `AGENTS.md` (same targets as codex) |

### WSL example (`settings.json`)

```json
{
  "aiContext.projectsRoot": "/home/Vibe-Projects",
  "aiContext.contextDir": "/home/Vibe-Projects/.ai-context",
  "aiContext.agents": ["claude", "codex"],
  "aiContext.codexFullAuto": true
}
```

## First-time setup (one step, per project)

```
Ctrl+Shift+P → AI: New Context → enter name → pick project folder
```

After that, every time you open that project folder VS Code auto-detects and
loads the correct context with no further action needed.

You can also use `Ctrl+Alt+S` to manually set or override the active context
for the current window.

## Commands

| Command | Shortcut | Description |
|---|---|---|
| `AI: Run Task` | `Ctrl+Alt+A` | Run a task using the active context via Claude CLI |
| `AI: Set Active Context` | `Ctrl+Alt+S` | Manually set which context is active for this window |
| `AI: Reinject Active Context` | `Ctrl+Alt+R` | Re-inject current context into all agent files |
| `AI: Config` | `Ctrl+Alt+C` | Interactive configuration menu |
| `AI: Search Contexts` | `Ctrl+Alt+F` | Search all contexts by name, path, notes, files, or decisions |
| `AI: New Context` | — | Create a new context and bind it to a project folder |
| `AI: Duplicate Context` | — | Clone an existing context with a new name |
| `AI: Health Check` | — | Scan all contexts for issues — missing roots, stale files, error flags |
| `AI: Save as Template` | — | Save the active context as a reusable template (strips actions/state) |
| `AI: New Context from Template` | — | Create a new context pre-filled from a saved template |
| `AI: View Context` | — | Open a context file as formatted JSON |
| `AI: Manage Permissions` | — | View, remove, or adjust per-project permissions and Codex trust level |
| `AI: Delete Context` | — | Permanently delete a context |
| `AI: Clean Up Contexts` | — | Bulk archive or delete — orphan detection, age display |
| `AI: Restore Archived Context` | — | Restore a previously archived context |
| `AI Understanding: Initialize` | — | Bootstrap `AI_UNDERSTANDING/` for the workspace (skeleton entries + `_meta.json`) |
| `AI Understanding: Show Status` | — | Quick pick of stale / untracked / orphan entries; click to open |
| `AI Understanding: Refresh` | — | Recompute status and refresh the status bar + injected block |
| `AI Understanding: Install Pre-Commit Hook` | — | Opt in to spec §9 block-narrow hook (`.git/hooks/pre-commit`) |
| `AI Understanding: Uninstall Pre-Commit Hook` | — | Remove the hook (restores any backed-up user hook) |

## Auto-detection behavior

When you open a project folder, the extension:

1. Scans all contexts in the context store
2. Finds the context whose `root` is the most specific parent of your workspace folder
3. Sets it active and injects into all configured agent files silently
4. Only shows a notification if it switches away from a previously active context

With `aiContext.followActiveEditor` enabled, activating a file in another tracked
project also switches to that project's context. With `aiContext.followTerminalCwd`
enabled, the extension follows the active integrated terminal directory.

When you switch projects, the sidebar panel shows the previous context as a dashed
card in the Active Context section. Clicking "Make Active" on it restores and
reinjects it with one click.

## Context storage

All context files live in the context store directory (default `~/.ai-context/`).
Each context has a `root` field binding it to a project. Injection writes derived
files into each project folder on demand.

```
~/.ai-context/
  ProjectA.json
  ProjectB.json
  archive/
    OldProject_1714000000000.json   ← archived, not deleted
```

## Context file format

```json
{
  "v": 3,
  "u": "username",
  "p": "project-name",
  "root": "/home/Vibe-Projects/ProjectA",
  "t": "current-task",
  "s": {},
  "n": "next concrete action",
  "b": [],
  "d": [],
  "c": [],
  "f": [],
  "h": [],
  "a": [],
  "e": null,
  "i": "intent / goal",
  "m": {
    "compactedAt": null,
    "compactionVersion": 1
  },
  "perms": {
    "allow": ["Bash(python3 -c *)", "Bash(git *)", "WebSearch"],
    "codex": "trusted"
  },
  "createdAt": "2026-04-28T12:00:00.000Z",
  "lastUsed": "2026-04-28T14:30:00.000Z"
}
```

| Key | Meaning |
|---|---|
| `v` | Schema version |
| `u` | User / actor |
| `p` | Project name (display label) |
| `root` | Absolute path to the project folder |
| `t` | Current task |
| `s` | State — active working object, params, conditions |
| `n` | Next concrete action |
| `b` | Blockers / open issues, capped at 15 |
| `d` | Durable decisions, capped at 20 |
| `c` | Constraints / rules to preserve, capped at 20 |
| `f` | Important files, capped at 30 |
| `h` | Compacted summaries of older actions, capped at 12 |
| `a` | Recent actions (string array) |
| `e` | Last error, or null |
| `i` | Intent / goal |
| `m` | Compaction metadata |
| `perms.allow` | Generalized permission patterns — applied to Claude's allowlist and used to infer Codex trust on every context load |
| `perms.codex` | Codex trust level: `full-auto`, `trusted`, `auto`, or `untrusted` |
| `createdAt` | Set once on creation, never modified |
| `lastUsed` | Updated automatically on every save |

## Memory policy

The context file separates durable memory from recent activity:

- `d`, `c`, `f`, and `b` are durable memory fields. Keep these compact — only
  information that should survive across sessions.
- `a` is a recent activity trail. The default cap is 40 actions, configurable with
  `aiContext.maxActions`.
- When `a` exceeds the cap, older overflow is summarized into `h` before trimming.
  The agent receives both compact history and recent actions.
- Older or repeated list entries are normalized on save. Lists are deduplicated and
  trimmed from the oldest entries first.

## Injected format

The full context stays in the store. Agent files receive a compact projection:

```text
AI_CONTEXT={"v":3,"p":"ProjectA","root":"/home/Vibe-Projects/ProjectA","t":"current-task","i":"intent","n":"next action","s":{},"b":[],"d":[],"c":[],"f":[],"h":[],"a":[],"e":null}
Use AI_CONTEXT as authoritative session state. Continue from n; preserve b/d/c/f/h; append only meaningful recent work to a; update context through CTX_UPDATE when supported.
After each response, write a single line `CTX_UPDATE:{...}` to {storePath}.update — the VS Code extension reads, merges, and deletes it to persist state after every turn.
```

The injected projection omits bookkeeping (`createdAt`, `lastUsed`, compaction
metadata) to reduce token cost for agents.

## What to gitignore in your projects

```gitignore
CLAUDE.md
AGENTS.md
.cursorrules
.windsurfrules
.github/copilot-instructions.md
```

The context store is user-specific and should not be committed to any project.
