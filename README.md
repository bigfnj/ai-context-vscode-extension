# AI Context Runner

A VS Code extension that gives Claude Code and GitHub Copilot persistent memory across
sessions — automatically, with no manual steps after first-time setup per project.

## How it works

On every VS Code launch, the extension reads the active context for that window and
writes it into two files that AI tools read automatically:

- `CLAUDE.md` — read by Claude Code at the start of every session
- `.github/copilot-instructions.md` — read by GitHub Copilot Chat automatically

A file watcher keeps both files current after every task run, so the AI always has
the latest state without any manual action.

```
VS Code launches
  → reads active context for this window (workspaceState)
  → injects into {project}/CLAUDE.md + {project}/.github/copilot-instructions.md
  → open Claude or Copilot — context already there

Task runs → Claude responds with CTX_UPDATE:
  → context file saved to ~/.ai-context/
  → file watcher fires
  → CLAUDE.md + copilot-instructions.md updated automatically
  → next session picks up the new state
```

Multiple windows work independently. Each window tracks its own active context —
changing the active context in one window does not affect any other window.

## Requirements

- [Claude Code CLI](https://claude.ai/code) installed and available as `claude` on your PATH
- VS Code 1.80+

## Installation (WSL)

The extension runs server-side inside WSL. Install via symlink so edits to the source
take effect on reload without repackaging:

```bash
mkdir -p ~/.vscode-server/extensions
ln -s /path/to/ai-context-extension \
      ~/.vscode-server/extensions/local.ai-context-runner-2.3.0
```

Then reload VS Code:

```
Ctrl+Shift+P → Developer: Reload Window
```

Verify installation:

```
Ctrl+Shift+P → type "AI:" — all 7 commands should appear
```

## First-time setup (one step, per window)

```
Ctrl+Alt+S → AI: Set Active Context → pick or create a context
```

That's it. Every launch from that point is fully automatic for that window.

## Commands

| Command | Shortcut | Description |
|---|---|---|
| `AI: Run Task` | `Ctrl+Alt+A` | Run a task using the selected context via Claude CLI |
| `AI: Set Active Context` | `Ctrl+Alt+S` | Set which context auto-injects on launch for this window |
| `AI: New Context` | — | Create a new context and bind it to a project folder |
| `AI: View Context` | — | Open a context file as formatted JSON |
| `AI: Delete Context` | — | Permanently delete a context |
| `AI: Clean Up Contexts` | — | Bulk archive or delete — orphan detection, age display |
| `AI: Restore Archived Context` | — | Restore a previously archived context |

## Context storage

All context files live in `~/.ai-context/` — a single global store shared across all
windows and workspaces. Each context has a `root` field that binds it to its project
folder. Injection always targets `{root}/CLAUDE.md` and `{root}/.github/copilot-instructions.md`.

```
~/.ai-context/
  BriefingAgent.json
  AIContext.json
  OldProject.json
  archive/
    OldProject_1714000000000.json   ← archived, not deleted
```

## Context file format

```json
{
  "v": 1,
  "u": "username",
  "p": "project-name",
  "root": "/home/user/projects/@Project-Name",
  "t": "current-task",
  "s": {},
  "a": [],
  "e": null,
  "i": "intent / goal",
  "createdAt": "2026-04-28T12:00:00.000Z",
  "lastUsed": "2026-04-28T14:30:00.000Z"
}
```

| Key | Meaning |
|---|---|
| `v` | Schema version |
| `u` | User / actor |
| `p` | Project name (display label) |
| `root` | Absolute path to the project folder — controls where CLAUDE.md is written |
| `t` | Current task |
| `s` | State — active working object, params, conditions |
| `a` | Recent actions (string array) |
| `e` | Last error, or null |
| `i` | Intent / goal |
| `m` | Metadata (optional, freeform object) |
| `createdAt` | ISO timestamp — set once on creation, never modified |
| `lastUsed` | ISO timestamp — updated automatically on every save |

## Cleaning up

`AI: Clean Up Contexts` scans all contexts and detects orphans — contexts whose `root`
path no longer exists on disk. Orphans are pre-selected. For each context you can see:

- Whether the project folder still exists
- How long ago it was last used
- When it was created

Choose **Archive** to move to `~/.ai-context/archive/` (recoverable via
`AI: Restore Archived Context`) or **Delete permanently**.

## What to gitignore in your projects

Add to each project's `.gitignore` to avoid committing auto-injected AI files:

```
CLAUDE.md
.github/copilot-instructions.md
```

Whether to commit `CLAUDE.md` depends on whether you want the context shared with
teammates. The `~/.ai-context/` store itself is user-specific and should not be
committed to any project.
