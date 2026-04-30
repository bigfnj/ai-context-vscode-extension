const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureDir } = require('./context');

const INJECT_START = '<!-- AI_CTX_START -->';
const INJECT_END   = '<!-- AI_CTX_END -->';

// Maps agent ID → function(root) → array of file paths to inject into.
const AGENT_TARGETS = {
    claude:   root => [path.join(root, 'CLAUDE.md')],
    codex:    root => [path.join(root, 'AGENTS.md')],
    copilot:  root => [path.join(root, '.github', 'copilot-instructions.md')],
    cursor:   root => [path.join(root, '.cursorrules')],
    windsurf: root => [path.join(root, '.windsurfrules')],
    kilo:     root => [path.join(root, 'KILO.md')],
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
function getInjectionTargets(root) {
    const targets = [];
    for (const agent of getAgents()) {
        const fn = AGENT_TARGETS[agent];
        if (fn) targets.push(...fn(root));
    }
    return targets;
}

function buildInjectionBlock(ctx) {
    const s = typeof ctx.s === 'object' ? JSON.stringify(ctx.s) : (ctx.s || '{}');
    const a = Array.isArray(ctx.a) ? ctx.a.join(', ') : (ctx.a || '');
    return [
        '[Auto-injected by AI Context Runner — do not edit this block manually]',
        `Project : ${ctx.p    || ''}`,
        `Root    : ${ctx.root || ''}`,
        `Task    : ${ctx.t    || ''}`,
        `Intent  : ${ctx.i    || ''}`,
        `State   : ${s}`,
        `Actions : ${a}`,
        `Error   : ${ctx.e   || 'none'}`,
        '',
        'Resume this session from the above state. Do not ask for context — continue execution immediately.',
        `Raw context (machine-readable): ${JSON.stringify(ctx)}`,
    ].join('\n');
}

function injectIntoFile(filePath, blockContent) {
    ensureDir(path.dirname(filePath));
    let existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    const block  = `${INJECT_START}\n${blockContent}\n${INJECT_END}`;

    if (existing.includes(INJECT_START)) {
        const start = existing.indexOf(INJECT_START);
        const end   = existing.indexOf(INJECT_END, start) + INJECT_END.length;
        fs.writeFileSync(filePath, existing.slice(0, start) + block + existing.slice(end));
    } else {
        const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : '\n';
        fs.writeFileSync(filePath, existing + sep + block + '\n');
    }
}

function clearInjection(filePath) {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.includes(INJECT_START)) return;
    const start = content.indexOf(INJECT_START);
    const end   = content.indexOf(INJECT_END, start) + INJECT_END.length;
    fs.writeFileSync(
        filePath,
        (content.slice(0, start).trimEnd() + '\n' + content.slice(end)).trimStart()
    );
}

// Adds injection target filenames to .gitignore if not already present.
function updateGitignore(projectRoot, targetPaths) {
    const gitignorePath = path.join(projectRoot, '.gitignore');
    let content = fs.existsSync(gitignorePath)
        ? fs.readFileSync(gitignorePath, 'utf8')
        : '';

    const lines   = content.split('\n').map(l => l.trim());
    const toAdd   = [];

    for (const filePath of targetPaths) {
        // Store as path relative to project root
        const rel = path.relative(projectRoot, filePath).replace(/\\/g, '/');
        if (!lines.includes(rel)) toAdd.push(rel);
    }

    if (toAdd.length === 0) return;

    const sep = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(gitignorePath, content + sep + toAdd.join('\n') + '\n');
}

// Injects context into all configured agent files inside ctx.root.
// Falls back to home dir if ctx.root is not set.
// Optionally updates .gitignore if aiContext.autoGitignore is enabled.
function autoInject(ctx) {
    const root    = ctx.root && ctx.root.trim() ? ctx.root.trim() : os.homedir();
    const block   = buildInjectionBlock(ctx);
    const targets = getInjectionTargets(root);

    for (const filePath of targets) {
        injectIntoFile(filePath, block);
    }

    const config = vscode.workspace.getConfiguration('aiContext');
    if (config.get('autoGitignore')) {
        updateGitignore(root, targets);
    }
}

// Clears injection blocks from all configured agent files for a context.
function clearInjectionForContext(ctx) {
    const root    = ctx.root && ctx.root.trim() ? ctx.root.trim() : os.homedir();
    const targets = getInjectionTargets(root);
    for (const filePath of targets) {
        clearInjection(filePath);
    }
}

module.exports = {
    INJECT_START,
    INJECT_END,
    AGENT_TARGETS,
    getAgents,
    getInjectionTargets,
    buildInjectionBlock,
    injectIntoFile,
    clearInjection,
    updateGitignore,
    clearInjectionForContext,
    autoInject,
};
