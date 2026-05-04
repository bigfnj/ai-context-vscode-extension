const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const { SettingsViewProvider } = require('./settingsView');

const { readClaudeSettings, captureNewClaudePerms, generalizeClaudePerm, isClaudePermCovered, applyClaudePerms, readCodexConfig, extractCodexTrust, applyCodexTrust, consolidatePermissionsToGlobal, applyCodexFullAuto, applyCodexSandboxMode, applyCodexSafeCommands, deriveSafeCommandsFromAllow, hasRemovalCommands, purgeRemovalMemory, listRemovalCommands, removeRemovalCommandFromClaudeGlobal, removeRemovalCommandFromCodex, isRemovalCommand, readCodexRulesFile, parseCodexRules, codexRulesToClaudeAllow, claudeAllowToCodexRules, applyCodexRulesFile } = require('./permissions');

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
    autoInjectMulti,
    autoInjectCodexBootstrap,
    clearCodexBootstrap,
    clearInjectionForContext,
    getAgents,
    getInjectionTargets,
    AGENT_TARGETS,
} = require('./inject');
const { getCliPath, buildPrompt, extractContextUpdate, stripContextUpdate, runWithClaude } = require('./claude');

const ACTIVE_KEY    = 'ai.activeContext';
const PREVIOUS_KEY  = 'ai.previousContext';
const SECONDARY_KEY = 'ai.secondaryContexts';
const PINNED_KEY    = 'ai.pinnedSecondaries';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getActive(wsState) {
    return wsState.get(ACTIVE_KEY) || null;
}

function getPrevious(wsState) {
    return wsState.get(PREVIOUS_KEY) || null;
}

async function setActive(wsState, name) {
    return wsState.update(ACTIVE_KEY, name);
}

function getSecondaries(wsState) {
    const v = wsState.get(SECONDARY_KEY);
    return Array.isArray(v) ? v.filter(n => typeof n === 'string' && n) : [];
}

async function setSecondaries(wsState, names) {
    const clean = Array.isArray(names) ? [...new Set(names.filter(n => typeof n === 'string' && n))] : [];
    return wsState.update(SECONDARY_KEY, clean);
}

async function addSecondary(wsState, name) {
    if (!name) return;
    const active = wsState.get(ACTIVE_KEY);
    if (name === active) return;
    const cur = getSecondaries(wsState);
    // Prepend so newest is at front; LRU eviction happens at the tail. If the
    // name was already present, move it to the front.
    const next = [name, ...cur.filter(n => n !== name)];
    await setSecondaries(wsState, next);
    return enforceSecondaryCap(wsState);
}

async function removeSecondary(wsState, name) {
    const cur = getSecondaries(wsState);
    await setSecondaries(wsState, cur.filter(n => n !== name));
    // Also clear from pinned set so pin state doesn't outlive the secondary itself.
    const pinned = getPinned(wsState);
    if (pinned.includes(name)) await setPinned(wsState, pinned.filter(n => n !== name));
}

function getPinned(wsState) {
    const v = wsState.get(PINNED_KEY);
    return Array.isArray(v) ? v.filter(n => typeof n === 'string' && n) : [];
}

async function setPinned(wsState, names) {
    const clean = Array.isArray(names) ? [...new Set(names.filter(n => typeof n === 'string' && n))] : [];
    return wsState.update(PINNED_KEY, clean);
}

function isPinned(wsState, name) {
    return getPinned(wsState).includes(name);
}

async function togglePinSecondary(wsState, name) {
    if (!name) return;
    const cur = getPinned(wsState);
    if (cur.includes(name)) {
        return setPinned(wsState, cur.filter(n => n !== name));
    }
    // Only allow pinning items that are currently secondaries.
    if (!getSecondaries(wsState).includes(name)) return;
    return setPinned(wsState, [...cur, name]);
}

function getMaxSecondaries() {
    const v = vscode.workspace.getConfiguration('aiContext').get('maxSecondaryContexts');
    return (typeof v === 'number' && v >= 0) ? Math.floor(v) : 3;
}

function autoPromoteEnabled() {
    return vscode.workspace.getConfiguration('aiContext').get('autoPromoteOnSwitch') !== false;
}

// Trim secondaries down to the configured cap, evicting from the tail (oldest)
// while skipping any pinned entries.
async function enforceSecondaryCap(wsState) {
    const cap = getMaxSecondaries();
    const cur = getSecondaries(wsState);
    if (cur.length <= cap) return;
    const pinned = new Set(getPinned(wsState));
    const result = [...cur];
    while (result.length > cap) {
        let evictIdx = -1;
        for (let i = result.length - 1; i >= 0; i--) {
            if (!pinned.has(result[i])) { evictIdx = i; break; }
        }
        if (evictIdx === -1) break; // every entry is pinned — give up evicting
        result.splice(evictIdx, 1);
    }
    if (result.length !== cur.length) {
        await setSecondaries(wsState, result);
    }
}

