# AI_UNDERSTANDING — Format Specification

**Status:** Draft, schema v1
**Owner:** ai-context-vscode-extension
**Purpose:** Define the on-disk format, validation rules, and update protocol for a project's persistent AI codebase model.

This file is the contract. Tooling (the extension), AI agents (Claude / Codex / future), and humans all read this document to know what is required, what is forbidden, and what is optional.

---

## 1. What this is, and what it isn't

`AI_UNDERSTANDING/` is a per-project, git-tracked, machine-edited model of the codebase. It captures **structure, per-file purpose, exports/imports, call relationships, invariants, gotchas**, and project-wide framework/dependency context.

It is **not**:

- Human documentation (that is `README.md`).
- Session state (that is `~/.ai-context/<project>.json`).
- A substitute for tests, types, or the source code itself.

Single source of truth for *durable code understanding*. Lives with the code, ships with the code, reviewed in PRs like the code.

---

## 2. Directory layout

```text
<project-root>/
└── AI_UNDERSTANDING/
    ├── _meta.json                       # project-wide
    ├── src/
    │   ├── context.js.aiu.json
    │   ├── extension.js.aiu.json
    │   └── settingsView.js.aiu.json
    ├── test/
    │   └── run-unit.js.aiu.json
    └── package.json.aiu.json
```

Rules:

- `AI_UNDERSTANDING/` lives at project root, sibling to `src/`, `package.json`, etc.
- The directory mirrors the source tree.
- Each tracked source file `<path>` has a sidecar `AI_UNDERSTANDING/<path>.aiu.json`.
- Project-wide data lives in `AI_UNDERSTANDING/_meta.json`.
- No other files belong in `AI_UNDERSTANDING/`. Tools may refuse to operate when unknown files are present.

---

## 3. Per-file schema (`*.aiu.json`)

```json
{
  "schema": 1,
  "path": "src/context.js",
  "sha1": "ab12cd34ef56...",
  "purpose": "Context store CRUD + schema normalization + compaction.",
  "exports": ["getCtxDir", "loadContext", "saveContext"],
  "imports": ["vscode", "fs", "path", "os"],
  "called_by": ["src/extension.js", "src/settingsView.js"],
  "calls_out_to": ["vscode.workspace.getConfiguration", "fs.*"],
  "invariants": [
    "createdAt is set once on creation and preserved across saves.",
    "perms.allow migrates from legacy perms.claude on read."
  ],
  "gotchas": [
    "normalizePath strips trailing slashes — root equality compares require it."
  ],
  "key_functions": [
    {
      "name": "compactActions",
      "summary": "Folds overflow actions into history (h) when count exceeds DEFAULT_MAX_ACTIONS."
    }
  ]
}
```

### Field reference

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `schema` | integer | yes | Format version. Currently `1`. |
| `path` | string | yes | Project-relative POSIX path of the source file this entry describes. Must equal the entry's location under `AI_UNDERSTANDING/` (minus `.aiu.json`). |
| `sha1` | string (40 hex) | yes | SHA-1 of the source file's exact byte content at last update. Drives staleness detection. |
| `purpose` | string | yes | One- or two-sentence statement of why this file exists. |
| `exports` | string[] | yes | Top-level exported names (functions, classes, constants). Empty array allowed. |
| `imports` | string[] | yes | External modules and project-local paths this file depends on. Empty array allowed. |
| `called_by` | string[] | yes | Project-relative paths of files that import or invoke this one. May be empty for entry points. |
| `calls_out_to` | string[] | yes | Notable external APIs/modules invoked (e.g., `vscode.window.*`, `fs.*`). May be empty. |
| `invariants` | string[] | yes | Properties that must hold across any change. The "if you break this, X breaks" list. Empty array allowed. |
| `gotchas` | string[] | yes | Surprising behavior, hidden constraints, footguns. Empty array allowed. |
| `key_functions` | object[] | optional | Per-function notes (`{name, summary}`). Use sparingly — only for functions whose role isn't clear from name alone. |

All string fields use plain text. Newlines escape as `\n` in JSON — no markdown rendering is implied. Keep entries tight; verbosity hurts the AI's ability to update them precisely.

---

## 4. Project meta schema (`_meta.json`)

