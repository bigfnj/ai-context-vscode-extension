const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Returns the context store directory — respects aiContext.contextDir override.
function getCtxDir() {
    const config    = vscode.workspace.getConfiguration('aiContext');
    const override  = config.get('contextDir');
    if (override && override.trim()) return normalizePath(override.trim());
    return path.join(os.homedir(), '.ai-context');
}

function getArchiveDir() {
    return path.join(getCtxDir(), 'archive');
}

function getWorkspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0
        ? normalizePath(folders[0].uri.fsPath)
        : os.homedir();
}

// Normalizes a path for WSL:
//   - Resolves leading ~ to home dir
//   - Strips trailing slashes for consistent prefix matching
//   - Trims whitespace
function normalizePath(p) {
    if (!p || typeof p !== 'string') return p;
    p = p.trim();
    if (p.startsWith('~')) p = os.homedir() + p.slice(1);
    return p.replace(/\/+$/, '');
}

// Returns the configured projects root directory.
// Reads aiContext.projectsRoot from VS Code settings; falls back to ~/projects.
function getProjectsRoot() {
    const config     = vscode.workspace.getConfiguration('aiContext');
    const configured = config.get('projectsRoot');
    if (configured && configured.trim()) return normalizePath(configured.trim());
    return path.join(os.homedir(), 'projects');
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function listContexts(dir) {
    ensureDir(dir);
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => path.basename(f, '.json'));
}

function listArchivedContexts() {
    const archiveDir = getArchiveDir();
    if (!fs.existsSync(archiveDir)) return [];
    return fs.readdirSync(archiveDir)
        .filter(f => f.endsWith('.json'))
        .map(f => path.basename(f, '.json'));
}

function loadContext(dir, name) {
    const file = path.join(dir, `${name}.json`);
    if (!fs.existsSync(file)) {
        return {
            v: 1, u: os.userInfo().username, p: name, root: '',
            t: 'init', s: {}, a: [], e: null, i: '',
            createdAt: new Date().toISOString(), lastUsed: null,
        };
    }
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return {
            v: 1, u: os.userInfo().username, p: name, root: '',
            t: 'init', s: {}, a: [], e: 'ctx_parse_err', i: '',
            createdAt: null, lastUsed: null,
        };
    }
}

function loadArchivedContext(name) {
    const file = path.join(getArchiveDir(), `${name}.json`);
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return { root: '', lastUsed: null, createdAt: null };
    }
}

// Always updates lastUsed on write. Trims action history to maxActions.
// createdAt is preserved from ctx — set once on creation, survives every save.
function saveContext(dir, name, ctx) {
    ensureDir(dir);
    const config     = vscode.workspace.getConfiguration('aiContext');
    const maxActions = config.get('maxActions') || 20;
    const a          = Array.isArray(ctx.a) ? ctx.a.slice(-maxActions) : ctx.a;
    fs.writeFileSync(
        path.join(dir, `${name}.json`),
        JSON.stringify({ ...ctx, a, lastUsed: new Date().toISOString() })
    );
}

function deleteContext(dir, name) {
    const file = path.join(dir, `${name}.json`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
}

// Moves a context to archive/. Adds timestamp suffix on name collision.
function archiveContext(dir, name) {
    const src        = path.join(dir, `${name}.json`);
    const archiveDir = getArchiveDir();
    ensureDir(archiveDir);

    let dest = path.join(archiveDir, `${name}.json`);
    if (fs.existsSync(dest)) {
        dest = path.join(archiveDir, `${name}_${Date.now()}.json`);
    }
    fs.renameSync(src, dest);
    return path.basename(dest, '.json');
}

// Moves an archived context back to the active store.
// Appends _restored_N on name collision.
function restoreArchivedContext(archiveName) {
    const archiveDir = getArchiveDir();
    const src        = path.join(archiveDir, `${archiveName}.json`);
    const dir        = getCtxDir();
    ensureDir(dir);

    const baseName = archiveName.replace(/_\d{13}$/, '');
    let destName   = baseName;
    let dest       = path.join(dir, `${destName}.json`);
    let counter    = 1;
    while (fs.existsSync(dest)) {
        destName = `${baseName}_restored_${counter++}`;
        dest     = path.join(dir, `${destName}.json`);
    }
    fs.renameSync(src, dest);
    return destName;
}

// Returns subdirectory entries from the configured projectsRoot.
function listProjectDirs() {
    const projectsDir = getProjectsRoot();
    if (!fs.existsSync(projectsDir)) return [];
    try {
        return fs.readdirSync(projectsDir)
            .filter(f => {
                try { return fs.statSync(path.join(projectsDir, f)).isDirectory(); } catch { return false; }
            })
            .map(f => ({ label: f, path: path.join(projectsDir, f) }));
    } catch {
        return [];
    }
}

// Scans projectsRoot and creates a context entry for any subdirectory that
// doesn't already have a matching context (matched by root path).
// Returns an array of newly created context names.
function scanAndCreateContexts(dir, projectsRoot) {
    const normalized = normalizePath(projectsRoot);
    if (!normalized || !fs.existsSync(normalized)) return [];

    // Build set of all roots already tracked
    const existingRoots = new Set(
        listContexts(dir)
            .map(name => normalizePath(loadContext(dir, name).root))
            .filter(Boolean)
    );

    const created = [];
    try {
        const entries = fs.readdirSync(normalized).filter(f => {
            try { return fs.statSync(path.join(normalized, f)).isDirectory(); } catch { return false; }
        });

        for (const entry of entries) {
            const projectPath = normalizePath(path.join(normalized, entry));
            if (!existingRoots.has(projectPath)) {
                // Use entry name as context name; avoid collision
                let ctxName  = entry;
                let counter  = 1;
                while (fs.existsSync(path.join(dir, `${ctxName}.json`))) {
                    ctxName = `${entry}_${counter++}`;
                }
                saveContext(dir, ctxName, {
                    v:         1,
                    u:         os.userInfo().username,
                    p:         entry,
                    root:      projectPath,
                    t:         'init',
                    s:         {},
                    a:         [],
                    e:         null,
                    i:         '',
                    createdAt: new Date().toISOString(),
                });
                created.push(ctxName);
            }
        }
    } catch {
        // Ignore scan errors (permission issues, etc.)
    }
    return created;
}

function formatRelativeTime(isoString) {
    if (!isoString) return 'never';
    const diff    = Date.now() - new Date(isoString).getTime();
    const minutes = Math.floor(diff / 60000);
    const hours   = Math.floor(diff / 3600000);
    const days    = Math.floor(diff / 86400000);
    const months  = Math.floor(days / 30);
    const years   = Math.floor(days / 365);
    if (minutes < 1)  return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24)   return `${hours}h ago`;
    if (days < 30)    return `${days}d ago`;
    if (months < 12)  return `${months} month${months !== 1 ? 's' : ''} ago`;
    return `${years} year${years !== 1 ? 's' : ''} ago`;
}

module.exports = {
    getCtxDir,
    getArchiveDir,
    getWorkspaceRoot,
    getProjectsRoot,
    normalizePath,
    ensureDir,
    listContexts,
    listArchivedContexts,
    loadContext,
    loadArchivedContext,
    saveContext,
    deleteContext,
    archiveContext,
    restoreArchivedContext,
    listProjectDirs,
    scanAndCreateContexts,
    formatRelativeTime,
};
