const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureDir } = require('./context');

const INJECT_START = '<!-- AI_CTX_START -->';
const INJECT_END   = '<!-- AI_CTX_END -->';

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
    const block = `${INJECT_START}\n${blockContent}\n${INJECT_END}`;

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

// Injects into the project folder named in ctx.root.
// Falls back to home dir if ctx.root is not set (legacy / unbound contexts).
function autoInject(ctx) {
    const root = ctx.root && ctx.root.trim() ? ctx.root.trim() : os.homedir();
    injectIntoFile(path.join(root, 'CLAUDE.md'), buildInjectionBlock(ctx));
    injectIntoFile(path.join(root, '.github', 'copilot-instructions.md'), buildInjectionBlock(ctx));
}

// Clears injection blocks from a specific project root.
function clearInjectionForContext(ctx) {
    const root = ctx.root && ctx.root.trim() ? ctx.root.trim() : os.homedir();
    clearInjection(path.join(root, 'CLAUDE.md'));
    clearInjection(path.join(root, '.github', 'copilot-instructions.md'));
}

module.exports = {
    INJECT_START,
    INJECT_END,
    buildInjectionBlock,
    injectIntoFile,
    clearInjection,
    clearInjectionForContext,
    autoInject,
};
