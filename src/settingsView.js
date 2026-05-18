const vscode = require('vscode');
const { listContexts, loadContext, saveContext, getCtxDir, getProjectsRoot, checkContextHealth, listTemplates } = require('./context');
const { getAgents } = require('./inject');
const { listRemovalCommands } = require('./permissions');
const understanding = require('./understanding');
const hookInstaller = require('./hook');

const VERSION = require('../package.json').version;

const ALL_AGENTS = ['claude', 'codex', 'copilot', 'cursor', 'windsurf', 'kilo'];
const AGENT_FILES = {
    claude: 'CLAUDE.md', codex: 'AGENTS.md', copilot: 'copilot-instructions.md',
    cursor: '.cursorrules', windsurf: '.windsurfrules', kilo: 'AGENTS.md',
};
const CODEX_TRUST_LEVELS = ['full-auto', 'trusted', 'auto', 'untrusted'];
const TOGGLES = [
    { key: 'followActiveEditor',          label: 'Follow Active Editor',  desc: 'Switch context when editor tab changes to another project' },
    { key: 'followTerminalCwd',           label: 'Follow Terminal CWD',   desc: 'Switch context on terminal CWD change (shell integration)' },
    { key: 'autoDetect',                  label: 'Auto Detect',           desc: 'Detect context from workspace path on startup' },
    { key: 'scanOnLaunch',                label: 'Scan on Launch',        desc: 'Auto-create contexts for new projects found in projectsRoot' },
    { key: 'showNotifications',           label: 'Notifications',         desc: 'Toast messages on context switch' },
    { key: 'autoGitignore',               label: 'Auto .gitignore',       desc: 'Add injected AI files to .gitignore automatically' },
    { key: 'codexProjectSwitchBootstrap', label: 'Codex Bootstrap',       desc: 'Write AGENTS.md bootstrap to projectsRoot for Codex' },
    { key: 'codexFullAuto',               label: 'Codex Full-Auto',       desc: 'Every codex session runs --approval-mode full-auto (alias in ~/.bashrc + global config.toml)', defaultOff: true },
    { key: 'preventRemovalCapture',       label: 'Prevent Removal Capture',  desc: 'Block rm, del, rmdir, erase and similar commands from being captured and remembered', defaultOff: true },
    { key: 'autoPromoteOnSwitch',         label: 'Auto-Promote On Switch',   desc: 'When the active context switches, push the outgoing primary onto the secondary stack (LRU eviction respects pinned secondaries)' },
];

class SettingsViewProvider {
    static viewId = 'aiContext.settingsView';

    constructor(getActiveName, getPreviousName, actions = {}) {
        this._getActiveName   = getActiveName;
        this._getPreviousName = getPreviousName || (() => null);
        this._actions         = actions;
        // Surfaces (sidebar view + any open standalone panels). All receive
        // the same state on refresh; messages from any surface are handled
        // identically. Sidebar registers its surface in resolveWebviewView;
        // panels register via openPanel.
        this._surfaces = [];
        // Section open/closed state, lazily fetched from globalState. The
        // host (extension.js) supplies the storage callbacks; if absent
        // (e.g. tests) we default to {} and don't persist.
        this._getSectionStates = (actions && actions.getSectionStates) || (() => ({}));
        this._setSectionState  = (actions && actions.setSectionState)  || (() => {});
    }

    resolveWebviewView(webviewView) {
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtml();
        this._attachSurface(webviewView, webviewView.webview, 'view');
    }

