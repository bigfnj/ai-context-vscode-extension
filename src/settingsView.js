const vscode = require('vscode');
const { listContexts, loadContext, saveContext, getCtxDir, getProjectsRoot } = require('./context');
const { getAgents } = require('./inject');

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
];

class SettingsViewProvider {
    static viewId = 'aiContext.settingsView';

    constructor(getActiveName, getPreviousName, actions = {}) {
        this._getActiveName   = getActiveName;
        this._getPreviousName = getPreviousName || (() => null);
        this._actions         = actions;
        this._view = null;
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtml();
        webviewView.webview.onDidReceiveMessage(msg => this._handleMessage(msg));
        webviewView.onDidChangeVisibility(() => { if (webviewView.visible) this.refresh(); });
        this.refresh();
    }

    refresh() {
        if (!this._view || !this._view.visible) return;
        const dir    = getCtxDir();
        const cfg    = vscode.workspace.getConfiguration('aiContext');
        const active = this._getActiveName();

        const contexts = listContexts(dir).map(name => {
            const ctx = loadContext(dir, name);
            return { name, root: ctx.root || '', lastUsed: ctx.lastUsed || null };
        });

        let perms = { allow: [], codex: 'trusted' };
        if (active) {
            const ctx = loadContext(dir, active);
            if (ctx.perms) {
                perms.allow = Array.isArray(ctx.perms.allow) ? ctx.perms.allow : [];
                perms.codex  = typeof ctx.perms.codex === 'string' ? ctx.perms.codex : 'trusted';
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

        this._view.webview.postMessage({ type: 'update', active, previous: prevData, contexts, settings, perms, version: VERSION });
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
                    perms: { ...ctx.perms, claude: perms.filter(p => p !== msg.perm) },
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
            case 'switchToPrev': {
                if (this._actions.switchToPrev) await this._actions.switchToPrev();
                break;
            }
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
.codex-trust{display:flex;align-items:center;gap:8px;margin-top:4px}
.codex-trust label{font-size:12px;font-weight:500;white-space:nowrap}
select{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(255,255,255,.15));border-radius:3px;padding:3px 6px;font-size:12px;font-family:var(--vscode-font-family);cursor:pointer;flex:1}
select:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
/* Previous context card */
.prev-card{border:1px dashed var(--vscode-widget-border,rgba(255,255,255,.1));border-radius:4px;padding:8px 12px;margin-top:6px;opacity:.7}
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
let S = { active: null, previous: null, contexts: [], settings: {}, perms: { allow: [], codex: 'trusted' }, version: '' };

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
    const { active, previous, contexts, settings, perms, version } = S;
    const activeCtx   = contexts.find(c => c.name === active);
    const agents      = settings.agents || ['claude','codex','copilot'];
    const claudePerms = perms.allow || [];
    const codexTrust  = perms.codex  || 'trusted';

    const prevCard = previous ? \`
        <div class="prev-card">
            <div class="prev-label">↩ Previous</div>
            <div class="prev-name">\${esc(previous.name)}</div>
            <div class="prev-root">\${esc(previous.root)}</div>
            <button class="sec" onclick="send('switchToPrev')">⇄ Make Active</button>
        </div>\` : '';

    const permsBody = active ? \`
        <div class="perm-subsec">Allow List — Claude &amp; Codex (\${claudePerms.length})</div>
        \${claudePerms.length
            ? claudePerms.map((p,i) => \`
                <div class="perm-item">
                    <span class="perm-txt">\${esc(p)}</span>
                    <button class="perm-rm" title="Remove" onclick="removePerm(\${i})">×</button>
                </div>\`).join('')
            : '<div class="perm-empty">No Claude permissions captured yet</div>'
        }
        <div class="perm-subsec">Codex — Trust Level</div>
        <div class="codex-trust">
            <label>Trust:</label>
            <select onchange="setCodexTrust(this.value)">
                \${TRUST_LEVELS.map(l => \`<option value="\${l}" \${l===codexTrust?'selected':''}>\${l}</option>\`).join('')}
            </select>
        </div>
        <button class="sec full" onclick="send('managePermissions')">Advanced Permissions…</button>
    \` : '<div class="perm-empty">No active context</div>';

    document.getElementById('root').innerHTML =
        section('active', 'Active Context', true,
            (active && activeCtx)
                ? \`<div class="active-card">
                    <div class="act-name">\${esc(active)}</div>
                    <div class="act-root">\${esc(activeCtx.root)}</div>
                    <div class="btn-row">
                        <button onclick="send('reinject')">↺ Reinject</button>
                        <button class="sec" onclick="send('setActive')">⇄ Switch</button>
                    </div></div>\${prevCard}\`
                : \`<div class="no-active">No active context</div>
                   <button onclick="send('setActive')">Set Active</button>\${prevCard}\`
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
        section('permissions', \`Permissions\${active ? ' — ' + esc(active) : ''}\`, true, permsBody) +
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
        section('about', 'About', false,
            \`<div class="info-row"><span class="info-k">Version</span><span class="info-v">v\${esc(version)}</span></div>
             <div class="info-row"><span class="info-k">Projects Root</span><span class="info-v">\${esc(settings.projectsRoot||'~/projects')}</span></div>
             <button class="sec full" onclick="send('openSettings')">Open VS Code Settings</button>\`
        );
}

function section(id, title, open, body) {
    return \`<div class="section">
        <div class="sec-hdr" onclick="tog('\${id}')">
            <span>\${title}</span>
            <span class="chev \${open?'open':''}" id="c-\${id}">›</span>
        </div>
        <div class="sec-body \${open?'':'hide'}" id="b-\${id}">\${body}</div>
    </div>\`;
}

function tog(id) {
    document.getElementById('b-'+id).classList.toggle('hide');
    document.getElementById('c-'+id).classList.toggle('open');
}

function removePerm(idx) {
    const perm = S.perms.allow[idx];
    if (perm) vscode.postMessage({ type: 'removeClaudePerm', perm });
}

function setCodexTrust(level) {
    vscode.postMessage({ type: 'setCodexTrust', level });
}

function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function send(type){ vscode.postMessage({type}); }
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
