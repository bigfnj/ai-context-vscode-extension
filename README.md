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
  → extension matches path against ~/.ai-context/*.json roots
  → finds best containing root (most specific wins)
  → injects into CLAUDE.md + AGENTS.md + .github/copilot-instructions.md
  → open Claude Code, Codex, Copilot — context already there

Task runs → Claude responds with CTX_UPDATE:
  → context JSON saved to ~/.ai-context/
  → file watcher fires
  → all agent files updated automatically
  → next session picks up the new state
```

Context JSON files live in `~/.ai-context/` — your home directory. The injected
files (`CLAUDE.md`, `AGENTS.md`, etc.) are materialized into each project folder
on demand and are always derived from the home-directory store.

Multiple windows work independently. Each window auto-detects its own context on
open. Changing the active context in one window does not affect any other window.

## Requirements

- [Claude Code CLI](https://claude.ai/code) installed as `claude` on your PATH (WSL: inside WSL, not Windows)
- VS Code 1.80+

## Installation (WSL)

The extension runs server-side inside WSL. Install via symlink so edits to the source
take effect on reload without repackaging:

```bash
mkdir -p ~/.vscode-server/extensions
ln -s /home/Vibe-Projects/AIContext/ai-context-extension \
      ~/.vscode-server/extensions/local.ai-context-runner-2.8.0
```

Then reload VS Code:

```
Ctrl+Shift+P → Developer: Reload Window
```

Verify installation:

```
Ctrl+Shift+P → type "AI:" — all 8 commands should appear
```

## Configuration

Open VS Code Settings (`Ctrl+,`) and search for **AI Context**:

| Setting | Default | Description |
|---|---|---|
| `aiContext.projectsRoot` | _(empty)_ | Root folder for the project picker. Set to e.g. `/home/Vibe-Projects` for WSL. Falls back to `~/projects` if blank. |
| `aiContext.agents` | `["claude","codex","copilot"]` | Which AI agents receive context injection on workspace open. |
| `aiContext.cliPath` | _(empty)_ | Full path to the `claude` binary. Uses `claude` from PATH when blank. |
| `aiContext.autoDetect` | `true` | Auto-load matching context when opening a project folder. |
| `aiContext.scanOnLaunch` | `true` | Scan `projectsRoot` on launch and create context files for new projects. |
| `aiContext.showNotifications` | `true` | Show informational context load/switch notifications. |
| `aiContext.autoGitignore` | `false` | Add injected agent files to project `.gitignore`. |
| `aiContext.contextDir` | _(empty)_ | Override the context store directory. Falls back to `~/.ai-context`. |
| `aiContext.maxActions` | `40` | Maximum recent actions kept in context history. |

### Supported agents

| Value | File written to project root |
|---|---|
| `claude` | `CLAUDE.md` |
| `codex` | `AGENTS.md` |
| `copilot` | `.github/copilot-instructions.md` |
| `cursor` | `.cursorrules` |
| `windsurf` | `.windsurfrules` |
| `kilo` | `KILO.md` |

### WSL example (`settings.json`)

```json
{
  "aiContext.projectsRoot": "/home/Vibe-Projects",
  "aiContext.agents": ["claude", "codex", "copilot"]
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
| `AI: New Context` | — | Create a new context and bind it to a project folder |
| `AI: View Context` | — | Open a context file as formatted JSON |
| `AI: Delete Context` | — | Permanently delete a context |
| `AI: Clean Up Contexts` | — | Bulk archive or delete — orphan detection, age display |
| `AI: Restore Archived Context` | — | Restore a previously archived context |
| `AI: Config` | `Ctrl+Alt+C` | Interactive configuration menu |

## Auto-detection behavior

When you open a project folder, the extension:

1. Scans all contexts in `~/.ai-context/*.json`
2. Finds the context whose `root` is the most specific parent of your workspace folder
3. Sets it active and injects into all configured agent files silently
4. Only shows a notification if it switches away from a previously active context

**Example**: With contexts for `/home/Vibe-Projects/ProjectA` and
`/home/Vibe-Projects/ProjectB`, opening either folder loads the correct context
automatically.

## Context storage

All context files live in `~/.ai-context/` — a global store in your home directory,
independent of any project folder. Each context has a `root` field that binds it to
a project. Injection writes derived files into each project folder.

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
| `m` | Optional metadata |
| `createdAt` | Set once on creation, never modified |
| `lastUsed` | Updated automatically on every save |

## Memory policy

The context file separates durable memory from recent activity:

- `d`, `c`, `f`, and `b` are durable memory fields. Keep these compact and only store information that should survive across sessions.
- `a` is a recent activity trail. The default cap is 40 actions and is configurable with `aiContext.maxActions`.
- When `a` exceeds the cap, older overflow is summarized into `h` before trimming. The agent receives both compact history and recent actions.
- Older or repeated list entries are normalized on save. Lists are deduplicated and trimmed from the oldest entries first.

## Injected format

The full context stays in `~/.ai-context/`. Agent files receive a compact projection:

```text
AI_CONTEXT_V3={"v":3,"p":"ProjectA","root":"/home/Vibe-Projects/ProjectA","t":"current-task","i":"intent / goal","n":"next concrete action","s":{},"mem":{"b":[],"d":[],"c":[],"f":[]},"h":[],"a":[],"e":null}
Use AI_CONTEXT_V3 as authoritative session state. Continue from n; preserve mem/h; append only meaningful recent work to a; update context through CTX_UPDATE when supported.
```

The injected projection omits bookkeeping such as `createdAt`, `lastUsed`, and
compaction metadata to reduce token cost for agents.

## What to gitignore in your projects

```gitignore
CLAUDE.md
AGENTS.md
KILO.md
.cursorrules
.windsurfrules
.github/copilot-instructions.md
```

The `~/.ai-context/` store is user-specific and should not be committed to any project.
