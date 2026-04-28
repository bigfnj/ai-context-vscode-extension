const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
    formatRelativeTime,
} = require('./context');

const { autoInject, clearInjectionForContext } = require('./inject');
const { buildPrompt, extractContextUpdate, stripContextUpdate, runWithClaude } = require('./claude');

const ACTIVE_KEY = 'ai.activeContext';

function getActive(wsState) {
    return wsState.get(ACTIVE_KEY) || null;
}

async function setActive(wsState, name) {
    return wsState.update(ACTIVE_KEY, name);
}

async function pickOrCreateContext(dir, wsState) {
    const existing   = listContexts(dir);
    const active     = getActive(wsState);
    const NEW_OPTION = '$(add) New context...';

    if (existing.length === 0) {
        const name = await vscode.window.showInputBox({
            prompt: 'No contexts found. Enter a name for your first context',
            placeHolder: 'e.g. BriefingAgent, AIContext',
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
            placeHolder: 'e.g. BriefingAgent, AIContext',
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
                value: path.join(os.homedir(), 'projects') + '/',
                validateInput: v => (v && v.trim() ? null : 'Path cannot be empty'),
            })
            : pick.description;
    } else {
        projectRoot = await vscode.window.showInputBox({
            prompt: 'Absolute path to project root',
            value: path.join(os.homedir(), 'projects') + '/',
            validateInput: v => (v && v.trim() ? null : 'Path cannot be empty'),
        });
    }

    if (!projectRoot) return false;

    saveContext(dir, name, {
        v: 1,
        u: os.userInfo().username,
        p: name,
        root: projectRoot.trim(),
        t: 'init',
        s: {},
        a: [],
        e: null,
        i: '',
        createdAt: new Date().toISOString(),
    });
    return true;
}

