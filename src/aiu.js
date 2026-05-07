// AI Understanding — VS Code integration: commands + status bar.
// All filesystem / validation logic lives in ./understanding.js; this file is
// the thin VS Code adapter (workspace probing, command registration, UI).

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const u = require('./understanding');
const inject = require('./inject');

let statusBar = null;
let lastStatus = null;
let refreshTimer = null;
let watcher = null;

function getWorkspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : null;
}

function readExtensionVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
        return pkg.version || null;
    } catch { return null; }
}

function buildTooltip(status) {
    if (!status) return 'AI Understanding';
    if (!status.initialized) return 'AI Understanding: not initialized — click to bootstrap';
    if (u.isClean(status)) return `AI Understanding: clean (${status.fresh.length} entries fresh)`;
    const lines = ['AI Understanding:'];
    const cap = (arr) => arr.slice(0, 5).join(', ') + (arr.length > 5 ? '…' : '');
    if (status.stale.length)     lines.push(`  stale (${status.stale.length}): ${cap(status.stale)}`);
    if (status.untracked.length) lines.push(`  untracked (${status.untracked.length}): ${cap(status.untracked)}`);
    if (status.orphan.length)    lines.push(`  orphan (${status.orphan.length}): ${cap(status.orphan)}`);
    lines.push('Click for details');
    return lines.join('\n');
}

function refreshStatus() {
    const root = getWorkspaceRoot();
    if (!root) {
        lastStatus = null;
        if (statusBar) statusBar.hide();
        return null;
    }
    try { lastStatus = u.computeStatus(root); }
    catch { lastStatus = null; }

    if (statusBar) {
        if (lastStatus) {
            statusBar.text = `$(book) ${u.formatStatusBar(lastStatus)}`;
            statusBar.tooltip = buildTooltip(lastStatus);
            statusBar.show();
        } else {
            statusBar.hide();
        }
    }

    // Keep CLAUDE.md / AGENTS.md AIU block in sync. Failures here must not
    // break the status bar or commands — log and move on.
    try {
        if (lastStatus && lastStatus.initialized) {
            syncAiuInjection(root, lastStatus);
        } else {
            clearAiuInjection(root);
        }
    } catch (err) {
        console.error('AIU injection sync failed:', err);
    }

    return lastStatus;
}

function syncAiuInjection(root, status) {
    const targets = inject.getInjectionTargets(root);
    if (!targets || targets.length === 0) return;
    const block = u.buildAiuInjectionBlock(status);
    for (const target of targets) {
        // Only write to target files that already exist. The AI_CTX injector
        // is responsible for first-time CLAUDE.md / AGENTS.md creation; we
        // piggy-back on whatever surface the user has already opted into.
        if (!fs.existsSync(target)) continue;
        inject.injectMarkedBlock(target, block, inject.AIU_INJECT_START, inject.AIU_INJECT_END);
    }
}

function clearAiuInjection(root) {
    const targets = inject.getInjectionTargets(root);
    if (!targets || targets.length === 0) return;
    for (const target of targets) {
        inject.clearMarkedBlock(target, inject.AIU_INJECT_START, inject.AIU_INJECT_END);
    }
}

function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { refreshTimer = null; refreshStatus(); }, 250);
}

async function cmdInit() {
    const root = getWorkspaceRoot();
    if (!root) {
        vscode.window.showErrorMessage('AI Understanding: no workspace folder is open.');
        return;
    }
    const aiuRoot = path.join(root, 'AI_UNDERSTANDING');
    if (fs.existsSync(aiuRoot)) {
        const choice = await vscode.window.showWarningMessage(
            'AI_UNDERSTANDING/ already exists in this workspace. Re-bootstrap will rewrite all skeleton entries — any AI-filled fields (purpose, exports, etc.) will be lost.',
            { modal: true },
            'Re-bootstrap',
        );
        if (choice !== 'Re-bootstrap') return;
    }
    const version = readExtensionVersion();
    try {
        const result = u.generateSkeleton(root, {
            generator: version ? `ai-context-runner/${version}` : '',
            last_audit_at: new Date().toISOString(),
        });
        vscode.window.showInformationMessage(
            `AI Understanding initialized: ${result.files.length} skeleton entries written. Now have your AI agent fill in purpose/exports/imports/invariants.`
        );
        refreshStatus();
    } catch (err) {
        vscode.window.showErrorMessage(`AI Understanding init failed: ${err.message}`);
    }
}

async function cmdStatus() {
    const root = getWorkspaceRoot();
    if (!root) {
        vscode.window.showErrorMessage('AI Understanding: no workspace folder is open.');
        return;
    }
    const s = refreshStatus();
    if (!s) return;
    if (!s.initialized) {
        const choice = await vscode.window.showInformationMessage(
            'AI Understanding is not initialized for this workspace.',
            'Initialize',
        );
        if (choice === 'Initialize') await cmdInit();
        return;
    }
    if (u.isClean(s)) {
        vscode.window.showInformationMessage(
            `AI Understanding: clean — ${s.fresh.length} entries fresh.`
        );
        return;
    }

    const items = [];
    for (const p of s.stale)     items.push({ label: '$(warning) stale',      description: p, kind: 'stale',     path: p });
    for (const p of s.untracked) items.push({ label: '$(diff-added) untracked', description: p, kind: 'untracked', path: p });
    for (const p of s.orphan)    items.push({ label: '$(trash) orphan',       description: p, kind: 'orphan',    path: p });

    const pick = await vscode.window.showQuickPick(items, {
        title: u.formatStatusBar(s),
        placeHolder: 'Pick an entry to open (orphan opens the .aiu.json; others open the source)',
        matchOnDescription: true,
    });
    if (!pick) return;
    const target = pick.kind === 'orphan'
        ? path.join(root, 'AI_UNDERSTANDING', pick.path + '.aiu.json')
        : path.join(root, pick.path);
    try {
        const doc = await vscode.workspace.openTextDocument(target);
        await vscode.window.showTextDocument(doc);
    } catch (err) {
        vscode.window.showWarningMessage(`Could not open ${target}: ${err.message}`);
    }
}

function cmdRefresh() {
    refreshStatus();
}

function activate(context) {
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9);
    statusBar.command = 'ai.aiuStatus';
    context.subscriptions.push(statusBar);

    context.subscriptions.push(
        vscode.commands.registerCommand('ai.aiuInit', cmdInit),
        vscode.commands.registerCommand('ai.aiuStatus', cmdStatus),
        vscode.commands.registerCommand('ai.aiuRefresh', cmdRefresh),
    );

    watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const onFsEvent = () => scheduleRefresh();
    watcher.onDidChange(onFsEvent);
    watcher.onDidCreate(onFsEvent);
    watcher.onDidDelete(onFsEvent);
    context.subscriptions.push(watcher);

    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => refreshStatus())
    );

    refreshStatus();
}

function deactivate() {
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    if (watcher && typeof watcher.dispose === 'function') {
        watcher.dispose();
        watcher = null;
    }
    statusBar = null;
    lastStatus = null;
}

module.exports = {
    activate,
    deactivate,
    refreshStatus,
    buildTooltip,
    // test helpers
    _internals: {
        getWorkspaceRoot,
        readExtensionVersion,
    },
};