```json
{
  "schema": 1,
  "project": "ai-context-vscode-extension",
  "last_audit_commit": "56c0349",
  "last_audit_at": "2026-05-07T15:00:00Z",
  "generator": "aicontext-extension/3.11.0",
  "overview": "Single-window VS Code extension. Auto-injects per-project AI_CONTEXT JSON into CLAUDE.md / AGENTS.md, harvests permissions, syncs Codex trust+sandbox.",
  "frameworks": [
    {"name": "Node.js"},
    {"name": "VS Code Extension API", "version": "^1.84"}
  ],
  "test_command": "node test/run-unit.js",
  "tracked_globs": {
    "include": ["src/**", "test/**", "package.json"],
    "exclude": ["node_modules/**", "dist/**", "*.lock", "package-lock.json"]
  },
  "graph": "extension.js -> context.js (CRUD)\nextension.js -> settingsView.js (webview)\ncontext.js -> vscode.workspace, fs"
}
```

### Field reference

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `schema` | integer | yes | Format version. Currently `1`. |
| `project` | string | yes | Project identifier (matches `package.json#name` or context's `p`). |
| `last_audit_commit` | string | yes | Short SHA of the commit at which the AI agent last performed a full sweep. Updated *only* by the AI, *only* when it has confirmed every entry is current. |
| `last_audit_at` | string (ISO 8601) | yes | Timestamp paired with `last_audit_commit`. |
| `generator` | string | yes | Tool that produced/last touched the structure (e.g., `aicontext-extension/3.11.0`). |
| `overview` | string | yes | 1–3 sentence project summary. The "elevator pitch." |
| `frameworks` | object[] | yes | `{name, version?}` entries for runtime/framework dependencies that shape the codebase. Not every npm dep — just the ones an agent must know about. |
| `test_command` | string | optional | Canonical command to run the test suite. |
| `tracked_globs` | object | yes | `{include, exclude}` glob arrays. Controls what gets a `.aiu.json` sidecar. |
| `graph` | string | yes | Free-form text dependency map. Each line is one edge. Kept as a string (not structured) because the relations vary too widely for a fixed schema; the AI is good at reading text graphs. |

---

## 5. Tracking scope

The default `tracked_globs` for new projects:

**Include:**

- `src/**`
- `test/**` (or `tests/**`, `__tests__/**` if present)
- `package.json`
- Top-level config files: `*.config.{js,ts,json,mjs,cjs}`, `tsconfig.json`, `vite.config.*`, `webpack.config.*`

**Exclude:**

- `node_modules/**`
- `dist/**`, `build/**`, `out/**`, `coverage/**`
- `*.lock`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`
- Binary assets: `*.png`, `*.jpg`, `*.jpeg`, `*.gif`, `*.svg`, `*.ico`, `*.woff*`, `*.ttf`, `*.eot`
- `.vscode-test/**`, `.git/**`

**Documentation files** (`README.md`, `CHANGELOG.md`, `AGENTS.md`, `CLAUDE.md`, `LICENSE`, `AI_UNDERSTANDING_FORMAT.md`) get **no `.aiu.json` sidecar**. They are acknowledged in `_meta.json#overview` if relevant. Documentation is for humans; AI_UNDERSTANDING models code.

Project owners may override globs by editing `_meta.json#tracked_globs`. The extension respects whatever is committed.

---

## 6. Staleness semantics

For each path matched by `tracked_globs.include` and not by `tracked_globs.exclude`:

| Source file state | Sidecar state | Staleness verdict |
| --- | --- | --- |
| exists | exists, `sha1` matches source | **fresh** |
| exists | exists, `sha1` differs from source | **stale** |
| exists | missing | **untracked** |
| missing | exists | **orphan** |

Staleness is computed on demand. There is no persistent index file; per-file `sha1` is the authoritative signal.

A project is "AIU-clean" when every tracked file is **fresh** and there are no orphans.

---

## 7. Validator rules

The extension's `understanding.js` module enforces these on every write. Any violation rejects the write — no partial application.

### Per-entry rules

1. **Schema match:** all required fields present, types correct, no unknown top-level keys.
2. **Path identity:** `path` field equals the entry's filesystem location under `AI_UNDERSTANDING/` (minus `.aiu.json`).
3. **`sha1` format:** exactly 40 lowercase hex characters.
4. **No empty required strings:** `purpose` must be non-empty. (Empty arrays for list fields are allowed.)
5. **Schema version:** `schema` must equal `1`. Future versions trigger a migration path, not silent acceptance.

### Cross-entry rules (operation-level)

1. **Mass-edit cap:** a single operation may not modify more than **33%** of existing `.aiu.json` files. Exception: `bootstrap` mode (see §8.1).
2. **No orphan creation:** an operation that deletes a `.aiu.json` must be paired with a source-file deletion in the same git commit (enforced by hook, §9).
3. **Path mirror:** the directory layout under `AI_UNDERSTANDING/` must mirror the source tree. Tools refuse to create entries that don't correspond to a path under the project root.

### `_meta.json` rules

1. **`last_audit_commit` is AI-managed.** The extension never auto-bumps it. It is updated only when an AI agent has confirmed every entry is fresh.
2. **`tracked_globs` changes** trigger a project-wide rescan and may produce many untracked/orphan flags. This is expected; bootstrap-mode rules apply when the rescan triggers >33% changes.

---

## 8. Update protocol for AI agents

### 8.1 Bootstrap (one-time per project)

Triggered by the extension's `Initialize AI Understanding` command.

1. Extension generates **skeleton `.aiu.json` files** mechanically: `path`, `sha1`, and empty `exports`/`imports`/`called_by`/`calls_out_to`/`invariants`/`gotchas` arrays. `purpose` is set to the literal string `"TODO"`.
2. Extension generates `_meta.json` with detected `frameworks` (from `package.json`), default `tracked_globs`, and an empty `overview`/`graph`.
3. Bootstrap mode is now active. Validator allows mass edits.
4. AI agent fills in `purpose`, `exports`, `imports`, `called_by`, `calls_out_to`, `invariants`, `gotchas` for each entry, plus `_meta.json#overview` and `_meta.json#graph`.
5. AI agent sets `_meta.json#last_audit_commit` to current HEAD and exits bootstrap mode.

Bootstrap may take many AI turns. The extension surfaces a "bootstrap incomplete" status until every `purpose` is non-`TODO`.

### 8.2 Day-to-day

When an AI agent edits source files in a turn:

1. Before ending the turn, the agent **must** update the `.aiu.json` sidecar of every source file it modified:
   - Recompute `sha1` from the new content.
   - Refresh `exports`, `imports`, `called_by`, `calls_out_to` if those changed.
   - Add/edit `invariants` and `gotchas` if the change established or removed any.
   - Update `purpose` if the file's role shifted.
2. The agent **must not** rewrite entries for files it didn't touch.
3. The agent **must not** regenerate `AI_UNDERSTANDING/` from scratch under any circumstance. The validator will reject mass edits outside bootstrap mode, but the rule is: incremental, scoped, surgical.

### 8.3 Sweep

Periodically, the extension's CLAUDE.md auto-block injects a list:

```text
AIU_STALE=["src/foo.js","src/bar.js"]
AIU_UNTRACKED=["src/new-feature.js"]
AIU_ORPHAN=["AI_UNDERSTANDING/src/removed.js.aiu.json"]
```

The agent processes the list, updates/creates/deletes the named entries, and when the list is empty:

- Updates `_meta.json#last_audit_commit` to current HEAD.
- Updates `_meta.json#last_audit_at` to current ISO timestamp.

### 8.4 What an agent must never do

- Write to `AI_UNDERSTANDING/` outside the per-file API.
- Bump `last_audit_commit` without first confirming staleness is empty.
- Add entries for files that don't exist on disk.
- Delete entries for files that still exist on disk.
- Bypass validator errors by hand-editing JSON to look valid.

---

## 9. Pre-commit hook behavior (opt-in)

The extension can install a pre-commit hook (`.git/hooks/pre-commit`) on user opt-in. Default mode is **block-narrow**:

- For each source file in the staged diff:
  - If the file is matched by `tracked_globs.include`:
    - If its `.aiu.json` is missing or its `sha1` does not match the staged content → **block the commit**.
- If a `.aiu.json` is staged for deletion:
  - If the matching source file is *not* also staged for deletion → **block the commit**.
- All other commits proceed.

Hook output names the offending paths and prints the command to fix (`<extension command name TBD>`). User can override with `git commit --no-verify` for emergencies.

The hook is a self-contained shell script. It does not require the extension to be running.

---

## 10. Versioning and migration

- Schema version lives in every `.aiu.json` and in `_meta.json` (`schema` field).
- Current version: `1`.
- Future schema changes (`schema: 2+`) require a migration tool shipped with the extension. The extension refuses to operate on a project whose schema it doesn't understand.
- Schema is forward-compatible only via explicit migration. There is no "best-effort" reading of unknown schemas.

---

## 11. Out of scope (for v1)

- No automated graph derivation (e.g., AST-based import scanning). The agent populates `imports`/`called_by` from reading the code.
- No nested entries per source file (e.g., one entry per exported function). One file → one sidecar.
- No human-rendered view (no markdown export, no dashboard). The JSON is the artifact.
- No multi-project / monorepo aggregation. One `AI_UNDERSTANDING/` per project root.

These may move in scope in later schema versions if the v1 design proves limiting.
