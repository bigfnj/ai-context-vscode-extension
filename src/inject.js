const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { ensureDir, normalizePath, getCtxDir } = require('./context');

const INJECT_START = '<!-- AI_CTX_START -->';
const INJECT_END   = '<!-- AI_CTX_END -->';
const BOOTSTRAP_START = '<!-- AI_CTX_BOOTSTRAP_START -->';
const BOOTSTRAP_END   = '<!-- AI_CTX_BOOTSTRAP_END -->';
const AGENT_CONTEXT_NAME = 'AI_CONTEXT';
const CODEX_REPO_SCAN_MAX_DEPTH = 4;
const CODEX_REPO_SCAN_SKIP_DIRS = new Set([
    '.git',
    '.vs',
    '.vscode',
    'bin',
    'build',
    'coverage',
    'dist',
    'node_modules',
    'obj',
    'out',
    'packages',
]);

function uniquePaths(paths) {
    const seen = new Set();
    const result = [];
    for (const filePath of paths) {
        const normalized = normalizePath(filePath);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}

function isGitRepoRoot(dir) {
    try {
        return fs.existsSync(path.join(dir, '.git'));
    } catch {
        return false;
    }
}

function findGitRepoRoots(root, maxDepth = CODEX_REPO_SCAN_MAX_DEPTH) {
    const normalizedRoot = normalizePath(root);
    if (!normalizedRoot || !fs.existsSync(normalizedRoot)) return [];

    const repos = [];
    const walk = (dir, depth) => {
        if (isGitRepoRoot(dir)) {
            repos.push(dir);
        }
        if (depth >= maxDepth) return;

        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (CODEX_REPO_SCAN_SKIP_DIRS.has(entry.name)) continue;
            walk(path.join(dir, entry.name), depth + 1);
        }
    };

    walk(normalizedRoot, 0);
    return uniquePaths(repos);
}

function getCodexTargets(root) {
    return uniquePaths([
        path.join(root, 'AGENTS.md'),
        ...findGitRepoRoots(root).map(repoRoot => path.join(repoRoot, 'AGENTS.md')),
    ]);
}

// Maps agent ID → function(root) → array of file paths to inject into.
// NOTE: kilo reads AGENTS.md (same as codex) — getInjectionTargets deduplicates.
const AGENT_TARGETS = {
    claude:   root => [path.join(root, 'CLAUDE.md')],
    codex:    root => getCodexTargets(root),
    copilot:  root => [path.join(root, '.github', 'copilot-instructions.md')],
    cursor:   root => [path.join(root, '.cursorrules')],
    windsurf: root => [path.join(root, '.windsurfrules')],
    kilo:     root => getCodexTargets(root),  // Kilo reads AGENTS.md, same as codex
};

// Returns the configured list of agents. Defaults to ['claude','codex','copilot'].
function getAgents() {
    const config = vscode.workspace.getConfiguration('aiContext');
    const agents = config.get('agents');
    return Array.isArray(agents) && agents.length > 0
        ? agents
        : ['claude', 'codex', 'copilot'];
}