    // Open a standalone WebviewPanel — same HTML, same messaging, same state.
    // Returns the panel so the caller can decide where it goes (splits, etc.).
    openPanel() {
        const panel = vscode.window.createWebviewPanel(
            'aiContext.settingsPanel',
            'AI Context Runner',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        panel.webview.html = this._getHtml();
        this._attachSurface(panel, panel.webview, 'panel');
        return panel;
    }

    _attachSurface(host, webview, kind) {
        const surface = { host, webview, kind };
        this._surfaces.push(surface);
        webview.onDidReceiveMessage(msg => this._handleMessage(msg));
        if (kind === 'view') {
            host.onDidChangeVisibility(() => { if (host.visible) this.refresh(); });
        } else {
            host.onDidChangeViewState(() => { if (host.visible) this.refresh(); });
            host.onDidDispose(() => {
                this._surfaces = this._surfaces.filter(s => s !== surface);
            });
        }
        this.refresh();
    }

    refresh() {
        if (!this._surfaces.some(s => s.host.visible)) return;
        const dir    = getCtxDir();
        const cfg    = vscode.workspace.getConfiguration('aiContext');
        const active = this._getActiveName();

        const contexts = listContexts(dir).map(name => {
            const ctx = loadContext(dir, name);
            return { name, root: ctx.root || '', lastUsed: ctx.lastUsed || null };
        });

        let perms = { allow: [], codex: 'trusted', safeCommands: [], codexSandboxMode: null, codexNetworkAccess: false };
        if (active) {
            const ctx = loadContext(dir, active);
            if (ctx.perms) {
                perms.allow              = Array.isArray(ctx.perms.allow) ? ctx.perms.allow : [];
                perms.codex              = typeof ctx.perms.codex === 'string' ? ctx.perms.codex : 'trusted';
                perms.safeCommands       = Array.isArray(ctx.perms.safeCommands) ? ctx.perms.safeCommands : [];
                perms.codexSandboxMode   = (ctx.perms.codexSandboxMode === 'workspace-write' || ctx.perms.codexSandboxMode === 'danger-full-access') ? ctx.perms.codexSandboxMode : null;
                perms.codexNetworkAccess = ctx.perms.codexNetworkAccess === true;
            }
        }

        const settings = {
            projectsRoot: getProjectsRoot(),
            agents:       getAgents(),
            ...Object.fromEntries(TOGGLES.map(t => [
                t.key,
                t.defaultOff ? cfg.get(t.key) === true : cfg.get(t.key) !== false,
            ])),
        };

        const previous = this._getPreviousName();
        let prevData = null;
        if (previous && previous !== active) {
            const pctx = loadContext(dir, previous);
            prevData = { name: previous, root: pctx.root || '' };
        }

        const removalCount = listRemovalCommands(perms.allow).length;

        const pinnedSet = new Set(this._actions.getPinned ? this._actions.getPinned() : []);
        const secondariesList = (this._actions.getSecondaries ? this._actions.getSecondaries() : [])
            .filter(n => n && n !== active)
            .map(name => {
                const ctx = loadContext(dir, name);
                return { name, root: ctx.root || '', pinned: pinnedSet.has(name) };
            });

        let activeHealth = null;
        if (active) {
            const ctx = loadContext(dir, active);
            activeHealth = checkContextHealth(ctx);
        }
        const templates = listTemplates(dir).map(name => {
            const ctx = loadContext(dir, name);
            return { name, decisions: (ctx.d||[]).length, files: (ctx.f||[]).length };
        });

        // AI Understanding section state. Compute against the workspace root,
        // falling back to a disabled section when no workspace is open.
        // AI Understanding state — scoped to the ACTIVE CONTEXT's root, not
        // the workspace folder. This matches the rest of the runner's
        // project-specific behavior. Falls back to the workspace folder
        // only when no context is active and a folder is open.
        const aiu = (() => {
            let project = null;
            let root = null;
            if (active) {
                const ctx = loadContext(dir, active);
                if (ctx && ctx.root) { root = ctx.root; project = active; }
            }
            if (!root) {
                const folders = vscode.workspace.workspaceFolders;
                if (folders && folders.length > 0) {
                    root = folders[0].uri.fsPath;
                    project = require('path').basename(root) + ' (workspace)';
                }
            }
            if (!root) return { workspaceOpen: false };
            let status = null;
            try { status = understanding.computeStatus(root); } catch { /* ignore */ }
            return {
                workspaceOpen: true,
                project,
                root,
                noActiveContext: !active,
                isGitRepo:     hookInstaller.isGitRepo(root),
                hookInstalled: hookInstaller.isHookInstalled(root),
                initialized:   !!(status && status.initialized),
                summary:       understanding.formatStatusBar(status),
                stale:         status ? status.stale.length     : 0,
                untracked:     status ? status.untracked.length : 0,
                orphan:        status ? status.orphan.length    : 0,
                fresh:         status ? status.fresh.length     : 0,
            };
        })();

        const sectionStates = this._getSectionStates() || {};
        const sandboxRuntime = (() => {
            try { return require('./permissions').probeSandboxRuntime(); }
            catch { return { platform: 'unknown', ok: true, detail: '' }; }
        })();
        const cloudReqs = (() => {
            try { return require('./permissions').probeCloudRequirements(); }
            catch { return null; }
        })();
        // Count how many entries in the active context's perms.allow are
        // shadowed (no-op'd) by an active cloud prefix-rule. The webview can
        // show this number to warn the user that part of their trusted list
        // is dead weight. Serialized as a primitive so postMessage can clone it.
        if (cloudReqs && cloudReqs.active && !cloudReqs.expired && cloudReqs.shadowedFirstTokens && perms.allow.length > 0) {
            try {
                const { countCloudShadowedAllow } = require('./permissions');
                cloudReqs.shadowedAllowCount = countCloudShadowedAllow(perms.allow, cloudReqs.shadowedFirstTokens);
            } catch { /* leave count unset */ }
        }
        // Set is not structured-clonable across postMessage — drop it now
        // that we've extracted the count.
        if (cloudReqs) delete cloudReqs.shadowedFirstTokens;
        const payload = { type: 'update', active, previous: prevData, contexts, settings, perms, removalCount, secondaries: secondariesList, version: VERSION, activeHealth, templates, aiu, sectionStates, sandboxRuntime, cloudReqs };
        for (const surface of this._surfaces) {
            if (!surface.host.visible) continue;
            surface.webview.postMessage(payload);
        }
    }

    async _handleMessage(msg) {
        const dir    = getCtxDir();
        const active = this._getActiveName();

        switch (msg.type) {
            case 'setActive':         await vscode.commands.executeCommand('ai.setActiveContext'); break;
            case 'reinject':          await vscode.commands.executeCommand('ai.reinjectContext');  break;
            case 'newContext':        await vscode.commands.executeCommand('ai.newContext');       break;
            case 'managePermissions': await vscode.commands.executeCommand('ai.managePermissions'); break;
            case 'openSettings':      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.ai-context-runner'); break;

            case 'toggleSetting': {
                const cfg = vscode.workspace.getConfiguration('aiContext');
                await cfg.update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
                this.refresh();
                break;
            }
            case 'toggleAgent': {
                const cfg     = vscode.workspace.getConfiguration('aiContext');
                const current = getAgents();
                const next    = msg.enabled
                    ? [...new Set([...current, msg.agent])]
                    : current.filter(a => a !== msg.agent);
                await cfg.update('agents', next, vscode.ConfigurationTarget.Global);
                this.refresh();
                break;
            }
            case 'removeClaudePerm': {
                if (!active) break;
                const ctx   = loadContext(dir, active);
                const perms = Array.isArray(ctx.perms?.allow) ? ctx.perms.allow : [];
                saveContext(dir, active, {
                    ...ctx,
                    perms: { ...ctx.perms, allow: perms.filter(p => p !== msg.perm) },
                });
                this.refresh();
                break;
            }
            case 'addSafeCommand': {
                if (!active || !msg.cmd || !msg.cmd.trim()) break;
                const ctx = loadContext(dir, active);
                const existing = Array.isArray(ctx.perms?.safeCommands) ? ctx.perms.safeCommands : [];
                if (!existing.includes(msg.cmd.trim())) {
                    saveContext(dir, active, {
                        ...ctx,
                        perms: { ...ctx.perms, safeCommands: [...existing, msg.cmd.trim()] },
                    });
                }
                this.refresh();
                break;
            }
            case 'removeSafeCommand': {
                if (!active) break;
                const ctx = loadContext(dir, active);
                const existing = Array.isArray(ctx.perms?.safeCommands) ? ctx.perms.safeCommands : [];
                saveContext(dir, active, {
                    ...ctx,
                    perms: { ...ctx.perms, safeCommands: existing.filter(c => c !== msg.cmd) },
                });
                this.refresh();
                break;
            }
            case 'setCodexTrust': {
                if (!active) break;
                const ctx = loadContext(dir, active);
                saveContext(dir, active, {
                    ...ctx,
                    perms: { ...ctx.perms, codex: msg.level },
                });
                this.refresh();
                break;
            }
            case 'setCodexSandboxMode': {
                if (!active) break;
                const { applyCodexSandboxMode, applyCodexSandboxNetworkAccess, setCodexApprovalPolicy, deriveApprovalPolicyForSandboxModes, probeCloudRequirements } = require('./permissions');
                const { listContexts, loadContext } = require('./context');
                const ctx = loadContext(dir, active);
                const validModes = new Set(['workspace-write', 'danger-full-access']);
                const newMode = validModes.has(msg.mode) ? msg.mode : null;
                const priorMode = ctx.perms && ctx.perms.codexSandboxMode || null;

                // Cloud-requirements veto: refuse to write a mode that would
                // be silently downgraded at runtime. Local config still gets
                // written for null (Off) and for any mode in the allow set.
                const cr = probeCloudRequirements();
                if (cr && cr.active && !cr.expired && Array.isArray(cr.sandboxAllowed) && newMode && !cr.sandboxAllowed.includes(newMode)) {
                    vscode.window.showWarningMessage(
                        `Codex cloud requirements forbid "${newMode}" (allowed: ${cr.sandboxAllowed.join(', ')}). Setting not applied — Codex would downgrade it at runtime regardless.`
                    );
                    this.refresh();
                    break;
                }

                if (newMode === 'danger-full-access' && priorMode !== 'danger-full-access') {
                    const confirmed = await vscode.window.showWarningMessage(
                        `Enable Codex sandbox bypass (danger-full-access) for [${active}]?\n\nThis writes sandbox_mode = "danger-full-access" to the project's .codex/config.toml AND sets approval_policy = "never" globally. Use only in authorized environments.`,
                        { modal: true },
                        'Enable'
                    );
                    if (confirmed !== 'Enable') {
                        this.refresh();
                        break;
                    }
                }

                const result = applyCodexSandboxMode(ctx.root, newMode);
                if (!result.ok) {
                    vscode.window.showErrorMessage(
                        `Sandbox mode change failed (${newMode || 'off'}) — config not modified. ${result.error}`
                    );
                    this.refresh();
                    break;
                }

                // Network-access section is only meaningful in workspace-write.
                // Strip it whenever leaving that mode so stale sections don't linger.
                const keepNetwork = newMode === 'workspace-write' && ctx.perms && ctx.perms.codexNetworkAccess === true;
                applyCodexSandboxNetworkAccess(ctx.root, keepNetwork);

                saveContext(dir, active, {
                    ...ctx,
                    perms: {
                        ...ctx.perms,
                        codexSandboxMode:   newMode,
                        codexNetworkAccess: keepNetwork ? true : (ctx.perms && ctx.perms.codexNetworkAccess === true && newMode === 'workspace-write'),
                    },
                });

                // Re-derive the global approval_policy from the union of
                // sandbox modes, falling back to "untrusted" when cloud
                // requirements forbid "never".
                const ctxs1 = listContexts(dir).map(n => loadContext(dir, n));
                setCodexApprovalPolicy(deriveApprovalPolicyForSandboxModes({
                    anyDanger:  ctxs1.some(c => c && c.perms && c.perms.codexSandboxMode === 'danger-full-access'),
                    anyWsWrite: ctxs1.some(c => c && c.perms && c.perms.codexSandboxMode === 'workspace-write'),
                }));

                if (newMode && this._actions.probeCodex) {
                    this._actions.probeCodex().then(probe => {
                        if (!probe.ok) {
                            vscode.window.showWarningMessage(
                                `Sandbox config applied for [${active}], but no Codex installation detected (${probe.error}). Codex may not honor the new mode until the CLI is on PATH or the Codex VS Code extension is installed.`
                            );
                        }
                    });
                }
                this.refresh();
                break;
            }
            case 'setCodexNetworkAccess': {
                if (!active) break;
                const { applyCodexSandboxNetworkAccess } = require('./permissions');
                const { loadContext } = require('./context');
                const ctx = loadContext(dir, active);
                if (!ctx.perms || ctx.perms.codexSandboxMode !== 'workspace-write') {
                    // Defensive: only meaningful in workspace-write mode.
                    this.refresh();
                    break;
                }
                const enabling = msg.enabled === true;
                const result = applyCodexSandboxNetworkAccess(ctx.root, enabling);
                if (!result.ok) {
                    vscode.window.showErrorMessage(`Network access toggle failed: ${result.error}`);
                    this.refresh();
                    break;
                }
                saveContext(dir, active, {
                    ...ctx,
                    perms: { ...ctx.perms, codexNetworkAccess: enabling },
                });
                this.refresh();
                break;
            }
            case 'setCodexRecommended': {
                if (!active) break;
                const { applyCodexSandboxMode, applyCodexSandboxNetworkAccess, setCodexApprovalPolicy, deriveApprovalPolicyForSandboxModes } = require('./permissions');
                const { listContexts, loadContext } = require('./context');
                const ctx = loadContext(dir, active);
                const m = applyCodexSandboxMode(ctx.root, 'workspace-write');
                if (!m.ok) {
                    vscode.window.showErrorMessage(`Recommended setup failed: ${m.error}`);
                    this.refresh();
                    break;
                }
                applyCodexSandboxNetworkAccess(ctx.root, false);
                saveContext(dir, active, {
                    ...ctx,
                    perms: { ...ctx.perms, codexSandboxMode: 'workspace-write', codexNetworkAccess: false },
                });
                const ctxs2 = listContexts(dir).map(n => loadContext(dir, n));
                setCodexApprovalPolicy(deriveApprovalPolicyForSandboxModes({
                    anyDanger:  ctxs2.some(c => c && c.perms && c.perms.codexSandboxMode === 'danger-full-access'),
                    anyWsWrite: ctxs2.some(c => c && c.perms && c.perms.codexSandboxMode === 'workspace-write'),
                }));
                this.refresh();
                break;
            }
            case 'switchToPrev': {
                if (this._actions.switchToPrev) await this._actions.switchToPrev();
                break;
            }
            case 'rescanProjects': {
                if (this._actions.rescanProjects) await this._actions.rescanProjects();
                break;
            }
            case 'manageRemovalCommands': {
                if (this._actions.manageRemovalCommands) await this._actions.manageRemovalCommands();
                this.refresh();
                break;
            }
            case 'addSecondary': {
                if (this._actions.addSecondary) await this._actions.addSecondary();
                break;
            }
            case 'removeSecondary': {
                if (this._actions.removeSecondary) await this._actions.removeSecondary(msg.name);
                break;
            }
            case 'togglePinSecondary': {
                if (this._actions.togglePinSecondary) await this._actions.togglePinSecondary(msg.name);
                break;
            }
            case 'duplicateContext': {
                await vscode.commands.executeCommand('ai.duplicateContext');
                break;
            }
            case 'healthCheck': {
                await vscode.commands.executeCommand('ai.healthCheck');
                break;
            }
            case 'saveAsTemplate': {
                await vscode.commands.executeCommand('ai.saveAsTemplate');
                break;
            }
            case 'newFromTemplate': {
                await vscode.commands.executeCommand('ai.newContextFromTemplate');
                break;
            }
            case 'toggleSection': {
                // Persist open/closed state for the named section. Webview
                // already updated its own DOM optimistically; we only need
                // to write through to globalState so other surfaces and
                // future sessions observe the new state.
                if (typeof msg.id === 'string') {
                    this._setSectionState(msg.id, !!msg.open);
                    // Re-broadcast so any other open surface (panel + sidebar)
                    // mirrors the change.
                    this.refresh();
                }
                break;
            }
            case 'aiuInit':          await vscode.commands.executeCommand('ai.aiuInit');          this.refresh(); break;
            case 'aiuStatus':        await vscode.commands.executeCommand('ai.aiuStatus');        this.refresh(); break;
            case 'aiuRefresh':       await vscode.commands.executeCommand('ai.aiuRefresh');       this.refresh(); break;
            case 'aiuInstallHook':   await vscode.commands.executeCommand('ai.aiuInstallHook');   this.refresh(); break;
            case 'aiuUninstallHook': await vscode.commands.executeCommand('ai.aiuUninstallHook'); this.refresh(); break;
        }
    }

    _getHtml() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding-bottom:24px}
.section{margin-bottom:1px}
.sec-hdr{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--vscode-sideBarSectionHeader-foreground,var(--vscode-foreground));background:var(--vscode-sideBarSectionHeader-background,transparent);padding:8px 12px 6px;border-bottom:1px solid var(--vscode-sideBarSectionHeader-border,transparent);display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none}
.sec-hdr:hover{opacity:.85}
.sec-body{padding:8px 12px}
.sec-body.hide{display:none}
.chev{font-size:10px;transition:transform .15s;display:inline-block}
.chev.open{transform:rotate(90deg)}
.active-card{background:var(--vscode-editor-inactiveSelectionBackground,rgba(255,255,255,.05));border:1px solid var(--vscode-focusBorder,rgba(255,255,255,.12));border-radius:4px;padding:10px 12px;margin-bottom:8px}
.act-name{font-size:13px;font-weight:600;color:var(--vscode-textLink-foreground,#4fc3f7);margin-bottom:2px}
.health-dot{font-size:9px;vertical-align:middle;margin-left:4px}
.health-ok{color:#4caf50}.health-warn{color:#ff9800}
.act-root{font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:8px;word-break:break-all}
.no-active{color:var(--vscode-descriptionForeground);font-style:italic;margin-bottom:8px}
.btn-row{display:flex;gap:6px;flex-wrap:wrap}
button{padding:4px 10px;font-size:12px;font-family:var(--vscode-font-family);background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:3px;cursor:pointer}
button:hover{background:var(--vscode-button-hoverBackground)}
button.sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button.sec:hover{background:var(--vscode-button-secondaryHoverBackground)}
button.full{width:100%;margin-top:8px}
button.danger{background:var(--vscode-inputValidation-errorBackground,#5a1d1d);color:var(--vscode-foreground)}
button.danger:hover{opacity:.85}
button.warn{background:var(--vscode-inputValidation-warningBackground,#664d00);color:var(--vscode-foreground);margin-top:8px}
button.warn:hover{opacity:.85}
button:disabled{opacity:.4;cursor:not-allowed}
button:disabled:hover{opacity:.4;background:var(--vscode-button-background)}
.ctx-item{display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--vscode-widget-border,rgba(255,255,255,.05))}
.ctx-item:last-child{border-bottom:none}
.ctx-info{flex:1;min-width:0}
.ctx-n{font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ctx-n.active{color:var(--vscode-textLink-foreground,#4fc3f7)}
.ctx-t{font-size:10px;color:var(--vscode-descriptionForeground)}
.tog-row{display:flex;align-items:flex-start;justify-content:space-between;padding:6px 0;gap:8px;border-bottom:1px solid var(--vscode-widget-border,rgba(255,255,255,.05))}
.tog-row:last-child{border-bottom:none}
.tog-lbl{flex:1}
.tog-lbl-txt{font-size:12px;font-weight:500}
.tog-desc{font-size:10px;color:var(--vscode-descriptionForeground);margin-top:1px}
.toggle{position:relative;width:28px;height:16px;flex-shrink:0;margin-top:2px}
.toggle input{opacity:0;width:0;height:0}
.slider{position:absolute;inset:0;background:var(--vscode-input-background,#3c3c3c);border:1px solid var(--vscode-input-border,rgba(255,255,255,.15));border-radius:8px;cursor:pointer;transition:background .15s}
.slider::before{content:'';position:absolute;width:10px;height:10px;left:2px;top:2px;background:var(--vscode-foreground);border-radius:50%;transition:transform .15s;opacity:.5}
input:checked+.slider{background:var(--vscode-button-background);border-color:var(--vscode-button-background)}
input:checked+.slider::before{transform:translateX(12px);opacity:1}
.agent-row{display:flex;align-items:center;padding:4px 0;border-bottom:1px solid var(--vscode-widget-border,rgba(255,255,255,.05))}
.agent-row:last-child{border-bottom:none}
.agent-row label{display:flex;align-items:center;gap:8px;cursor:pointer;flex:1;font-size:12px}
.agent-row input[type=checkbox]{accent-color:var(--vscode-button-background);cursor:pointer}
.agent-file{font-size:10px;color:var(--vscode-descriptionForeground)}
/* Permissions */
.perm-subsec{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--vscode-descriptionForeground);margin:8px 0 4px}
.perm-subsec:first-child{margin-top:0}
.perm-item{display:flex;align-items:center;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--vscode-widget-border,rgba(255,255,255,.05));gap:6px}
.perm-item:last-child{border-bottom:none}
.perm-txt{font-size:11px;font-family:var(--vscode-editor-font-family,monospace);flex:1;word-break:break-all}
.perm-rm{background:none;border:none;color:var(--vscode-descriptionForeground);cursor:pointer;font-size:14px;padding:0 2px;line-height:1;border-radius:2px}
.perm-rm:hover{color:var(--vscode-errorForeground,#f48771);background:transparent}
.perm-empty{font-size:11px;color:var(--vscode-descriptionForeground);font-style:italic;padding:4px 0}
.safe-add-row{display:flex;gap:6px;margin:4px 0 2px}
.safe-input{flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(255,255,255,.15));border-radius:3px;padding:3px 6px;font-size:11px;font-family:var(--vscode-editor-font-family,monospace)}
.safe-input:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
.sandbox-toggle{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--vscode-widget-border,rgba(255,255,255,.05))}
.sandbox-info{flex:1}
.sandbox-label{font-size:12px;font-weight:500;margin-bottom:2px}
.sandbox-status{font-size:12px;color:var(--vscode-textLink-foreground,#4fc3f7);font-weight:500}
.sandbox-desc{font-size:10px;color:var(--vscode-descriptionForeground);margin-top:1px}
.sandbox-toggle .toggle{margin-top:0;flex-shrink:0}
.sandbox-radio-group{padding:6px 0 4px;border-bottom:1px solid var(--vscode-widget-border,rgba(255,255,255,.05))}
.sandbox-radio-hdr{font-size:12px;font-weight:500;margin-bottom:6px}
.sandbox-radio{display:flex;align-items:flex-start;gap:6px;padding:4px 0;cursor:pointer}
.sandbox-radio input[type=radio]{margin-top:2px;flex-shrink:0}
.sb-rb-label{font-size:12px;font-weight:500;min-width:135px}
.sb-rb-desc{font-size:10px;color:var(--vscode-descriptionForeground);flex:1}
.sb-rb-danger .sb-rb-label{color:var(--vscode-errorForeground,#f48771)}
.sb-recommended{margin-top:6px}
.sandbox-runtime{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;padding:6px 8px;border-radius:3px;font-size:11px;margin-bottom:6px}
.sandbox-runtime.rt-ok{background:rgba(80,200,120,.06);border:1px solid rgba(80,200,120,.2)}
.sandbox-runtime.rt-warn{background:rgba(255,160,60,.08);border:1px solid rgba(255,160,60,.3)}
.rt-icon{font-weight:700}
.rt-label{color:var(--vscode-descriptionForeground)}
.rt-detail{font-family:var(--vscode-editor-font-family,monospace);font-size:10px}
.rt-advice{flex-basis:100%;margin-top:3px;font-size:10px}
.rt-advice code{background:var(--vscode-textCodeBlock-background,rgba(255,255,255,.06));padding:1px 4px;border-radius:2px;font-family:var(--vscode-editor-font-family,monospace)}
.sandbox-caveat{font-size:10px;color:var(--vscode-descriptionForeground);padding:4px 0;font-style:italic;cursor:help;border-bottom:1px solid var(--vscode-widget-border,rgba(255,255,255,.05))}
.cloud-reqs-banner{background:rgba(255,160,60,.10);border:1px solid rgba(255,160,60,.40);border-radius:3px;padding:6px 8px;margin-bottom:8px;font-size:11px}
.cb-title{font-weight:600;color:var(--vscode-editorWarning-foreground,#ffa040);margin-bottom:4px}
.cb-detail{font-family:var(--vscode-editor-font-family,monospace);font-size:10px;color:var(--vscode-foreground);padding:1px 0}
.cb-shadow{color:var(--vscode-editorWarning-foreground,#ffa040);font-style:italic}
.cb-meta{font-size:9px;color:var(--vscode-descriptionForeground);margin-top:4px;font-style:italic}
.sb-rb-blocked{opacity:.55;cursor:not-allowed}
.sb-rb-blocked input[type=radio]{cursor:not-allowed}
.sb-rb-policy{color:var(--vscode-errorForeground,#f48771);font-size:9px;font-weight:600;margin-left:4px;text-transform:uppercase;letter-spacing:.04em}
.codex-trust-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--vscode-widget-border,rgba(255,255,255,.05))}
.codex-trust-row:last-child{border-bottom:none}
.trust-label{font-size:12px;font-weight:500;white-space:nowrap;margin-right:8px}
.codex-trust-row select{flex:1}
.codex-trust-row select.disabled{opacity:.5;cursor:not-allowed}
.inactive{font-size:10px;color:var(--vscode-descriptionForeground);font-weight:normal;margin-left:4px;display:block;margin-top:2px}
select{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(255,255,255,.15));border-radius:3px;padding:3px 6px;font-size:12px;font-family:var(--vscode-font-family);cursor:pointer;flex:1}
select:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
select:disabled{opacity:.5;cursor:not-allowed}
/* Previous context card */
.prev-card{border:1px dashed var(--vscode-widget-border,rgba(255,255,255,.1));border-radius:4px;padding:8px 12px;margin-top:6px;opacity:.7}
.sec-list{margin-top:6px;padding:6px 10px;background:var(--vscode-editor-inactiveSelectionBackground,rgba(255,255,255,.04));border-radius:4px}
.sec-list-hdr{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--vscode-descriptionForeground);margin-bottom:4px}
.sec-empty{font-size:11px;color:var(--vscode-descriptionForeground);font-style:italic;padding:2px 0}
.sec-chip{display:inline-flex;align-items:center;background:var(--vscode-input-background,#3c3c3c);border:1px solid var(--vscode-input-border,rgba(255,255,255,.15));border-radius:10px;padding:2px 4px 2px 4px;margin:2px 4px 2px 0;font-size:11px;max-width:100%}
.sec-chip-pinned{border-color:var(--vscode-textLink-foreground,#4fc3f7);background:rgba(79,195,247,.08)}
.sec-chip-pin{background:none;border:none;color:var(--vscode-foreground);cursor:pointer;font-size:13px;line-height:1;padding:1px 4px;opacity:.7;border-radius:8px}
.sec-chip-pin.on{opacity:1;color:var(--vscode-textLink-foreground,#4fc3f7)}
.sec-chip-pin:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground,rgba(255,255,255,.08))}
.sec-chip-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px;padding:0 4px}
.sec-chip-rm{background:none;border:none;color:var(--vscode-descriptionForeground);cursor:pointer;font-size:14px;line-height:1;padding:0 2px;margin-left:2px}
.sec-chip-rm:hover{color:var(--vscode-errorForeground,#f48771)}
.sec-chip-add{background:none;border:1px dashed var(--vscode-input-border,rgba(255,255,255,.15));color:var(--vscode-descriptionForeground);border-radius:10px;padding:2px 8px;margin:2px 0;font-size:11px;cursor:pointer}
.sec-chip-add:hover{background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-foreground)}
.prev-label{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--vscode-descriptionForeground);margin-bottom:3px}
.prev-name{font-size:12px;font-weight:500;color:var(--vscode-foreground);margin-bottom:1px}
.prev-root{font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:6px;word-break:break-all}
/* Info */
.info-row{padding:3px 0;font-size:11px;display:flex;gap:6px;flex-wrap:wrap}
.info-k{color:var(--vscode-descriptionForeground);white-space:nowrap}
.info-v{font-family:var(--vscode-editor-font-family,monospace);word-break:break-all}
</style>
</head>
<body>
<div id="root"></div>
<script>
const vscode = acquireVsCodeApi();
let S = { active: null, previous: null, contexts: [], settings: {}, perms: { allow: [], codex: 'trusted', safeCommands: [], codexSandboxMode: null, codexNetworkAccess: false }, removalCount: 0, secondaries: [], version: '', activeHealth: null, templates: [], aiu: { workspaceOpen: false }, sectionStates: {}, sandboxRuntime: null, cloudReqs: null };

const ALL_AGENTS  = ['claude','codex','copilot','cursor','windsurf','kilo'];
const AGENT_FILES = { claude:'CLAUDE.md', codex:'AGENTS.md', copilot:'copilot-instructions.md', cursor:'.cursorrules', windsurf:'.windsurfrules', kilo:'AGENTS.md' };
const TRUST_LEVELS = ['full-auto','trusted','auto','untrusted'];
const TOGGLES = [
    { key:'followActiveEditor',          label:'Follow Active Editor',  desc:'Switch context when editor tab changes to another project' },
    { key:'followTerminalCwd',           label:'Follow Terminal CWD',   desc:'Switch context on terminal CWD change (shell integration)' },
    { key:'autoDetect',                  label:'Auto Detect',           desc:'Detect context from workspace path on startup' },
    { key:'scanOnLaunch',                label:'Scan on Launch',        desc:'Auto-create contexts for new projects found in projectsRoot' },
    { key:'showNotifications',           label:'Notifications',         desc:'Toast messages on context switch' },
    { key:'autoGitignore',               label:'Auto .gitignore',       desc:'Add injected AI files to .gitignore automatically' },
    { key:'codexProjectSwitchBootstrap', label:'Codex Bootstrap',       desc:'Write AGENTS.md bootstrap to projectsRoot for Codex' },
    { key:'codexFullAuto',               label:'Codex Full-Auto',       desc:'Every codex session runs --approval-mode full-auto (alias in ~/.bashrc + global config.toml)' },
    { key:'preventRemovalCapture',       label:'Prevent Removal Capture',  desc:'Block rm, del, rmdir, erase and similar commands from being captured and remembered' },
    { key:'autoPromoteOnSwitch',         label:'Auto-Promote On Switch',   desc:'When the active context switches, push the outgoing primary onto the secondary stack (LRU eviction respects pinned secondaries)' },
];

function fmt(iso) {
    if (!iso) return 'never';
    const d = new Date(iso), now = new Date();
    const diff = Math.floor((now - d) / 1000);
    if (diff < 60)   return 'just now';
    if (diff < 3600) return Math.floor(diff/60) + 'm ago';
    if (diff < 86400)return Math.floor(diff/3600) + 'h ago';
    return d.toLocaleDateString();
}

function render() {
    const { active, previous, contexts, settings, perms, version, secondaries, activeHealth, templates, aiu } = S;
    const activeCtx   = contexts.find(c => c.name === active);
    const secList     = Array.isArray(secondaries) ? secondaries : [];
    const agents      = settings.agents || ['claude','codex','copilot'];
    const claudePerms      = perms.allow || [];
    const codexTrust       = perms.codex  || 'trusted';
    const safeCommands     = perms.safeCommands || [];
    const codexSandboxMode = (perms.codexSandboxMode === 'workspace-write' || perms.codexSandboxMode === 'danger-full-access') ? perms.codexSandboxMode : null;
    const codexNetworkAccess = perms.codexNetworkAccess === true;
    const sandboxOff       = codexSandboxMode === null;
    const sandboxDanger    = codexSandboxMode === 'danger-full-access';
    const sandboxRuntime   = S.sandboxRuntime || null;
    const cloudReqs        = S.cloudReqs || null;
    const cloudActive      = !!(cloudReqs && cloudReqs.active && !cloudReqs.expired);
    const sandboxAllowed   = cloudActive && Array.isArray(cloudReqs.sandboxAllowed) ? cloudReqs.sandboxAllowed : null;
    const approvalAllowed  = cloudActive && Array.isArray(cloudReqs.approvalAllowed) ? cloudReqs.approvalAllowed : null;
    const blocked = (mode) => {
        if (!sandboxAllowed) return false;
        if (mode === null) return false; // 'Off' is always permitted (cloud has its own default)
        return !sandboxAllowed.includes(mode);
    };
    const dangerBlocked = blocked('danger-full-access');
    const wsWriteBlocked = blocked('workspace-write');

    const prevCard = previous ? \`
        <div class="prev-card">
            <div class="prev-label">↩ Previous</div>
            <div class="prev-name">\${esc(previous.name)}</div>
            <div class="prev-root">\${esc(previous.root)}</div>
            <button class="sec" onclick="send('switchToPrev')">⇄ Make Active</button>
        </div>\` : '';

    const secondariesBlock = active ? \`
        <div class="sec-list">
            <div class="sec-list-hdr">Secondary contexts (\${secList.length})</div>
            \${secList.length
                ? secList.map(s => \`
                    <div class="sec-chip\${s.pinned ? ' sec-chip-pinned' : ''}">
                        <button class="sec-chip-pin\${s.pinned ? ' on' : ''}" title="\${s.pinned ? 'Unpin (allow LRU eviction)' : 'Pin (exempt from LRU eviction)'}" onclick="togglePin('\${esc(s.name)}')">\${s.pinned ? '📌' : '◌'}</button>
                        <span class="sec-chip-name" title="\${esc(s.root)}">\${esc(s.name)}</span>
                        <button class="sec-chip-rm" title="Remove secondary" onclick="removeSec('\${esc(s.name)}')">×</button>
                    </div>\`).join('')
                : '<div class="sec-empty">none</div>'
            }
            <button class="sec-chip-add" onclick="send('addSecondary')">+ Add secondary</button>
        </div>\` : '';

    const permsBody = active ? \`
        <div class="perm-subsec">Allow List — Claude &amp; Codex (\${claudePerms.length})</div>
        \${claudePerms.length
            ? claudePerms.map((p,i) => \`
                <div class="perm-item">
                    <span class="perm-txt">\${esc(p)}</span>
                    <button class="perm-rm" title="Remove" onclick="removePerm(\${i})">×</button>
                </div>\`).join('')
            : '<div class="perm-empty">No permissions captured yet</div>'
        }
        <div class="perm-subsec">Codex — Safe Commands (\${safeCommands.length})</div>
        \${safeCommands.map((c,i) => \`
            <div class="perm-item">
                <span class="perm-txt">\${esc(c)}</span>
                <button class="perm-rm" title="Remove" onclick="removeSafeCmd(\${i})">×</button>
            </div>\`).join('')}
        <div class="safe-add-row">
            <input id="safe-input" class="safe-input" type="text" placeholder="prefix e.g. du -sh"
                onkeydown="if(event.key==='Enter')addSafeCmd()">
            <button class="sec" onclick="addSafeCmd()">+</button>
        </div>
        <button class="sec full" onclick="send('managePermissions')">Advanced Permissions…</button>
    \` : '<div class="perm-empty">No active context</div>';

    const runtimeRow = sandboxRuntime ? \`
        <div class="sandbox-runtime \${sandboxRuntime.ok ? 'rt-ok' : 'rt-warn'}">
            <span class="rt-icon">\${sandboxRuntime.ok ? '✓' : '⚠'}</span>
            <span class="rt-label">Sandbox runtime (\${esc(sandboxRuntime.platform)}):</span>
            <span class="rt-detail">\${esc(sandboxRuntime.detail || '')}</span>
            \${sandboxRuntime.advice ? \`<div class="rt-advice"><code>\${esc(sandboxRuntime.advice)}</code></div>\` : ''}
        </div>\` : '';

    const cloudBanner = cloudActive ? \`
        <div class="cloud-reqs-banner">
            <div class="cb-title">⚠ Cloud-managed Codex requirements active</div>
            <div class="cb-detail">sandbox_mode: \${esc((sandboxAllowed||[]).join(', ') || 'unrestricted')}</div>
            <div class="cb-detail">approval_policy: \${esc((approvalAllowed||[]).join(', ') || 'unrestricted')}</div>
            \${cloudReqs.prefixRulesPromptCount > 0 ? \`<div class="cb-detail">cloud also forces approval prompts on \${cloudReqs.prefixRulesPromptCount} command-prefix rule group(s) — shells, runtimes, network tools, package managers, etc. — that local rules cannot override</div>\` : ''}
            \${cloudReqs.shadowedAllowCount > 0 ? \`<div class="cb-detail cb-shadow">\${cloudReqs.shadowedAllowCount} entr\${cloudReqs.shadowedAllowCount === 1 ? 'y' : 'ies'} in this context's trusted list \${cloudReqs.shadowedAllowCount === 1 ? 'is' : 'are'} shadowed by cloud rules — not written to Codex (would no-op anyway)</div>\` : ''}
            <div class="cb-meta">expires \${esc(cloudReqs.expiresAt || 'unknown')} · cached from cloud requirements</div>
        </div>
    \` : '';

    const codexBody = active ? \`
        \${cloudBanner}
        \${runtimeRow}
        <div class="sandbox-radio-group">
            <div class="sandbox-radio-hdr">Sandbox Mode</div>
            <label class="sandbox-radio">
                <input type="radio" name="sandboxMode" value="off" \${sandboxOff ? 'checked' : ''}
                    onchange="setSandboxMode(null)">
                <span class="sb-rb-label">Off</span>
                <span class="sb-rb-desc">no sandbox_mode line — Codex default</span>
            </label>
            <label class="sandbox-radio \${wsWriteBlocked ? 'sb-rb-blocked' : ''}" title="\${wsWriteBlocked ? 'Blocked by cloud requirements — Codex will downgrade at runtime' : ''}">
                <input type="radio" name="sandboxMode" value="workspace-write" \${codexSandboxMode==='workspace-write' ? 'checked' : ''}
                    \${wsWriteBlocked ? 'disabled' : ''}
                    onchange="setSandboxMode('workspace-write')">
                <span class="sb-rb-label">Workspace-write\${wsWriteBlocked ? ' <span class=\\\\"sb-rb-policy\\\\">⛔ blocked by policy</span>' : ''}</span>
                <span class="sb-rb-desc">writes inside workspace; network off; approval prompts at default</span>
            </label>
            <label class="sandbox-radio sb-rb-danger \${dangerBlocked ? 'sb-rb-blocked' : ''}" title="\${dangerBlocked ? 'Blocked by cloud requirements — Codex will downgrade to a Restricted/Managed profile at runtime regardless of this setting' : ''}">
                <input type="radio" name="sandboxMode" value="danger-full-access" \${sandboxDanger ? 'checked' : ''}
                    \${dangerBlocked ? 'disabled' : ''}
                    onchange="setSandboxMode('danger-full-access')">
                <span class="sb-rb-label">Danger-full-access\${dangerBlocked ? ' <span class=\\\\"sb-rb-policy\\\\">⛔ blocked by policy</span>' : ''}</span>
                <span class="sb-rb-desc">no sandbox; sets approval_policy = "never" globally</span>
            </label>
        </div>
        \${codexSandboxMode === 'workspace-write' ? \`
            <div class="sandbox-toggle">
                <div class="sandbox-info">
                    <div class="sandbox-label">Network Access</div>
                    <div class="sandbox-status">\${codexNetworkAccess ? '✓ enabled' : '○ disabled'}</div>
                    <div class="sandbox-desc">\${codexNetworkAccess ? '[sandbox_workspace_write] network_access = true' : 'workspace-only writes; no network'}</div>
                </div>
                <label class="toggle">
                    <input type="checkbox" \${codexNetworkAccess ? 'checked' : ''}
                        onchange="send('setCodexNetworkAccess', {enabled: this.checked})">
                    <span class="slider"></span>
                </label>
            </div>
        \` : ''}
        <button class="sec full sb-recommended" onclick="send('setCodexRecommended')" title="Sets sandbox_mode = workspace-write and network_access = false">⚙ Recommended setup (workspace-write, no network)</button>
        <div class="sandbox-caveat" title="Some Codex VS Code extension versions ignore config.toml overrides for sandbox_mode / approval_policy. Verify by asking Codex to write outside the workspace — it should refuse or prompt.">
            ⓘ Some Codex VS Code extension versions ignore config.toml overrides — verify behavior after toggling.
        </div>
        <div class="codex-trust-row">
            <div class="trust-label">Trust Level \${sandboxDanger ? '<span class="inactive">(inactive — danger-full-access on)</span>' : ''}</div>
            <select onchange="setCodexTrust(this.value)" \${sandboxDanger ? 'disabled' : ''} class="\${sandboxDanger ? 'disabled' : ''}">
                \${TRUST_LEVELS.map(l => \`<option value="\${l}" \${l===codexTrust?'selected':''}>\${l}</option>\`).join('')}
            </select>
        </div>
    \` : '';

    const aiuBody = !aiu || !aiu.workspaceOpen
        ? '<div class="perm-empty">Open a workspace folder or set an active context to use AI Understanding.</div>'
        : (() => {
            const lines = [];
            lines.push(\`<div class="info-row"><span class="info-k">Project</span><span class="info-v" title="\${esc(aiu.root)}">\${esc(aiu.project)}</span></div>\`);
            if (aiu.noActiveContext) {
                lines.push('<div class="perm-empty" style="font-size:0.85em;margin:4px 0">No active context — using workspace folder. Set an active context for project-specific AIU.</div>');
            }
            const summaryClass = !aiu.initialized
                ? 'health-warn'
                : (aiu.stale + aiu.untracked + aiu.orphan === 0 ? 'health-ok' : 'health-warn');
            lines.push(\`<div class="info-row"><span class="info-k">Status</span><span class="info-v \${summaryClass}">\${esc(aiu.summary)}</span></div>\`);
            if (aiu.initialized) {
                lines.push(\`<div class="info-row"><span class="info-k">Fresh</span><span class="info-v">\${aiu.fresh}</span></div>\`);
                if (aiu.stale)     lines.push(\`<div class="info-row"><span class="info-k">Stale</span><span class="info-v health-warn">\${aiu.stale}</span></div>\`);
                if (aiu.untracked) lines.push(\`<div class="info-row"><span class="info-k">Untracked</span><span class="info-v health-warn">\${aiu.untracked}</span></div>\`);
                if (aiu.orphan)    lines.push(\`<div class="info-row"><span class="info-k">Orphan</span><span class="info-v health-warn">\${aiu.orphan}</span></div>\`);
            }
            const hookRow = aiu.isGitRepo
                ? \`<div class="info-row"><span class="info-k">Pre-commit hook</span><span class="info-v">\${aiu.hookInstalled ? '✓ installed' : '○ not installed'}</span></div>\`
                : '<div class="info-row"><span class="info-k">Pre-commit hook</span><span class="info-v">— not a git repo</span></div>';
            lines.push(hookRow);
            const buttons = [];
            if (!aiu.initialized) {
                buttons.push('<button class="sec full" onclick="send(\\'aiuInit\\')">Initialize AI_UNDERSTANDING/</button>');
            } else {
                buttons.push('<button class="sec full" onclick="send(\\'aiuStatus\\')">Show Status / Open Files</button>');
                buttons.push('<button class="sec full" onclick="send(\\'aiuRefresh\\')">Refresh</button>');
            }
            if (aiu.isGitRepo) {
                buttons.push(aiu.hookInstalled
                    ? '<button class="sec full" onclick="send(\\'aiuUninstallHook\\')">Uninstall Pre-commit Hook</button>'
                    : '<button class="sec full" onclick="send(\\'aiuInstallHook\\')">Install Pre-commit Hook</button>');
            }
            return lines.join('') + buttons.join('');
        })();

    document.getElementById('root').innerHTML =
        section('active', 'Active Context', true,
            (active && activeCtx)
                ? \`<div class="active-card">
                    <div class="act-name">\${esc(active)}\${activeHealth ? \` <span class="health-dot \${activeHealth.ok ? 'health-ok' : 'health-warn'}" title="\${esc(activeHealth.ok ? 'Healthy' : activeHealth.warnings.join(' · '))}">●</span>\` : ''}</div>
                    <div class="act-root">\${esc(activeCtx.root)}</div>
                    <div class="btn-row">
                        <button onclick="send('reinject')">↺ Reinject</button>
                        <button class="sec" onclick="send('setActive')">⇄ Switch</button>
                        <button class="sec" onclick="send('rescanProjects')" title="Scan projectsRoot for new project folders and create contexts">↻ Rescan</button>
                        <button class="sec" onclick="send('duplicateContext')" title="Duplicate this context">⧉</button>
                        <button class="sec" onclick="send('saveAsTemplate')" title="Save as template">⊞</button>
                    </div></div>\${secondariesBlock}\${prevCard}\`
                : \`<div class="no-active">No active context</div>
                   <button onclick="send('setActive')">Set Active</button>
                   <button class="sec full" onclick="send('rescanProjects')" title="Scan projectsRoot for new project folders and create contexts">↻ Rescan Projects</button>\${prevCard}\`
        ) +
        section('projects', \`Projects (\${contexts.length})\`, true,
            contexts.map(c => \`
                <div class="ctx-item">
                    <div class="ctx-info">
                        <div class="ctx-n \${c.name === active ? 'active' : ''}">\${esc(c.name)}</div>
                        <div class="ctx-t">\${fmt(c.lastUsed)}</div>
                    </div>
                </div>\`).join('') +
            \`<button class="sec full" onclick="send('newContext')">+ New Context</button>\`
        ) +
        section('templates', \`Templates (\${templates.length})\`, false,
            (templates.length
                ? templates.map(t => \`
                    <div class="ctx-item">
                        <div class="ctx-info">
                            <div class="ctx-n">\${esc(t.name)}</div>
                            <div class="ctx-t">\${t.decisions}d · \${t.files}f</div>
                        </div>
                    </div>\`).join('')
                : '<div class="perm-empty">No templates yet — use ⊞ on an active context</div>'
            ) +
            \`<button class="sec full" onclick="send('newFromTemplate')">+ New from Template</button>\`
        ) +
        section('aiu', 'AI Understanding', false, aiuBody) +
        section('codex', 'Codex Settings', true, codexBody) +
        section('behaviour', 'Behaviour', true,
            TOGGLES.map(t => \`
                <div class="tog-row">
                    <div class="tog-lbl">
                        <div class="tog-lbl-txt">\${t.label}</div>
                        <div class="tog-desc">\${t.desc}</div>
                    </div>
                    <label class="toggle">
                        <input type="checkbox" \${settings[t.key] !== false ? 'checked' : ''}
                            onchange="sendToggle('\${t.key}',this.checked)">
                        <span class="slider"></span>
                    </label>
                </div>\`).join('')
            + renderRemovalButton()
        ) +
        section('agents', 'Agents', true,
            ALL_AGENTS.map(a => \`
                <div class="agent-row">
                    <label>
                        <input type="checkbox" \${agents.includes(a) ? 'checked' : ''}
                            onchange="sendAgent('\${a}',this.checked)">
                        <span>\${a.charAt(0).toUpperCase()+a.slice(1)}
                            <span class="agent-file"> → \${AGENT_FILES[a]}</span>
                        </span>
                    </label>
                </div>\`).join('')
        ) +
        section('permissions', \`Permissions\${active ? ' — ' + esc(active) : ''}\`, false, permsBody) +
        section('about', 'About', false,
            \`<div class="info-row"><span class="info-k">Version</span><span class="info-v">v\${esc(version)}</span></div>
             <div class="info-row"><span class="info-k">Projects Root</span><span class="info-v">\${esc(settings.projectsRoot||'~/projects')}</span></div>
             <button class="sec full" onclick="send('openSettings')">Open VS Code Settings</button>\`
        );
}

function section(id, title, defaultOpen, body) {
    // Stored state wins over the default. Open if globalState says so or
    // (when no entry yet) the caller's default. This is what makes
    // collapsed/expanded headers stick across reloads and windows.
    const stored = S.sectionStates && S.sectionStates[id];
    const open = stored === undefined ? defaultOpen : !!stored;
    return \`<div class="section">
        <div class="sec-hdr" onclick="tog('\${id}')">
            <span>\${title}</span>
            <span class="chev \${open?'open':''}" id="c-\${id}">›</span>
        </div>
        <div class="sec-body \${open?'':'hide'}" id="b-\${id}">\${body}</div>
    </div>\`;
}

function tog(id) {
    const body = document.getElementById('b-'+id);
    const chev = document.getElementById('c-'+id);
    if (!body) return;
    const willOpen = body.classList.contains('hide');
    body.classList.toggle('hide');
    chev.classList.toggle('open');
    // Persist via the extension. Optimistic local toggle above gives
    // instant feedback; the message round-trip writes through globalState
    // and re-broadcasts so the sidebar and any open panels stay in sync.
    vscode.postMessage({ type: 'toggleSection', id, open: willOpen });
}

function removePerm(idx) {
    const perm = S.perms.allow[idx];
    if (perm) vscode.postMessage({ type: 'removeClaudePerm', perm });
}
function removeSafeCmd(idx) {
    const cmd = (S.perms.safeCommands || [])[idx];
    if (cmd) vscode.postMessage({ type: 'removeSafeCommand', cmd });
}
function addSafeCmd() {
    const input = document.getElementById('safe-input');
    if (!input || !input.value.trim()) return;
    vscode.postMessage({ type: 'addSafeCommand', cmd: input.value.trim() });
    input.value = '';
}

function setCodexTrust(level) {
    vscode.postMessage({ type: 'setCodexTrust', level });
}

function setSandboxMode(mode) {
    vscode.postMessage({ type: 'setCodexSandboxMode', mode });
}

function renderRemovalButton() {
    const count = S.removalCount || 0;
    const disabled = count === 0;
    const label = 'Manage Removal Memory' + (count > 0 ? ' (' + count + ')' : '');
    const tip = disabled ? 'No removal commands to purge' : count + ' removal command(s) — click to manage';
    return '<button class="warn full" onclick="manageRemovals()" title="' + esc(tip) + '"' + (disabled ? ' disabled' : '') + '>' + esc(label) + '</button>';
}

function manageRemovals(){ vscode.postMessage({type:'manageRemovalCommands'}); }
function removeSec(name){ vscode.postMessage({type:'removeSecondary', name}); }
function togglePin(name){ vscode.postMessage({type:'togglePinSecondary', name}); }

function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function send(type, data){ vscode.postMessage({type, ...data}); }
function sendToggle(key,value){ vscode.postMessage({type:'toggleSetting',key,value}); }
function sendAgent(agent,enabled){ vscode.postMessage({type:'toggleAgent',agent,enabled}); }

window.addEventListener('message', e => {
    if (e.data.type === 'update') { S = e.data; render(); }
});
</script>
</body>
</html>`;
    }
}

module.exports = { SettingsViewProvider };