function activate(context) {
    const dir     = getCtxDir();
    const wsState = context.workspaceState;

    // ── Auto-inject on startup ────────────────────────────────────────────────
    const activeName = getActive(wsState);
    if (activeName) {
        autoInject(loadContext(dir, activeName));
    }

    // ── File watcher ──────────────────────────────────────────────────────────
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
        const pick = await vscode.window.showQuickPick(
            contexts.map(name => {
                const ctx = loadContext(dir, name);
                return {
                    label: name,
                    description: (ctx.root || 'no root set') + (name === current ? '  ● active' : ''),
                    detail: `last used: ${formatRelativeTime(ctx.lastUsed)}  ·  created: ${formatRelativeTime(ctx.createdAt)}`,
                };
            }),
            { placeHolder: 'Set active context for THIS window' }
        );
        if (!pick) return;

        await setActive(wsState, pick.label);
        autoInject(loadContext(dir, pick.label));
        vscode.window.showInformationMessage(
            `[${pick.label}] active in this window — injected into its project folder`
        );
    });

    // ── AI: Run Task ──────────────────────────────────────────────────────────
    const runTask = vscode.commands.registerCommand('ai.runTask', async () => {
        const ctxName = await pickOrCreateContext(dir, wsState);
        if (!ctxName) return;

        const task = await vscode.window.showInputBox({
            prompt: `Task for [${ctxName}]`,
            placeHolder: 'What do you want to do?',
            validateInput: v => (v && v.trim() ? null : 'Task cannot be empty'),
        });
        if (!task) return;

        const ctx    = loadContext(dir, ctxName);
        const prompt = buildPrompt(ctx, task.trim());

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Claude running [${ctxName}]...`, cancellable: false },
            async () => {
                let response;
                try {
                    response = await runWithClaude(prompt);
                } catch (err) {
                    vscode.window.showErrorMessage(`Claude failed: ${err.message}`);
                    return;
                }

                const newCtx = extractContextUpdate(response);
                if (newCtx) {
                    // Preserve fields the AI must not overwrite
                    newCtx.root      = ctx.root;
                    newCtx.createdAt = ctx.createdAt;
                    saveContext(dir, ctxName, newCtx);
                } else {
                    vscode.window.showWarningMessage('Response received but no CTX_UPDATE found — context unchanged');
                }

                const doc = await vscode.workspace.openTextDocument({
                    content: stripContextUpdate(response),
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
        const pick = await vscode.window.showQuickPick(
            contexts.map(name => {
                const ctx = loadContext(dir, name);
                return {
                    label: name,
                    description: (ctx.root || 'no root') + (name === active ? '  ● active' : ''),
                    detail: `last used: ${formatRelativeTime(ctx.lastUsed)}  ·  created: ${formatRelativeTime(ctx.createdAt)}`,
                };
            }),
            { placeHolder: 'Select context to view' }
        );
        if (!pick) return;

        const doc = await vscode.workspace.openTextDocument({
            content: JSON.stringify(loadContext(dir, pick.label), null, 2),
            language: 'json',
        });
        await vscode.window.showTextDocument(doc);
    });

    // ── AI: New Context ───────────────────────────────────────────────────────
    const newContext = vscode.commands.registerCommand('ai.newContext', async () => {
        const existing = listContexts(dir);
        const name = await vscode.window.showInputBox({
            prompt: 'New context name',
            placeHolder: 'e.g. BriefingAgent, AIContext',
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
            autoInject(loadContext(dir, name.trim()));
            vscode.window.showInformationMessage(`[${name.trim()}] active — injected into its project folder`);
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
        const pick = await vscode.window.showQuickPick(
            contexts.map(name => {
                const ctx = loadContext(dir, name);
                return {
                    label: name,
                    description: (ctx.root || 'no root') + (name === active ? '  ● active' : ''),
                    detail: `last used: ${formatRelativeTime(ctx.lastUsed)}`,
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
    // Shows all contexts with orphan detection (root path missing) and last-used
    // timestamps. Orphaned contexts are pre-selected. User can bulk archive or delete.
    const cleanUp = vscode.commands.registerCommand('ai.cleanUpContexts', async () => {
        const contexts = listContexts(dir);
        if (contexts.length === 0) {
            vscode.window.showInformationMessage('No contexts found.');
            return;
        }

        const active = getActive(wsState);
        const items = contexts.map(name => {
            const ctx       = loadContext(dir, name);
            const rootOk    = !!(ctx.root && fs.existsSync(ctx.root));
            const lastUsed  = formatRelativeTime(ctx.lastUsed);
            const created   = formatRelativeTime(ctx.createdAt);
            const isActive  = name === active;

            return {
                label:       rootOk ? name : `⚠  ${name}`,
                description: ctx.root || 'no root set',
                detail:      [
                    rootOk ? null : 'path not found',
                    `last used: ${lastUsed}`,
                    `created: ${created}`,
                    isActive ? '● active in this window' : null,
                ].filter(Boolean).join('  ·  '),
                picked:      !rootOk,
                _name:       name,
                _isOrphan:   !rootOk,
            };
        });

        const orphanCount = items.filter(i => i._isOrphan).length;
        const picks = await vscode.window.showQuickPick(items, {
            placeHolder: `${contexts.length} total  ·  ${orphanCount} orphaned (path not found) — select to archive or delete`,
            canPickMany: true,
        });
        if (!picks || picks.length === 0) return;

        const action = await vscode.window.showQuickPick([
            {
                label: '$(archive) Archive',
                description: 'Move to ~/.ai-context/archive/  —  recoverable with "AI: Restore Archived Context"',
                value: 'archive',
            },
            {
                label: '$(trash) Delete permanently',
                description: 'Cannot be undone',
                value: 'delete',
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
                label:       baseName,
                description: ctx.root || 'no root',
                detail:      `last used: ${formatRelativeTime(ctx.lastUsed)}  ·  created: ${formatRelativeTime(ctx.createdAt)}`,
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
            autoInject(loadContext(dir, restoredName));
        }
    });

    context.subscriptions.push(
        setActiveCmd, runTask, viewContext, newContext,
        deleteCtx, cleanUp, restoreCtx, watcher
    );
}

function deactivate() {}

module.exports = { activate, deactivate };