// Returns all injection target file paths for the given root + current agent config.
// Deduplicates across agents so enabling both 'codex' and 'kilo' only writes AGENTS.md once.
function getInjectionTargets(root) {
    const seen    = new Set();
    const targets = [];
    for (const agent of getAgents()) {
        const fn = AGENT_TARGETS[agent];
        if (!fn) continue;
        for (const filePath of fn(root)) {
            const norm = normalizePath(filePath);
            if (norm && !seen.has(norm)) {
                seen.add(norm);
                targets.push(filePath);
            }
        }
    }
    return targets;
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function buildAgentContext(ctx) {
    return {
        v:    ctx.v || 3,
        p:    ctx.p || '',
        root: ctx.root || '',
        t:    ctx.t || '',
        i:    ctx.i || '',
        n:    ctx.n || '',
        s:    asObject(ctx.s),
        b:    asArray(ctx.b),
        d:    asArray(ctx.d),
        c:    asArray(ctx.c),
        f:    asArray(ctx.f),
        h:    asArray(ctx.h),
        a:    asArray(ctx.a),
        e:    ctx.e === undefined ? null : ctx.e,
    };
}

function buildInjectionBlock(ctx, storePath) {
    const projected = buildAgentContext(ctx);
    const lines = [
        `${AGENT_CONTEXT_NAME}=${JSON.stringify(projected)}`,
        `Use ${AGENT_CONTEXT_NAME} as authoritative session state. Continue from n; preserve b/d/c/f/h; append only meaningful recent work to a; update context through CTX_UPDATE when supported.`,
    ];
    if (storePath) {
        lines.push(`After each response, write a single line \`CTX_UPDATE:{"v":3,"p":"...","root":"...","t":"...","i":"...","n":"...","s":{},"b":[],"d":[],"c":[],"f":[],"h":[],"a":[],"e":null}\` to ${storePath}.update — the VS Code extension reads, merges, and deletes it to persist state after every turn.`);
    }
    return lines.join('\n');
}

function findMarkedRange(content, startMarker, endMarker) {
    const start = content.indexOf(startMarker);
    if (start === -1) return null;
    const endStart = content.indexOf(endMarker, start);
    const end      = endStart === -1 ? content.length : endStart + endMarker.length;
    return { start, end };
}

function findInjectionRange(content) {
    return findMarkedRange(content, INJECT_START, INJECT_END);
}

function injectMarkedBlock(filePath, blockContent, startMarker, endMarker) {
    ensureDir(path.dirname(filePath));
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    const block  = `${startMarker}\n${blockContent}\n${endMarker}`;
    const range  = findMarkedRange(existing, startMarker, endMarker);

    if (range) {
        fs.writeFileSync(filePath, existing.slice(0, range.start) + block + existing.slice(range.end));
    } else {
        const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : '\n';
        fs.writeFileSync(filePath, existing + sep + block + '\n');
    }
}

function injectIntoFile(filePath, blockContent) {
    injectMarkedBlock(filePath, blockContent, INJECT_START, INJECT_END);
}

function clearMarkedBlock(filePath, startMarker, endMarker) {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf8');
    const range   = findMarkedRange(content, startMarker, endMarker);
    if (!range) return;

    const before = content.slice(0, range.start).trimEnd();
    const after  = content.slice(range.end).trimStart();
    const next   = [before, after].filter(Boolean).join('\n\n');
    fs.writeFileSync(filePath, next ? `${next}\n` : '');
}

function clearInjection(filePath) {
    clearMarkedBlock(filePath, INJECT_START, INJECT_END);
}

function buildCodexBootstrapBlock(projectsRoot) {
    const root   = normalizePath(projectsRoot || '');
    const cwdFile = path.join(getCtxDir(), '.cwd');
    return [
        '# AI Context Project Switch Bootstrap',
        '',
        `Projects root: ${root || '(not configured)'}`,
        '',
        'When the user asks to move, cd, switch, open, or start work in a project under this root:',
        '1. Resolve the target project directory.',
        '2. Immediately read the nearest AGENTS.md from that target directory before answering or doing project work.',
        `3. If AGENTS.md contains ${AGENT_CONTEXT_NAME}, treat it as the authoritative session state.`,
        '4. If the target is inside a nested Git repository, prefer the nearest AGENTS.md in that repository.',
        `5. After switching, run this shell command so the VS Code AI Context extension auto-updates: echo "$PWD" > ${cwdFile}`,
        '',
        'A shell cd, tool workdir change, or VS Code terminal cwd change does not reload an already-running Codex conversation automatically.',
        'The target project AGENTS.md is the handoff source after a project switch.',
    ].join('\n');
}

function getCodexBootstrapTarget(projectsRoot) {
    const root = normalizePath(projectsRoot || '');
    return root ? path.join(root, 'AGENTS.md') : null;
}

function autoInjectCodexBootstrap(projectsRoot) {
    const target = getCodexBootstrapTarget(projectsRoot);
    if (!target) return false;
    try {
        const root = path.dirname(target);
        if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return false;
        injectMarkedBlock(target, buildCodexBootstrapBlock(projectsRoot), BOOTSTRAP_START, BOOTSTRAP_END);
        return true;
    } catch {
        return false;
    }
}

function clearCodexBootstrap(projectsRoot) {
    const target = getCodexBootstrapTarget(projectsRoot);
    if (!target) return false;
    clearMarkedBlock(target, BOOTSTRAP_START, BOOTSTRAP_END);
    return true;
}

function getGitignoreRoot(projectRoot, filePath) {
    const boundary = path.resolve(normalizePath(projectRoot));
    let dir = path.resolve(path.dirname(filePath));

    while (dir === boundary || dir.startsWith(boundary + path.sep)) {
        if (isGitRepoRoot(dir)) return dir;
        if (dir === boundary) break;
        dir = path.dirname(dir);
    }

    return boundary;
}

function updateGitignoreFile(gitignoreRoot, targetPaths) {
    const gitignorePath = path.join(gitignoreRoot, '.gitignore');
    let content = fs.existsSync(gitignorePath)
        ? fs.readFileSync(gitignorePath, 'utf8')
        : '';

    const lines = content.split('\n').map(l => l.trim());
    const toAdd = [];

    for (const filePath of targetPaths) {
        const rel = path.relative(gitignoreRoot, filePath).replace(/\\/g, '/');
        if (!lines.includes(rel)) toAdd.push(rel);
    }

    if (toAdd.length === 0) return;

    const sep = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(gitignorePath, content + sep + toAdd.join('\n') + '\n');
}

// Adds injection target filenames to .gitignore if not already present.
function updateGitignore(projectRoot, targetPaths) {
    const grouped = new Map();

    for (const filePath of targetPaths) {
        const gitignoreRoot = getGitignoreRoot(projectRoot, filePath);
        const paths = grouped.get(gitignoreRoot) || [];
        paths.push(filePath);
        grouped.set(gitignoreRoot, paths);
    }

    for (const [gitignoreRoot, paths] of grouped) {
        updateGitignoreFile(gitignoreRoot, paths);
    }
}

function getValidContextRoot(ctx) {
    const root = ctx.root && ctx.root.trim() ? normalizePath(ctx.root) : '';
    if (!root) return null;
    try {
        return fs.existsSync(root) && fs.statSync(root).isDirectory() ? root : null;
    } catch {
        return null;
    }
}

// Injects context into all configured agent files inside ctx.root.
// Optionally updates .gitignore if aiContext.autoGitignore is enabled.
function autoInject(ctx) {
    const root    = getValidContextRoot(ctx);
    if (!root) return false;

    const storePath = ctx.p ? path.join(getCtxDir(), `${ctx.p}.json`) : null;
    const block   = buildInjectionBlock(ctx, storePath);
    const targets = getInjectionTargets(root);

    for (const filePath of targets) {
        injectIntoFile(filePath, block);
    }

    const config = vscode.workspace.getConfiguration('aiContext');
    if (config.get('autoGitignore')) {
        updateGitignore(root, targets);
    }
    return true;
}

// Clears injection blocks from all configured agent files for a context.
function clearInjectionForContext(ctx) {
    const root    = getValidContextRoot(ctx);
    if (!root) return false;

    const targets = getInjectionTargets(root);
    for (const filePath of targets) {
        clearInjection(filePath);
    }
    return true;
}

module.exports = {
    INJECT_START,
    INJECT_END,
    BOOTSTRAP_START,
    BOOTSTRAP_END,
    AGENT_CONTEXT_NAME,
    AGENT_TARGETS,
    getAgents,
    getInjectionTargets,
    findGitRepoRoots,
    getCodexTargets,
    buildAgentContext,
    buildInjectionBlock,
    buildCodexBootstrapBlock,
    findInjectionRange,
    getGitignoreRoot,
    getValidContextRoot,
    injectIntoFile,
    clearInjection,
    getCodexBootstrapTarget,
    autoInjectCodexBootstrap,
    clearCodexBootstrap,
    updateGitignore,
    clearInjectionForContext,
    autoInject,
};
