const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const {
    getCtxDir,
    listContexts,
    listArchivedContexts,
    loadContext,
    loadArchivedContext,
    saveContext,
    deleteContext,
    archiveContext,
    restoreArchivedContext,
    listProjectDirs,
    getProjectsRoot,
    normalizePath,
    createDefaultContext,
    getWorkspaceRoot,
    scanAndCreateContexts,
    formatRelativeTime,
} = require('./context');

const {
    autoInject,
    autoInjectCodexBootstrap,
    clearCodexBootstrap,
    clearInjectionForContext,
    getAgents,
    AGENT_TARGETS,
} = require('./inject');
const { getCliPath, buildPrompt, extractContextUpdate, stripContextUpdate, runWithClaude } = require('./claude');

const ACTIVE_KEY = 'ai.activeContext';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getActive(wsState) {
    return wsState.get(ACTIVE_KEY) || null;
}

async function setActive(wsState, name) {
    return wsState.update(ACTIVE_KEY, name);
}

function getCfg() {
    return vscode.workspace.getConfiguration('aiContext');
}

function notify(message) {
    if (getCfg().get('showNotifications') !== false) {
        vscode.window.showInformationMessage(message);
    }
}

function showInjectionResult(name, agents, injected) {
    if (injected) {
        vscode.window.showInformationMessage(`[${name}] active — injected for: ${agents}`);
    } else {
        vscode.window.showWarningMessage(`[${name}] active, but its root is missing or invalid — no files injected.`);
    }
}

function isSameOrChildPath(parent, candidate) {
    if (!parent || !candidate) return false;
    const parentPath    = path.resolve(normalizePath(parent));
    const candidatePath = path.resolve(normalizePath(candidate));
    const relative      = path.relative(parentPath, candidatePath);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

// Best-match: longest ctx.root that contains the workspace root.
function detectContextForPath(dir, workspaceRoot) {
    const normalized = normalizePath(workspaceRoot);
    let matchedName  = null;
    let longestRoot  = 0;

    for (const name of listContexts(dir)) {
        const ctx  = loadContext(dir, name);
        const root = normalizePath(ctx.root);
        if (root && fs.existsSync(root) &&
            isSameOrChildPath(root, normalized) &&
            root.length > longestRoot) {
            matchedName = name;
            longestRoot = root.length;
        }
    }
    return matchedName;
}

function getEditorPath(editor) {
    const uri = editor && editor.document && editor.document.uri;
    if (!uri || !uri.fsPath) return null;
    if (uri.scheme && uri.scheme !== 'file') return null;
    return normalizePath(uri.fsPath);
}

function getTerminalCwd(terminal) {
    const cwd = terminal && terminal.shellIntegration && terminal.shellIntegration.cwd;
    if (!cwd) return null;
    if (typeof cwd === 'string') return normalizePath(cwd);
    return cwd.fsPath ? normalizePath(cwd.fsPath) : null;
}

function syncActiveContextForPath(dir, wsState, candidatePath, options = {}) {
    if (!candidatePath || getCfg().get('autoDetect') === false) return null;

    const matched  = detectContextForPath(dir, candidatePath);
    const previous = getActive(wsState);

    if (matched) {
        setActive(wsState, matched);
        autoInject(loadContext(dir, matched));
        if (matched !== previous && options.notify !== false) {
            notify(`AI Context: ${options.action || 'switched to'} [${matched}]`);
        }
        return matched;
    }

    if (options.fallbackPrevious && previous) {
        autoInject(loadContext(dir, previous));
        return previous;
    }

    return null;
}

// ── Context creation helpers ──────────────────────────────────────────────────

async function pickOrCreateContext(dir, wsState) {
    const existing   = listContexts(dir);
    const active     = getActive(wsState);
    const NEW_OPTION = '$(add) New context...';

    if (existing.length === 0) {
        const name = await vscode.window.showInputBox({
            prompt: 'No contexts found. Enter a name for your first context',
            placeHolder: 'e.g. MyProject, BriefingAgent',
            validateInput: v => (v && v.trim() ? null : 'Name cannot be empty'),
        });
        if (!name) return null;
        return await createContextWithRoot(dir, name.trim()) ? name.trim() : null;
    }

    const items = [
        ...existing.map(name => ({
            label: name,
            description: name === active ? '● active' : '',
        })),
        { label: NEW_OPTION },
    ];

    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select context' });
    if (!pick) return null;

    if (pick.label === NEW_OPTION) {
        const name = await vscode.window.showInputBox({
            prompt: 'New context name',
            placeHolder: 'e.g. MyProject, BriefingAgent',
            validateInput: v => {
                if (!v || !v.trim()) return 'Name cannot be empty';
                if (existing.includes(v.trim())) return 'Context already exists';
                return null;
            },
        });
        if (!name) return null;
        return await createContextWithRoot(dir, name.trim()) ? name.trim() : null;
    }

    return pick.label;
}

async function createContextWithRoot(dir, name) {
    const projectDirs   = listProjectDirs();
    const MANUAL_OPTION = '$(folder) Enter path manually...';

    let projectRoot;

    if (projectDirs.length > 0) {
        const items = [
            ...projectDirs.map(p => ({ label: p.label, description: p.path })),
            { label: MANUAL_OPTION },
        ];
        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: `Select the project folder for context [${name}]`,
        });
        if (!pick) return false;

        projectRoot = pick.label === MANUAL_OPTION
            ? await vscode.window.showInputBox({
                prompt: 'Absolute path to project root',
                value: getProjectsRoot() + path.sep,
                validateInput: v => (v && v.trim() ? null : 'Path cannot be empty'),
            })
            : pick.description;
    } else {
        projectRoot = await vscode.window.showInputBox({
            prompt: 'Absolute path to project root',
            value: getProjectsRoot() + path.sep,
            validateInput: v => (v && v.trim() ? null : 'Path cannot be empty'),
        });
    }

    if (!projectRoot) return false;

    saveContext(dir, name, createDefaultContext(name, projectRoot));
    return true;
}

