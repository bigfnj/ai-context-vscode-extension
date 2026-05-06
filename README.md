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

- **Active Context** — name, path, Reinject and Switch buttons. When you switch
  projects, the previous context appears below as a dashed card; click "Make Active"
  to swap back instantly.
- **Projects** — all tracked contexts with last-used times. Create new contexts here.
- **Permissions** — unified allow list for the active context (shared by Claude and
  Codex), Codex trust level dropdown (includes `full-auto`), and an Advanced
  Permissions button.
- **Behaviour** — toggles for all extension settings.
- **Agents** — checkboxes for which AI agents receive context injection.
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

Per-project toggle in the sidebar (Codex Settings section) that enables Codex's
`danger-full-access` sandbox bypass. When enabled:

- Writes `sandbox_mode = "danger-full-access"` to the project's `.codex/config.toml`
- Codex gains unrestricted file and command access for that project
- **Also writes `approval_policy = "never"` globally** in `~/.codex/config.toml`
  so approval prompts (which run *before* sandbox execution and would otherwise
  re-introduce friction on language runtimes, network calls, etc.) are
  suppressed in lockstep
- Useful for authorized testing, pen testing, or environments where sandbox restrictions
  are not needed
- Confirmation modal warns before enabling

Cross-project semantics: enabling sandbox in any one project sets the global
`approval_policy = "never"` line. Disabling only removes the line when **no
other context** still has sandbox enabled. The legacy
`[approval_policy.granular]` section is also stripped on write, because current
Codex rejects it as an invalid TOML form and silently falls back to
`on-request`, defeating the policy override.

This uses the **official Codex configuration mechanism** (not an exploit) and respects
admin-enforced `requirements.toml` restrictions.

### Codex trust level

Codex uses a project-level trust model rather than a per-command allow list. The
trust dropdown in the sidebar supports:

| Level | Effect |
|---|---|
| `full-auto` | Writes `approval_policy = "never"` globally in `~/.codex/config.toml` and adds `alias codex='codex --approval-mode full-auto'` to `~/.bashrc`. Maximum automation. |
| `trusted` | Sets `trust_level = "trusted"` for this project in `~/.codex/config.toml`. |
| `auto` | Codex uses its own heuristic. |
| `untrusted` | Sets `trust_level = "untrusted"`. Codex prompts for every action. |

When Sandbox Mode is enabled, the Trust Level setting is inactive (greyed out) since
sandbox bypass supersedes trust-based restrictions.

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

## Requirements

- VS Code 1.80+
- [Claude Code CLI](https://claude.ai/code) installed and accessible (WSL: inside WSL, not Windows)

## Installation (WSL)

The extension runs server-side inside WSL. Install via symlink so edits to the source
take effect on reload without repackaging:

```bash
mkdir -p ~/.vscode-server/extensions
ln -s /path/to/ai-context-extension \
      ~/.vscode-server/extensions/local.ai-context-runner-3.1.0
```

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
Ctrl+P → AI: New Context → enter name → pick project folder
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
| `AI: New Context` | — | Create a new context and bind it to a project folder |
| `AI: View Context` | — | Open a context file as formatted JSON |
| `AI: Manage Permissions` | — | View, remove, or adjust per-project permissions and Codex trust level |
| `AI: Delete Context` | — | Permanently delete a context |
| `AI: Clean Up Contexts` | — | Bulk archive or delete — orphan detection, age display |
| `AI: Restore Archived Context` | — | Restore a previously archived context |

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