// Auto-promote: when the active context switches from outgoing -> incoming,
// push outgoing onto the secondary stack (front), drop incoming from
// secondaries (it's now primary), then enforce the cap.
async function doAutoPromote(wsState, outgoingName, incomingName) {
    if (!outgoingName || outgoingName === incomingName) return;
    if (!autoPromoteEnabled()) return;
    const cur = getSecondaries(wsState);
    const next = [outgoingName, ...cur.filter(n => n !== outgoingName && n !== incomingName)];
    await setSecondaries(wsState, next);
    return enforceSecondaryCap(wsState);
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

// Populates a fresh (t==='init') context with recent git log + status so the
// AI has immediate project awareness instead of a blank slate.
function bootstrapFromGit(dir, name) {
    const ctx = loadContext(dir, name);
    if (ctx.t !== 'init') return;
    const root = ctx.root;
    if (!root || !fs.existsSync(root)) return;
    try {
        const log    = execSync('git log --oneline -8', { cwd: root, timeout: 4000 }).toString().trim();
        const status = execSync('git status --short',   { cwd: root, timeout: 4000 }).toString().trim();
        if (!log && !status) return;
        const actions = log ? log.split('\n').map(l => `git: ${l}`) : [];
        const changed = status ? status.split('\n').length : 0;
        saveContext(dir, name, {
            ...ctx,
            t: 'git_bootstrap',
            n: 'Review recent commits and continue work.',
            a: actions,
            s: { ...ctx.s, ...(changed ? { untracked_or_modified: changed } : {}) },
        });
    } catch { /* git unavailable or not a repo — skip silently */ }
}

function syncActiveContextForPath(dir, wsState, candidatePath, options = {}) {
    if (!candidatePath || getCfg().get('autoDetect') === false) return null;

    const matched  = detectContextForPath(dir, candidatePath);
    const previous = getActive(wsState);

    if (matched) {
        if (matched !== previous) {
            setActive(wsState, matched);
            bootstrapFromGit(dir, matched);
            injectAndApplyPerms(dir, matched, wsState);
            if (options.notify !== false) {
                notify(`AI Context Runner is now tracking [${matched}]`);
            }
        }
        return matched;
    }

    if (options.fallbackPrevious && previous) {
        injectAndApplyPerms(dir, previous, wsState);
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

// ── Permissions ───────────────────────────────────────────────────────────────

function injectAndApplyPerms(dir, name, wsStateRef) {
    const ctx = loadContext(dir, name);
    // wsStateRef is optional — if provided we layer in secondary contexts; if
    // omitted we fall back to single-context behavior (matches old call sites).
    let result;
    if (wsStateRef) {
        const secondaryNames = getSecondaries(wsStateRef).filter(n => n !== name);
        const secondaries = secondaryNames.map(n => loadContext(dir, n)).filter(c => c && c.p);
        result = autoInjectMulti(ctx, secondaries);
    } else {
        result = autoInject(ctx);
    }
    if (ctx.perms) {
        const allow        = ctx.perms.allow || [];
        const codexTrust   = ctx.perms.codex || 'trusted';
        const safeCommands = ctx.perms.safeCommands || [];
        const sandboxMode  = ctx.perms.sandboxMode === true;
        applyClaudePerms(allow);
        applyCodexSafeCommands([...safeCommands, ...deriveSafeCommandsFromAllow(allow)]);
        // Push our per-context wildcards back into ~/.codex/rules/default.rules
        // (additive merge — preserves manual edits and deny rules) so Codex
        // sessions opened in this context inherit the harvested approvals
        // without re-prompting. Symmetric with applyClaudePerms.
        applyCodexRulesFile(claudeAllowToCodexRules(allow));
        applyCodexSandboxMode(ctx.root, sandboxMode);
        if (codexTrust === 'full-auto') {
            applyCodexFullAuto(true);
            applyCodexTrust(ctx.root, 'trusted');
        } else {
            applyCodexFullAuto(getCfg().get('codexFullAuto') === true);
            const effectiveTrust = (allow.length > 0 && codexTrust !== 'untrusted') ? 'trusted' : codexTrust;
            applyCodexTrust(ctx.root, effectiveTrust);
        }
    }
    return result;
}

// ── Activate ──────────────────────────────────────────────────────────────────

function activate(context) {
    const dir     = getCtxDir();
    const wsState = context.workspaceState;

    // ── Sweep: consume any orphan *.json.update sidecars left by previous sessions.
    // The file watcher only fires for events that occur while the extension is
    // active. Sidecars written before activation (or during a watcher hiccup,
    // common on WSL inotify) would otherwise sit forever and AGENTS.md / CLAUDE.md
    // would re-inject from stale state. This runs once at activation. The same
    // pass also removes the legacy ~/.ai-context/.active file from pre-3.x
    // versions — current code stores the active context in workspaceState.
    try {
        if (fs.existsSync(dir)) {
            for (const entry of fs.readdirSync(dir)) {
                if (entry === '.active') {
                    try { fs.unlinkSync(path.join(dir, entry)); } catch { /* ignore */ }
                    continue;
                }
                if (!entry.endsWith('.json.update')) continue;
                const full = path.join(dir, entry);
                try {
                    const name = entry.slice(0, -'.json.update'.length);
                    const update = extractContextUpdate(fs.readFileSync(full, 'utf8'));
                    if (!update) { fs.unlinkSync(full); continue; }
                    saveContext(dir, name, { ...loadContext(dir, name), ...update });
                    fs.unlinkSync(full);
                } catch { /* skip this sidecar, keep sweeping */ }
            }
        }
    } catch { /* ignore — sweep is best-effort */ }

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

    // ── Codex availability probe — checks both the CLI binary on PATH and the
    // installed VS Code Codex extension. Either is enough; both is fine. Used
    // by the sandbox toggle to surface a soft warning only when NEITHER path
    // is available, since the .codex/config.toml write is valid for either
    // installation method.
    function probeCodexVSCodeExtension() {
        try {
            const exts = vscode.extensions.all || [];
            const codex = exts.find(e => {
                const id   = (e.id || '').toLowerCase();
                const name = (e.packageJSON && e.packageJSON.name || '').toLowerCase();
                return id.includes('codex') || name.includes('codex');
            });
            if (!codex) return { ok: false, error: 'Codex VS Code extension not installed' };
            const id  = codex.id;
            const ver = codex.packageJSON && codex.packageJSON.version;
            return { ok: true, source: 'vscode-extension', id, version: ver };
        } catch (err) {
            return { ok: false, error: `extension probe failed: ${err.message}` };
        }
    }

    async function probeCodex() {
        const { probeCodexBinary } = require('./permissions');
        const cli = await probeCodexBinary();
        if (cli.ok) return { ok: true, source: 'cli', detail: 'codex CLI on PATH' };
        const vsx = probeCodexVSCodeExtension();
        if (vsx.ok) return { ok: true, source: 'vscode-extension', detail: `${vsx.id}${vsx.version ? '@' + vsx.version : ''}` };
        return { ok: false, error: `${cli.error}; ${vsx.error}` };
    }

    // ── Status bar — shows active context name, click to switch ──────────────
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    statusBar.command = 'ai.setActiveContext';
    statusBar.tooltip = 'AI Context — click to switch';
    context.subscriptions.push(statusBar);

    function updateStatusBar() {
        const name = getActive(wsState);
        if (name) {
            statusBar.text = `$(database) ${name}`;
            statusBar.show();
        } else {
            statusBar.hide();
        }
    }

    // Wrap wsState so every setActive call refreshes the status bar and settings panel.
    // Saves the previous active context before overwriting so the panel can show it.
    // When aiContext.autoPromoteOnSwitch is on (default), the outgoing primary is
    // also pushed onto the secondary stack with LRU eviction respecting pins.
    const trackedWsState = {
        get:    (...a) => wsState.get(...a),
        update: async (key, value) => {
            let outgoing = null;
            if (key === ACTIVE_KEY) {
                const current = wsState.get(ACTIVE_KEY);
                if (current && current !== value) {
                    outgoing = current;
                    await wsState.update(PREVIOUS_KEY, current);
                }
            }
            await wsState.update(key, value);
            if (key === ACTIVE_KEY) {
                if (outgoing) await doAutoPromote(trackedWsState, outgoing, value);
                updateStatusBar();
                settingsView.refresh();
            }
        },
    };

    // ── Settings panel (sidebar WebviewView) ──────────────────────────────────
    const settingsView = new SettingsViewProvider(
        () => getActive(trackedWsState),
        () => getPrevious(trackedWsState),
        {
            getSecondaries: () => getSecondaries(trackedWsState),
            getPinned: () => getPinned(trackedWsState),
            probeCodex: () => probeCodex(),
            switchToPrev: async () => {
                const prev = getPrevious(trackedWsState);
                if (!prev) return;
                await setActive(trackedWsState, prev);
                injectAndApplyPerms(dir, prev, trackedWsState);
                notify(`AI Context: switched to [${prev}]`);
            },
            addSecondary: async () => vscode.commands.executeCommand('ai.addSecondaryContext'),
            removeSecondary: async (name) => {
                if (!name) return;
                await removeSecondary(trackedWsState, name);
                const active = getActive(trackedWsState);
                if (active) injectAndApplyPerms(dir, active, trackedWsState);
                settingsView.refresh();
            },
            togglePinSecondary: async (name) => {
                if (!name) return;
                await togglePinSecondary(trackedWsState, name);
                settingsView.refresh();
            },
            manageRemovalCommands: async () => {
                const ctxName = getActive(trackedWsState);
                while (true) {
                    const ctx = ctxName ? loadContext(dir, ctxName) : null;
                    const contextAllow = (ctx && ctx.perms && ctx.perms.allow) ? ctx.perms.allow : [];
                    const items = listRemovalCommands(contextAllow);

                    if (items.length === 0) {
                        vscode.window.showInformationMessage('No removal commands to purge.');
                        return;
                    }

                    const sourceLabel = { context: 'context', claude: 'claude global', codex: 'codex safe' };
                    const pickItems = [
                        { label: '$(trash)  Purge All', description: `${items.length} removal command(s)`, _purgeAll: true },
                        ...items.map(item => ({
                            label: `$(close)  ${item.perm}`,
                            description: sourceLabel[item.source] || item.source,
                            _item: item,
                        })),
                    ];

                    const pick = await vscode.window.showQuickPick(pickItems, {
                        placeHolder: `${items.length} removal command(s) — select to remove or "Purge All"`,
                        matchOnDescription: true,
                    });

                    if (!pick) return;

                    if (pick._purgeAll) {
                        const result = purgeRemovalMemory();
                        let contextRemoved = 0;
                        if (ctx && Array.isArray(ctx.perms && ctx.perms.allow)) {
                            const fresh = loadContext(dir, ctxName);
                            const before = (fresh.perms && fresh.perms.allow ? fresh.perms.allow : []).length;
                            const filtered = (fresh.perms && fresh.perms.allow ? fresh.perms.allow : []).filter(p => {
                                const m = p.match(/^(\w+)\((.+)\)$/);
                                if (!m) return true;
                                return !(m[1].toLowerCase() === 'bash' && isRemovalCommand(m[2]));
                            });
                            contextRemoved = before - filtered.length;
                            if (contextRemoved > 0) {
                                saveContext(dir, ctxName, { ...fresh, perms: { ...fresh.perms, allow: filtered } });
                            }
                        }
                        const total = result.removed + contextRemoved;
                        vscode.window.showInformationMessage(`Purged ${total} removal command(s).`);
                        return;
                    }

                    if (pick._item) {
                        const { source, perm } = pick._item;
                        if (source === 'context' && ctxName) {
                            const fresh = loadContext(dir, ctxName);
                            const filtered = (fresh.perms && fresh.perms.allow ? fresh.perms.allow : []).filter(p => p !== perm);
                            saveContext(dir, ctxName, { ...fresh, perms: { ...fresh.perms, allow: filtered } });
                        } else if (source === 'claude') {
                            removeRemovalCommandFromClaudeGlobal(perm);
                        } else if (source === 'codex') {
                            removeRemovalCommandFromCodex(perm);
                        }
                    }
                }
            },
        }
    );
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SettingsViewProvider.viewId, settingsView)
    );

    // ── Auto-detect context on startup ────────────────────────────────────────
    if (getCfg().get('autoDetect') !== false) {
        syncActiveContextForPath(dir, trackedWsState, getWorkspaceRoot(), {
            action: 'auto-loaded',
            fallbackPrevious: true,
        });
    } else if (getActive(trackedWsState)) {
        injectAndApplyPerms(dir, getActive(trackedWsState));
    }
    updateStatusBar();

    // ── File watcher — re-inject on context JSON change; consume interactive CTX_UPDATE sidecars ──
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), '*')
    );

    const onContextChange = uri => {
        const basename = path.basename(uri.fsPath);

        // Interactive sessions write CTX_UPDATE:{...} to [name].json.update.
        // Merge into the store and delete the sidecar; the .json save below re-triggers inject.
        if (basename.endsWith('.json.update')) {
            const name = basename.slice(0, -'.json.update'.length);
            try {
                if (!fs.existsSync(uri.fsPath)) return;
                const update = extractContextUpdate(fs.readFileSync(uri.fsPath, 'utf8'));
                if (!update) return;
                saveContext(dir, name, { ...loadContext(dir, name), ...update });
                try { fs.unlinkSync(uri.fsPath); } catch { /* ignore */ }
            } catch { /* ignore */ }
            return;
        }

        // Shell PROMPT_COMMAND / Codex bootstrap writes $PWD here for zero-friction switching.
        if (basename === '.cwd') {
            try {
                const cwd = fs.existsSync(uri.fsPath) ? fs.readFileSync(uri.fsPath, 'utf8').trim() : null;
                if (!cwd) return;
                const matched = syncActiveContextForPath(dir, trackedWsState, cwd);
                if (!matched) {
                    // No context exists for this path — if it's under projectsRoot, auto-create and retry.
                    const projectsRoot = getProjectsRoot();
                    if (isSameOrChildPath(projectsRoot, cwd)) {
                        const created = scanAndCreateContexts(dir, projectsRoot);
                        if (created.length > 0) {
                            notify(`AI Context: new project${created.length !== 1 ? 's' : ''} found — ${created.join(', ')}`);
                            settingsView.refresh();
                            syncActiveContextForPath(dir, trackedWsState, cwd);
                        }
                    }
                }
            } catch { /* ignore */ }
            return;
        }

        if (!basename.endsWith('.json')) return;
        const changedName = path.basename(uri.fsPath, '.json');
        const activeName = getActive(trackedWsState);
        // Re-inject if the changed context is the primary OR any secondary —
        // multi-context blocks need a refresh whenever any participating
        // context's underlying state changes.
        if (changedName === activeName || getSecondaries(trackedWsState).includes(changedName)) {
            if (activeName) injectAndApplyPerms(dir, activeName, trackedWsState);
        }
        settingsView.refresh();
    };

    watcher.onDidChange(onContextChange);
    watcher.onDidCreate(onContextChange);

    // ── Re-detect when workspace folders change ───────────────────────────────
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            syncCodexBootstrap();
            syncActiveContextForPath(dir, trackedWsState, getWorkspaceRoot());
        })
    );

    const syncEditorContext = editor => {
        if (getCfg().get('followActiveEditor') === false) return;
        syncActiveContextForPath(dir, trackedWsState, getEditorPath(editor));
    };

    const syncTerminalContext = terminal => {
        if (getCfg().get('followTerminalCwd') === false) return;
        syncActiveContextForPath(dir, trackedWsState, getTerminalCwd(terminal));
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
            const autoDetect    = cfg.get('autoDetect') !== false;
            const followEditor  = cfg.get('followActiveEditor') !== false;
            const followTerm    = cfg.get('followTerminalCwd') !== false;
            const bootstrap     = cfg.get('codexProjectSwitchBootstrap') !== false;
            const scanOnLaunch  = cfg.get('scanOnLaunch') !== false;
            const showNotif     = cfg.get('showNotifications') !== false;
            const autoGit       = cfg.get('autoGitignore') === true;
            const codexFullAuto = cfg.get('codexFullAuto') === true;
            const maxAct        = num('maxActions', 40);

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
                    label:       `$(zap)  Codex Full-Auto   ${codexFullAuto ? '$(check)' : '$(circle-slash)'}`,
                    description: codexFullAuto ? 'on' : 'off',
                    detail:      'Every codex session runs --approval-mode full-auto — alias in ~/.bashrc + approval_policy in ~/.codex/config.toml',
                    _key:        'codexFullAuto',
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
                    label:       '$(key)  Manage Permissions',
                    description: `View & manage project permissions`,
                    detail:      'View and remove per-project Claude/Codex permissions',
                    _key:        '_managePerms',
                    _type:       'action',
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

            // ── Action (navigate to another menu) ────────────────────────────
            if (pick._type === 'action') {
                if (pick._key === '_managePerms') {
                    await vscode.commands.executeCommand('ai.managePermissions');
                }
                continue;
            }

            const previousProjectsRoot = getProjectsRoot();

            // ── Toggle boolean ──────────────────────────────────────────────
            if (pick._type === 'boolean') {
                const DEFAULT_OFF_KEYS = ['autoGitignore', 'codexFullAuto'];
                const current = DEFAULT_OFF_KEYS.includes(pick._key)
                    ? cfg.get(pick._key) === true
                    : cfg.get(pick._key) !== false;
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

        const current = getActive(trackedWsState);
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

        await setActive(trackedWsState, pick.label);
        showInjectionResult(pick.label, agents, injectAndApplyPerms(dir, pick.label));
    });

    // ── AI: Run Task ──────────────────────────────────────────────────────────
    const runTask = vscode.commands.registerCommand('ai.runTask', async () => {
        const ctxName = await pickOrCreateContext(dir, trackedWsState);
        if (!ctxName) return;

        const task = await vscode.window.showInputBox({
            prompt:        `Task for [${ctxName}]`,
            placeHolder:   'What do you want to do?',
            validateInput: v => (v && v.trim() ? null : 'Task cannot be empty'),
        });
        if (!task) return;

        const ctx    = loadContext(dir, ctxName);
        const prompt = buildPrompt(ctx, task.trim());

        // Snapshot Claude settings before task
        const beforeSettings = readClaudeSettings();
        const beforeAllow = (beforeSettings.permissions && beforeSettings.permissions.allow) ? [...beforeSettings.permissions.allow] : [];

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

                    // Capture new permissions granted during task
                    const afterSettings = readClaudeSettings();
                    const afterAllow = (afterSettings.permissions && afterSettings.permissions.allow) ? afterSettings.permissions.allow : [];
                    const preventRemoval = getCfg().get('preventRemovalCapture') === true;
                    const newPerms = captureNewClaudePerms(beforeAllow, afterAllow, ctx.root, ctx.perms && ctx.perms.allow ? ctx.perms.allow : [], preventRemoval);

                    if (newPerms.length > 0) {
                        const savedCtx = loadContext(dir, ctxName);
                        const merged = [...(savedCtx.perms && savedCtx.perms.allow ? savedCtx.perms.allow : [])];
                        for (const p of newPerms) {
                            if (!isClaudePermCovered(p, merged)) {
                                merged.push(p);
                            }
                        }
                        saveContext(dir, ctxName, { ...savedCtx, perms: { ...savedCtx.perms, allow: merged } });
                    }
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

        const active = getActive(trackedWsState);
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

    // ── AI: Manage Permissions ────────────────────────────────────────────────
    const managePermissions = vscode.commands.registerCommand('ai.managePermissions', async () => {
        const ctxName = getActive(trackedWsState);
        if (!ctxName) {
            vscode.window.showWarningMessage('AI Context: no active context — set one first.');
            return;
        }

        while (true) {
            const ctx = loadContext(dir, ctxName);
            const claudePerms = (ctx.perms && ctx.perms.allow) ? ctx.perms.allow : [];
            const codexTrust  = (ctx.perms && ctx.perms.codex)  ? ctx.perms.codex  : 'trusted';
            const sandboxMode = ctx.perms && ctx.perms.sandboxMode === true;

            const items = [
                ...claudePerms.map(p => ({
                    label:       `$(key)  ${p}`,
                    description: 'Claude — click to remove',
                    _type:       'claude',
                    _perm:       p,
                })),
                {
                    label:       `$(zap)  Codex Sandbox Mode: ${sandboxMode ? '$(check) enabled' : '$(circle-slash) disabled'}`,
                    description: sandboxMode ? 'danger-full-access — click to disable' : 'click to enable',
                    _type:       'sandbox',
                },
                {
                    label:       sandboxMode
                        ? `$(shield)  Codex trust: ${codexTrust}  (inactive — sandbox mode on)`
                        : `$(shield)  Codex trust: ${codexTrust}`,
                    description: sandboxMode ? '' : 'click to change',
                    _type:       sandboxMode ? 'noop' : 'codex',
                },
                {
                    label:       '$(close)  Close',
                    _type:       'close',
                },
            ];

            const pick = await vscode.window.showQuickPick(items, {
                placeHolder: `[${ctxName}] — ${claudePerms.length} Claude perm(s) · Codex: ${codexTrust}${sandboxMode ? ' · sandbox ON' : ''}`,
                matchOnDescription: true,
            });

            if (!pick || pick._type === 'close') return;

            if (pick._type === 'noop') {
                continue;
            }

            if (pick._type === 'claude') {
                const confirm = await vscode.window.showWarningMessage(
                    `Remove permission: "${pick._perm}"?`,
                    { modal: false },
                    'Remove'
                );
                if (confirm === 'Remove') {
                    const fresh = loadContext(dir, ctxName);
                    const updated = (fresh.perms && fresh.perms.allow || []).filter(p => p !== pick._perm);
                    saveContext(dir, ctxName, { ...fresh, perms: { ...fresh.perms, allow: updated } });
                }
            }

            if (pick._type === 'sandbox') {
                const current = loadContext(dir, ctxName);
                const enabling = !(current.perms && current.perms.sandboxMode === true);
                if (enabling) {
                    const confirm = await vscode.window.showWarningMessage(
                        `Enable Codex sandbox bypass (danger-full-access) for [${ctxName}]?\n\nThis writes sandbox_mode = "danger-full-access" to the project's .codex/config.toml. Use only in authorized environments.`,
                        { modal: true },
                        'Enable'
                    );
                    if (confirm !== 'Enable') continue;
                }
                const sbResult = applyCodexSandboxMode(current.root, enabling);
                if (!sbResult.ok) {
                    saveContext(dir, ctxName, {
                        ...current,
                        perms: { ...current.perms, sandboxMode: !enabling },
                    });
                    vscode.window.showErrorMessage(
                        `Sandbox mode ${enabling ? 'enable' : 'disable'} failed — reverted. ${sbResult.error}`
                    );
                } else {
                    saveContext(dir, ctxName, {
                        ...current,
                        perms: { ...current.perms, sandboxMode: enabling },
                    });
                    if (enabling) {
                        probeCodex().then(probe => {
                            if (!probe.ok) {
                                vscode.window.showWarningMessage(
                                    `Sandbox config applied for [${ctxName}], but no Codex installation detected (${probe.error}). Codex may not honor the new mode until the CLI is on PATH or the Codex VS Code extension is installed.`
                                );
                            }
                        });
                    }
                }
            }

            if (pick._type === 'codex') {
                const trustOptions = ['full-auto', 'trusted', 'auto', 'untrusted'].map(t => ({
                    label: t,
                    description: t === codexTrust ? '● current' : '',
                }));
                const selected = await vscode.window.showQuickPick(trustOptions, {
                    placeHolder: 'Select Codex trust level',
                });
                if (selected) {
                    const fresh = loadContext(dir, ctxName);
                    saveContext(dir, ctxName, { ...fresh, perms: { ...fresh.perms, codex: selected.label } });
                    applyCodexTrust(fresh.root, selected.label);
                }
            }
        }
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
            await setActive(trackedWsState, name.trim());
            showInjectionResult(name.trim(), getAgents().join(', '), injectAndApplyPerms(dir, name.trim()));
        }
    });

    // ── AI: Delete Context ────────────────────────────────────────────────────
    const deleteCtx = vscode.commands.registerCommand('ai.deleteContext', async () => {
        const contexts = listContexts(dir);
        if (contexts.length === 0) {
            vscode.window.showInformationMessage('No contexts to delete.');
            return;
        }

        const active = getActive(trackedWsState);
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
            await setActive(trackedWsState, null);
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

        const active = getActive(trackedWsState);
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
                await setActive(trackedWsState, null);
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
            await setActive(trackedWsState, restoredName);
            showInjectionResult(restoredName, getAgents().join(', '), injectAndApplyPerms(dir, restoredName));
        }
    });

    // ── AI: Reinject Active Context ───────────────────────────────────────────
    const reinjectCmd = vscode.commands.registerCommand('ai.reinjectContext', () => {
        const name = getActive(trackedWsState);
        if (!name) {
            vscode.window.showWarningMessage('AI Context: no active context — use "AI: Set Active Context" first.');
            return;
        }
        const injected = injectAndApplyPerms(dir, name, trackedWsState);
        if (!injected) {
            vscode.window.showWarningMessage(`[${name}] root path is missing or invalid — nothing injected.`);
            return;
        }
        const ctx = loadContext(dir, name);
        const targets = getInjectionTargets(normalizePath(ctx.root))
            .map(f => path.basename(f))
            .join(', ');
        vscode.window.showInformationMessage(`[${name}] reinjected into: ${targets}`);
    });

    // ── AI: Add Secondary Context ────────────────────────────────────────────
    const addSecondaryCmd = vscode.commands.registerCommand('ai.addSecondaryContext', async () => {
        const active = getActive(trackedWsState);
        if (!active) {
            vscode.window.showWarningMessage('Set an active context first before adding secondaries.');
            return;
        }
        const taken = new Set([active, ...getSecondaries(trackedWsState)]);
        const candidates = listContexts(dir).filter(n => !taken.has(n));
        if (candidates.length === 0) {
            vscode.window.showInformationMessage('No additional contexts available to add as secondary.');
            return;
        }
        const pick = await vscode.window.showQuickPick(
            candidates.map(name => {
                const ctx = loadContext(dir, name);
                return { label: name, description: ctx.root || '' };
            }),
            { placeHolder: `Add secondary context to [${active}]` }
        );
        if (!pick) return;
        await addSecondary(trackedWsState, pick.label);
        injectAndApplyPerms(dir, active, trackedWsState);
        settingsView.refresh();
        vscode.window.showInformationMessage(`Secondary context added: [${pick.label}]`);
    });

    // ── AI: Remove Secondary Context ─────────────────────────────────────────
    const removeSecondaryCmd = vscode.commands.registerCommand('ai.removeSecondaryContext', async () => {
        const active = getActive(trackedWsState);
        const cur = getSecondaries(trackedWsState);
        if (cur.length === 0) {
            vscode.window.showInformationMessage('No secondary contexts to remove.');
            return;
        }
        const pick = await vscode.window.showQuickPick(
            cur.map(name => ({ label: name })),
            { placeHolder: 'Remove which secondary context?' }
        );
        if (!pick) return;
        await removeSecondary(trackedWsState, pick.label);
        if (active) injectAndApplyPerms(dir, active, trackedWsState);
        settingsView.refresh();
        vscode.window.showInformationMessage(`Secondary context removed: [${pick.label}]`);
    });

    // ── AI: Clear Secondary Contexts ─────────────────────────────────────────
    const clearSecondaryCmd = vscode.commands.registerCommand('ai.clearSecondaryContexts', async () => {
        const active = getActive(trackedWsState);
        if (getSecondaries(trackedWsState).length === 0) {
            vscode.window.showInformationMessage('No secondary contexts to clear.');
            return;
        }
        await setSecondaries(trackedWsState, []);
        await setPinned(trackedWsState, []);
        if (active) injectAndApplyPerms(dir, active, trackedWsState);
        settingsView.refresh();
        vscode.window.showInformationMessage('Secondary contexts cleared.');
    });

    // ── AI: Toggle Secondary Pin ─────────────────────────────────────────────
    const togglePinCmd = vscode.commands.registerCommand('ai.toggleSecondaryPin', async () => {
        const cur = getSecondaries(trackedWsState);
        if (cur.length === 0) {
            vscode.window.showInformationMessage('No secondary contexts to pin.');
            return;
        }
        const pinnedSet = new Set(getPinned(trackedWsState));
        const pick = await vscode.window.showQuickPick(
            cur.map(name => ({
                label: `${pinnedSet.has(name) ? '$(pinned) ' : '$(pin) '}${name}`,
                description: pinnedSet.has(name) ? 'pinned (click to unpin)' : 'unpinned (click to pin)',
                _name: name,
            })),
            { placeHolder: 'Toggle pin on which secondary?' }
        );
        if (!pick) return;
        await togglePinSecondary(trackedWsState, pick._name);
        settingsView.refresh();
        vscode.window.showInformationMessage(
            `[${pick._name}] ${getPinned(trackedWsState).includes(pick._name) ? 'pinned' : 'unpinned'}.`
        );
    });

    // ── Consolidate permissions at startup ──────────────────────────────────
    const allContexts = listContexts(dir);
    if (allContexts.length > 0) {
        consolidatePermissionsToGlobal(
            allContexts,
            name => loadContext(dir, name),
            (name, ctx) => saveContext(dir, name, ctx)
        );
    }

    // ── Codex full-auto: apply on startup and whenever the setting changes ──
    applyCodexFullAuto(getCfg().get('codexFullAuto') === true);
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('aiContext.codexFullAuto')) {
                applyCodexFullAuto(getCfg().get('codexFullAuto') === true);
            }
        })
    );

    // ── Watch Claude settings.json — capture any new approved permissions ────
    const claudeDir  = path.join(os.homedir(), '.claude');
    const claudeWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(claudeDir), 'settings.json')
    );
    const syncClaudePerms = () => {
        const active = getActive(trackedWsState);
        if (!active) return;
        const currentAllow = readClaudeSettings().permissions?.allow || [];
        const ctx          = loadContext(dir, active);
        const stored       = ctx.perms?.allow || [];
        const uncovered    = currentAllow.filter(p => !isClaudePermCovered(p, stored));
        if (uncovered.length === 0) return;
        const newPerms = [];
        for (const raw of uncovered) {
            const g = generalizeClaudePerm(raw, ctx.root);
            if (!isClaudePermCovered(g, [...stored, ...newPerms])) newPerms.push(g);
        }
        if (newPerms.length === 0) return;
        saveContext(dir, active, { ...ctx, perms: { ...ctx.perms, allow: [...stored, ...newPerms] } });
        settingsView.refresh();
        notify(`AI Context: captured ${newPerms.length} new permission${newPerms.length !== 1 ? 's' : ''} for [${active}]`);
    };
    claudeWatcher.onDidChange(syncClaudePerms);
    claudeWatcher.onDidCreate(syncClaudePerms);

    // ── Watch Codex config.toml — sync trust level changes back to context ──
    const codexDir = path.join(os.homedir(), '.codex');
    const codexWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(codexDir), 'config.toml')
    );
    const syncCodexTrust = () => {
        const active = getActive(trackedWsState);
        if (!active) return;
        const ctx   = loadContext(dir, active);
        if (!ctx.root) return;
        // 'full-auto' intentionally writes 'trusted' to config.toml — don't sync it back
        if (ctx.perms?.codex === 'full-auto') return;
        const level = extractCodexTrust(readCodexConfig(), normalizePath(ctx.root));
        if (!level || level === (ctx.perms?.codex || 'trusted')) return;
        saveContext(dir, active, { ...ctx, perms: { ...ctx.perms, codex: level } });
        settingsView.refresh();
    };
    codexWatcher.onDidChange(syncCodexTrust);
    codexWatcher.onDidCreate(syncCodexTrust);

    // ── Watch ~/.codex/rules/default.rules — capture persistent prefix-rule
    // approvals into the active context's allow list (parallel to claudeWatcher
    // for ~/.claude/settings.json). Codex writes here when the user picks the
    // "always allow" / persist-as-rule option during an escalation prompt.
    const codexRulesDir = path.join(os.homedir(), '.codex', 'rules');
    const codexRulesWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(codexRulesDir), 'default.rules')
    );
    const syncCodexRules = () => {
        const active = getActive(trackedWsState);
        if (!active) return;
        const rules    = parseCodexRules(readCodexRulesFile());
        const derived  = codexRulesToClaudeAllow(rules);
        if (derived.length === 0) return;
        const ctx      = loadContext(dir, active);
        const stored   = (ctx.perms && ctx.perms.allow) || [];
        const newPerms = derived.filter(p => !isClaudePermCovered(p, stored));
        if (newPerms.length === 0) return;
        saveContext(dir, active, { ...ctx, perms: { ...ctx.perms, allow: [...stored, ...newPerms] } });
        // Push captured perms into the global Claude allow list too so Claude
        // sessions immediately recognize them — symmetric with how Claude
        // captures land in the per-context allow list.
        applyClaudePerms(newPerms);
        settingsView.refresh();
        notify(`AI Context: captured ${newPerms.length} new Codex rule${newPerms.length !== 1 ? 's' : ''} for [${active}]`);
    };
    codexRulesWatcher.onDidChange(syncCodexRules);
    codexRulesWatcher.onDidCreate(syncCodexRules);
    // Run once at activation so any rules added while the extension was offline
    // get captured on the next launch (parallels the .json.update sweep).
    syncCodexRules();

    context.subscriptions.push(
        configCmd, setActiveCmd, runTask, viewContext, managePermissions, newContext,
        deleteCtx, cleanUp, restoreCtx, reinjectCmd,
        addSecondaryCmd, removeSecondaryCmd, clearSecondaryCmd, togglePinCmd,
        watcher, claudeWatcher, codexWatcher, codexRulesWatcher
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