// ── Activate ──────────────────────────────────────────────────────────────────

function activate(context) {
    const dir     = getCtxDir();
    const wsState = context.workspaceState;

    const hasCodexLikeAgent = () => getAgents().some(agent => agent === 'codex' || agent === 'kilo');
    const syncCodexBootstrap = () => {
        const projectsRoot = getProjectsRoot();
        if (getCfg().get('codexProjectSwitchBootstrap') === false || !hasCodexLikeAgent()) {
            clearCodexBootstrap(projectsRoot);
            return false;
        }
        return autoInjectCodexBootstrap(projectsRoot);
    };

    // ── Scan projectsRoot for new projects ────────────────────────────────────
    if (getCfg().get('scanOnLaunch') !== false) {
        const projectsRoot = getProjectsRoot();
        const created      = scanAndCreateContexts(dir, projectsRoot);
        if (created.length > 0) {
            notify(
                `AI Context: found ${created.length} new project${created.length !== 1 ? 's' : ''} — ${created.join(', ')}`
            );
        }
    }

    syncCodexBootstrap();

    // ── Auto-detect context on startup ────────────────────────────────────────
    if (getCfg().get('autoDetect') !== false) {
        syncActiveContextForPath(dir, wsState, getWorkspaceRoot(), {
            action: 'auto-loaded',
            fallbackPrevious: true,
        });
    } else if (getActive(wsState)) {
        autoInject(loadContext(dir, getActive(wsState)));
    }

    // ── File watcher — re-inject when context JSON changes ───────────────────
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), '*.json')
    );

    const onContextChange = uri => {
        const changedName = path.basename(uri.fsPath, '.json');
        if (changedName === getActive(wsState)) {
            autoInject(loadContext(dir, changedName));
        }
    };

    watcher.onDidChange(onContextChange);
    watcher.onDidCreate(onContextChange);

    // ── Re-detect when workspace folders change ───────────────────────────────
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            syncCodexBootstrap();
            syncActiveContextForPath(dir, wsState, getWorkspaceRoot());
        })
    );

    const syncEditorContext = editor => {
        if (getCfg().get('followActiveEditor') === false) return;
        syncActiveContextForPath(dir, wsState, getEditorPath(editor));
    };

    const syncTerminalContext = terminal => {
        if (getCfg().get('followTerminalCwd') === false) return;
        syncActiveContextForPath(dir, wsState, getTerminalCwd(terminal));
    };

    if (typeof vscode.window.onDidChangeActiveTextEditor === 'function') {
        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(syncEditorContext));
        syncEditorContext(vscode.window.activeTextEditor);
    }

    if (typeof vscode.window.onDidChangeActiveTerminal === 'function') {
        context.subscriptions.push(vscode.window.onDidChangeActiveTerminal(syncTerminalContext));
        syncTerminalContext(vscode.window.activeTerminal);
    }

    if (typeof vscode.window.onDidChangeTerminalShellIntegration === 'function') {
        context.subscriptions.push(vscode.window.onDidChangeTerminalShellIntegration(event => {
            syncTerminalContext(event && event.terminal ? event.terminal : vscode.window.activeTerminal);
        }));
    }

    if (typeof vscode.window.onDidEndTerminalShellExecution === 'function') {
        context.subscriptions.push(vscode.window.onDidEndTerminalShellExecution(event => {
            syncTerminalContext(event && event.terminal ? event.terminal : vscode.window.activeTerminal);
        }));
    }

    // ── AI: Config ────────────────────────────────────────────────────────────
    const agentLabels = {
        claude:   'Claude Code  →  CLAUDE.md',
        codex:    'Codex / OpenAI CLI  →  AGENTS.md',
        copilot:  'GitHub Copilot  →  .github/copilot-instructions.md',
        cursor:   'Cursor  →  .cursorrules',
        windsurf: 'Windsurf  →  .windsurfrules',
        kilo:     'Kilo  →  AGENTS.md',
    };

    const configCmd = vscode.commands.registerCommand('ai.config', async () => {
        // Loop so the menu stays open after each change
        while (true) {
            const cfg = vscode.workspace.getConfiguration('aiContext');

            const bool = (key, def) => cfg.get(key) !== false ? (def !== false) : false;
            const str  = (key, fb) => { const v = cfg.get(key); return v && v.trim() ? v.trim() : fb; };
            const num  = (key, fb) => { const v = cfg.get(key); return (v !== undefined && v !== null) ? v : fb; };
            const arr  = (key, fb) => { const v = cfg.get(key); return Array.isArray(v) && v.length ? v : fb; };

            const agents       = arr('agents', ['claude', 'codex', 'copilot']);
            const autoDetect   = cfg.get('autoDetect') !== false;
            const followEditor = cfg.get('followActiveEditor') !== false;
            const followTerm   = cfg.get('followTerminalCwd') !== false;
            const bootstrap    = cfg.get('codexProjectSwitchBootstrap') !== false;
            const scanOnLaunch = cfg.get('scanOnLaunch') !== false;
            const showNotif    = cfg.get('showNotifications') !== false;
            const autoGit      = cfg.get('autoGitignore') === true;
            const maxAct       = num('maxActions', 40);

            const items = [
                {
                    label:       '$(folder)  Projects Root',
                    description: str('projectsRoot', '~/projects (default)'),
                    detail:      'Root folder scanned for projects on launch · used in project picker',
                    _key:        'projectsRoot',
                    _type:       'string',
                    _prompt:     'Absolute path to your projects root (e.g. /home/Vibe-Projects)',
                    _default:    '',
                },
                {
                    label:       '$(robot)  Active Agents',
                    description: agents.join(', '),
                    detail:      'AI agent files that receive context injection',
                    _key:        'agents',
                    _type:       'multiselect',
                },
                {
                    label:       '$(terminal)  CLI Path',
                    description: str('cliPath', 'claude  (from PATH)'),
                    detail:      'Full path to claude binary — set if not on PATH',
                    _key:        'cliPath',
                    _type:       'string',
                    _prompt:     'Full path to claude binary (e.g. /usr/local/bin/claude)',
                    _default:    '',
                },
                {
                    label:       `$(search)  Auto Detect      ${autoDetect   ? '$(check)' : '$(circle-slash)'}`,
                    description: autoDetect   ? 'on' : 'off',
                    detail:      'Auto-load matching context when a project folder is opened',
                    _key:        'autoDetect',
                    _type:       'boolean',
                },
                {
                    label:       `$(edit)  Follow Active Editor  ${followEditor ? '$(check)' : '$(circle-slash)'}`,
                    description: followEditor ? 'on' : 'off',
                    detail:      'Auto-switch context when the active file is in another tracked project',
                    _key:        'followActiveEditor',
                    _type:       'boolean',
                },
                {
                    label:       `$(terminal)  Follow Terminal CWD  ${followTerm ? '$(check)' : '$(circle-slash)'}`,
                    description: followTerm ? 'on' : 'off',
                    detail:      'Auto-switch context when VS Code shell integration reports a new terminal directory',
                    _key:        'followTerminalCwd',
                    _type:       'boolean',
                },
                {
                    label:       `$(root-folder)  Codex Root Bootstrap  ${bootstrap ? '$(check)' : '$(circle-slash)'}`,
                    description: bootstrap ? 'on' : 'off',
                    detail:      'Write projectsRoot/AGENTS.md so Codex reads project context after a project switch',
                    _key:        'codexProjectSwitchBootstrap',
                    _type:       'boolean',
                },
                {
                    label:       `$(sync)  Scan on Launch   ${scanOnLaunch ? '$(check)' : '$(circle-slash)'}`,
                    description: scanOnLaunch ? 'on' : 'off',
                    detail:      'Scan projectsRoot on launch and create contexts for new projects',
                    _key:        'scanOnLaunch',
                    _type:       'boolean',
                },
                {
                    label:       `$(bell)  Notifications    ${showNotif    ? '$(check)' : '$(circle-slash)'}`,
                    description: showNotif    ? 'on' : 'off',
                    detail:      'Show notification when context auto-loads or switches',
                    _key:        'showNotifications',
                    _type:       'boolean',
                },
                {
                    label:       `$(git-commit)  Auto .gitignore  ${autoGit ? '$(check)' : '$(circle-slash)'}`,
                    description: autoGit      ? 'on' : 'off',
                    detail:      'Automatically add injected files (CLAUDE.md, AGENTS.md…) to .gitignore',
                    _key:        'autoGitignore',
                    _type:       'boolean',
                },
                {
                    label:       '$(database)  Context Store',
                    description: str('contextDir', '~/.ai-context  (default)'),
                    detail:      'Directory where context JSON files are stored',
                    _key:        'contextDir',
                    _type:       'string',
                    _prompt:     'Absolute path to context store directory',
                    _default:    '',
                },
                {
                    label:       '$(list-ordered)  Max Action History',
                    description: String(maxAct),
                    detail:      'Number of recent actions kept in context (1–200)',
                    _key:        'maxActions',
                    _type:       'number',
                },
                {
                    label:       '$(close)  Close',
                    _key:        null,
                },
            ];

            const pick = await vscode.window.showQuickPick(items, {
                placeHolder:       'AI Context Runner — Configuration  (select a setting to change it)',
                matchOnDescription: true,
                matchOnDetail:      true,
            });

            if (!pick || pick._key === null) return;

            const previousProjectsRoot = getProjectsRoot();

            // ── Toggle boolean ──────────────────────────────────────────────
            if (pick._type === 'boolean') {
                const current = cfg.get(pick._key) !== false;
                await cfg.update(pick._key, !current, vscode.ConfigurationTarget.Global);

            // ── Multi-select (agents) ───────────────────────────────────────
            } else if (pick._type === 'multiselect') {
                const current    = arr('agents', ['claude', 'codex', 'copilot']);
                const agentItems = Object.entries(agentLabels).map(([id, label]) => ({
                    label,
                    description: id,
                    picked:      current.includes(id),
                }));
                const selected = await vscode.window.showQuickPick(agentItems, {
                    placeHolder: 'Select which AI agents receive context injection',
                    canPickMany: true,
                });
                if (selected && selected.length > 0) {
                    await cfg.update('agents', selected.map(s => s.description), vscode.ConfigurationTarget.Global);
                }

            // ── Number ─────────────────────────────────────────────────────
            } else if (pick._type === 'number') {
                const current = String(num(pick._key, 40));
                const input   = await vscode.window.showInputBox({
                    prompt:        `Set "${pick._key}"`,
                    value:         current,
                    validateInput: v => (!isNaN(parseInt(v)) && parseInt(v) > 0) ? null : 'Must be a positive number',
                });
                if (input !== undefined && input !== '') {
                    await cfg.update(pick._key, parseInt(input), vscode.ConfigurationTarget.Global);
                }

            // ── String ─────────────────────────────────────────────────────
            } else {
                const current = str(pick._key, '');
                const input   = await vscode.window.showInputBox({
                    prompt:      pick._prompt || `Set "${pick._key}"`,
                    value:       current,
                    placeHolder: pick.description,
                });
                if (input !== undefined) {
                    // Allow clearing a setting by entering empty string
                    await cfg.update(pick._key, input.trim() || undefined, vscode.ConfigurationTarget.Global);
                }
            }

            if (pick._key === 'projectsRoot' && previousProjectsRoot !== getProjectsRoot()) {
                clearCodexBootstrap(previousProjectsRoot);
            }
            syncCodexBootstrap();
        }
    });

    // ── AI: Set Active Context ────────────────────────────────────────────────
    const setActiveCmd = vscode.commands.registerCommand('ai.setActiveContext', async () => {
        const contexts = listContexts(dir);
        if (contexts.length === 0) {
            vscode.window.showInformationMessage(
                'No contexts found. Use "AI: New Context" or "AI: Run Task" to create one first.'
            );
            return;
        }

        const current = getActive(wsState);
        const agents  = getAgents().join(', ');
        const pick    = await vscode.window.showQuickPick(
            contexts.map(name => {
                const ctx = loadContext(dir, name);
                return {
                    label:       name,
                    description: (ctx.root || 'no root set') + (name === current ? '  ● active' : ''),
                    detail:      `last used: ${formatRelativeTime(ctx.lastUsed)}  ·  created: ${formatRelativeTime(ctx.createdAt)}`,
                };
            }),
            { placeHolder: `Set active context for THIS window  [agents: ${agents}]` }
        );
        if (!pick) return;

        await setActive(wsState, pick.label);
        showInjectionResult(pick.label, agents, autoInject(loadContext(dir, pick.label)));
    });

    // ── AI: Run Task ──────────────────────────────────────────────────────────
    const runTask = vscode.commands.registerCommand('ai.runTask', async () => {
        const ctxName = await pickOrCreateContext(dir, wsState);
        if (!ctxName) return;

        const task = await vscode.window.showInputBox({
            prompt:        `Task for [${ctxName}]`,
            placeHolder:   'What do you want to do?',
            validateInput: v => (v && v.trim() ? null : 'Task cannot be empty'),
        });
        if (!task) return;

        const ctx    = loadContext(dir, ctxName);
        const prompt = buildPrompt(ctx, task.trim());

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Running [${ctxName}] via ${getCliPath()}...`, cancellable: false },
            async () => {
                let response;
                try {
                    response = await runWithClaude(prompt);
                } catch (err) {
                    vscode.window.showErrorMessage(`CLI failed: ${err.message}`);
                    return;
                }

                const newCtx = extractContextUpdate(response);
                if (newCtx) {
                    saveContext(dir, ctxName, {
                        ...ctx,
                        ...newCtx,
                        root:      ctx.root,
                        createdAt: ctx.createdAt,
                    });
                } else {
                    vscode.window.showWarningMessage('Response received but no CTX_UPDATE found — context unchanged');
                }

                const doc = await vscode.workspace.openTextDocument({
                    content:  stripContextUpdate(response),
                    language: 'markdown',
                });
                await vscode.window.showTextDocument(doc, { preview: false });
            }
        );
    });

    // ── AI: View Context ──────────────────────────────────────────────────────
    const viewContext = vscode.commands.registerCommand('ai.viewContext', async () => {
        const contexts = listContexts(dir);
        if (contexts.length === 0) {
            vscode.window.showInformationMessage('No contexts found.');
            return;
        }

        const active = getActive(wsState);
        const pick   = await vscode.window.showQuickPick(
            contexts.map(name => {
                const ctx = loadContext(dir, name);
                return {
                    label:       name,
                    description: (ctx.root || 'no root') + (name === active ? '  ● active' : ''),
                    detail:      `last used: ${formatRelativeTime(ctx.lastUsed)}  ·  created: ${formatRelativeTime(ctx.createdAt)}`,
                };
            }),
            { placeHolder: 'Select context to view' }
        );
        if (!pick) return;

        const doc = await vscode.workspace.openTextDocument({
            content:  JSON.stringify(loadContext(dir, pick.label), null, 2),
            language: 'json',
        });
        await vscode.window.showTextDocument(doc);
    });

    // ── AI: New Context ───────────────────────────────────────────────────────
    const newContext = vscode.commands.registerCommand('ai.newContext', async () => {
        const existing = listContexts(dir);
        const name     = await vscode.window.showInputBox({
            prompt:        'New context name',
            placeHolder:   'e.g. MyProject, BriefingAgent',
            validateInput: v => {
                if (!v || !v.trim()) return 'Name cannot be empty';
                if (existing.includes(v.trim())) return 'Context already exists';
                return null;
            },
        });
        if (!name) return;

        const created = await createContextWithRoot(dir, name.trim());
        if (!created) return;

        const makeActive = await vscode.window.showInformationMessage(
            `Context [${name.trim()}] created. Set as active in this window?`,
            'Yes', 'No'
        );
        if (makeActive === 'Yes') {
            await setActive(wsState, name.trim());
            showInjectionResult(name.trim(), getAgents().join(', '), autoInject(loadContext(dir, name.trim())));
        }
    });

    // ── AI: Delete Context ────────────────────────────────────────────────────
    const deleteCtx = vscode.commands.registerCommand('ai.deleteContext', async () => {
        const contexts = listContexts(dir);
        if (contexts.length === 0) {
            vscode.window.showInformationMessage('No contexts to delete.');
            return;
        }

        const active = getActive(wsState);
        const pick   = await vscode.window.showQuickPick(
            contexts.map(name => {
                const ctx = loadContext(dir, name);
                return {
                    label:       name,
                    description: (ctx.root || 'no root') + (name === active ? '  ● active' : ''),
                    detail:      `last used: ${formatRelativeTime(ctx.lastUsed)}`,
                };
            }),
            { placeHolder: 'Select context to delete' }
        );
        if (!pick) return;

        const confirm = await vscode.window.showWarningMessage(
            `Permanently delete [${pick.label}]? Consider "AI: Clean Up Contexts" to archive instead.`,
            { modal: true },
            'Delete'
        );
        if (confirm !== 'Delete') return;

        const ctx = loadContext(dir, pick.label);
        deleteContext(dir, pick.label);

        if (pick.label === active) {
            await setActive(wsState, null);
            clearInjectionForContext(ctx);
            vscode.window.showInformationMessage(`[${pick.label}] deleted — injection blocks removed.`);
        } else {
            vscode.window.showInformationMessage(`Context [${pick.label}] deleted`);
        }
    });

    // ── AI: Clean Up Contexts ─────────────────────────────────────────────────
    const cleanUp = vscode.commands.registerCommand('ai.cleanUpContexts', async () => {
        const contexts = listContexts(dir);
        if (contexts.length === 0) {
            vscode.window.showInformationMessage('No contexts found.');
            return;
        }

        const active = getActive(wsState);
        const items  = contexts.map(name => {
            const ctx      = loadContext(dir, name);
            const rootOk   = !!(ctx.root && fs.existsSync(normalizePath(ctx.root)));
            const isActive = name === active;
            return {
                label:       rootOk ? name : `⚠  ${name}`,
                description: ctx.root || 'no root set',
                detail:      [
                    rootOk ? null : 'path not found',
                    `last used: ${formatRelativeTime(ctx.lastUsed)}`,
                    `created: ${formatRelativeTime(ctx.createdAt)}`,
                    isActive ? '● active in this window' : null,
                ].filter(Boolean).join('  ·  '),
                picked:    !rootOk,
                _name:     name,
                _isOrphan: !rootOk,
            };
        });

        const orphanCount = items.filter(i => i._isOrphan).length;
        const picks       = await vscode.window.showQuickPick(items, {
            placeHolder: `${contexts.length} total  ·  ${orphanCount} orphaned (path not found) — select to archive or delete`,
            canPickMany: true,
        });
        if (!picks || picks.length === 0) return;

        const action = await vscode.window.showQuickPick([
            {
                label:       '$(archive) Archive',
                description: 'Move to archive/  —  recoverable with "AI: Restore Archived Context"',
                value:       'archive',
            },
            {
                label:       '$(trash) Delete permanently',
                description: 'Cannot be undone',
                value:       'delete',
            },
        ], { placeHolder: `${picks.length} context(s) selected — choose action` });
        if (!action) return;

        if (action.value === 'delete') {
            const confirm = await vscode.window.showWarningMessage(
                `Permanently delete ${picks.length} context(s)? This cannot be undone.`,
                { modal: true },
                'Delete'
            );
            if (confirm !== 'Delete') return;
        }

        for (const pick of picks) {
            const ctx = loadContext(dir, pick._name);
            if (action.value === 'archive') {
                archiveContext(dir, pick._name);
            } else {
                deleteContext(dir, pick._name);
            }
            if (pick._name === active) {
                await setActive(wsState, null);
                clearInjectionForContext(ctx);
            }
        }

        const verb = action.value === 'archive' ? 'Archived' : 'Deleted';
        vscode.window.showInformationMessage(`${verb} ${picks.length} context(s)`);
    });

    // ── AI: Restore Archived Context ──────────────────────────────────────────
    const restoreCtx = vscode.commands.registerCommand('ai.restoreContext', async () => {
        const archived = listArchivedContexts();
        if (archived.length === 0) {
            vscode.window.showInformationMessage('No archived contexts found.');
            return;
        }

        const items = archived.map(archiveName => {
            const ctx      = loadArchivedContext(archiveName);
            const baseName = archiveName.replace(/_\d{13}$/, '');
            return {
                label:        baseName,
                description:  ctx.root || 'no root',
                detail:       `last used: ${formatRelativeTime(ctx.lastUsed)}  ·  created: ${formatRelativeTime(ctx.createdAt)}`,
                _archiveName: archiveName,
            };
        });

        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select archived context to restore',
        });
        if (!pick) return;

        const restoredName = restoreArchivedContext(pick._archiveName);

        const makeActive = await vscode.window.showInformationMessage(
            `[${restoredName}] restored. Set as active in this window?`,
            'Yes', 'No'
        );
        if (makeActive === 'Yes') {
            await setActive(wsState, restoredName);
            showInjectionResult(restoredName, getAgents().join(', '), autoInject(loadContext(dir, restoredName)));
        }
    });

    context.subscriptions.push(
        configCmd, setActiveCmd, runTask, viewContext, newContext,
        deleteCtx, cleanUp, restoreCtx, watcher
    );
}

function deactivate() {}

module.exports = {
    activate,
    deactivate,
    __test: {
        detectContextForPath,
        getEditorPath,
        getTerminalCwd,
        isSameOrChildPath,
        syncActiveContextForPath,
    },
};
