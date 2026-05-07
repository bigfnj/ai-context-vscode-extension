#!/usr/bin/env node
// AI Understanding pre-commit hook (block-narrow mode).
// Spec: AI_UNDERSTANDING_FORMAT.md §9.
//
// Self-contained — no dependencies beyond Node builtins. Installed by the
// AI Context Runner extension to .git/hooks/aiu-precommit.js, called via
// .git/hooks/pre-commit. Override on a per-commit basis: git commit --no-verify

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function gitTopLevel() {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

function gitListStaged(filter) {
    let out;
    try {
        out = execFileSync(
            'git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=' + filter],
            { encoding: 'utf8' }
        );
    } catch { return []; }
    return out.split('\0').filter(Boolean);
}

function gitStagedContent(p) {
    return execFileSync('git', ['show', ':' + p]);
}

function gitStagedExists(p) {
    try {
        execFileSync('git', ['cat-file', '-e', ':' + p], { stdio: 'ignore' });
        return true;
    } catch { return false; }
}

function sha1(buf) {
    return crypto.createHash('sha1').update(buf).digest('hex');
}

// Glob → regex. Mirrors src/understanding.js#globToRegex. Intentional duplication:
// the hook is a standalone artifact and must not require the extension.
function escapeRegex(s) { return s.replace(/[.+^$()|\\[\]]/g, '\\$&'); }
function globToRegex(glob) {
    let re = '^';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                if (glob[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 2; }
                else { re += '.*'; i += 1; }
            } else { re += '[^/]*'; }
        } else if (c === '?') { re += '[^/]'; }
        else if (c === '{') {
            const end = glob.indexOf('}', i);
            if (end === -1) { re += '\\{'; continue; }
            const opts = glob.slice(i + 1, end).split(',').map(escapeRegex);
            re += '(?:' + opts.join('|') + ')';
            i = end;
        } else { re += escapeRegex(c); }
    }
    return new RegExp(re + '$');
}
function matchesAny(p, globs) {
    if (!Array.isArray(globs)) return false;
    for (const g of globs) if (globToRegex(g).test(p)) return true;
    return false;
}

function main() {
    const root = gitTopLevel();
    const metaPath = path.join(root, 'AI_UNDERSTANDING', '_meta.json');
    if (!fs.existsSync(metaPath)) {
        // No AI Understanding contract for this repo — hook is a no-op.
        process.exit(0);
    }

    let meta;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); }
    catch (err) {
        console.error('AI Understanding pre-commit: cannot parse _meta.json:', err.message);
        process.exit(1);
    }
    const include = (meta.tracked_globs && meta.tracked_globs.include) || [];
    const exclude = (meta.tracked_globs && meta.tracked_globs.exclude) || [];

    const failures = [];

    // Rule 1 — source files added/modified must have a matching .aiu.json in
    // the staged tree, and the entry's sha1 must equal sha1 of the staged source.
    const sourceStaged = gitListStaged('AM');
    for (const p of sourceStaged) {
        if (p.startsWith('AI_UNDERSTANDING/')) continue; // sidecar, handled below
        if (matchesAny(p, exclude)) continue;
        if (!matchesAny(p, include)) continue;

        const sidecar = 'AI_UNDERSTANDING/' + p + '.aiu.json';
        if (!gitStagedExists(sidecar)) {
            failures.push(`  ${p} — missing sidecar ${sidecar}`);
            continue;
        }

        let entry;
        try { entry = JSON.parse(gitStagedContent(sidecar).toString('utf8')); }
        catch (err) {
            failures.push(`  ${sidecar} — invalid JSON: ${err.message}`);
            continue;
        }

        const sourceSha = sha1(gitStagedContent(p));
        if (entry.sha1 !== sourceSha) {
            failures.push(`  ${p} — sidecar sha1 ${entry.sha1} ≠ staged source sha1 ${sourceSha}`);
        }
    }

    // Rule 2 — if a .aiu.json is staged for deletion, the matching source
    // must also be staged for deletion in the same commit.
    const deleted = new Set(gitListStaged('D'));
    for (const p of deleted) {
        if (!p.startsWith('AI_UNDERSTANDING/')) continue;
        if (!p.endsWith('.aiu.json')) continue;
        const source = p.slice('AI_UNDERSTANDING/'.length, -'.aiu.json'.length);
        if (!deleted.has(source)) {
            failures.push(`  ${p} — staged for deletion but source ${source} is not`);
        }
    }

    if (failures.length === 0) process.exit(0);

    console.error('AI Understanding pre-commit: blocking commit (block-narrow mode).');
    console.error('');
    for (const f of failures) console.error(f);
    console.error('');
    console.error('Fix:');
    console.error('  - Sidecar sha1 mismatch: refresh AI_UNDERSTANDING/<path>.aiu.json so its');
    console.error('    sha1 matches the staged source content (recompute + update');
    console.error('    exports/imports/invariants if relevant), then `git add` it.');
    console.error('  - Missing sidecar: create the entry (run "AI Understanding: Initialize"');
    console.error('    if the project is unbootstrapped), then `git add` it.');
    console.error('  - Orphan deletion: also `git rm` the source file in this commit.');
    console.error('');
    console.error('Override (single commit): git commit --no-verify');
    process.exit(1);
}

try { main(); }
catch (err) {
    console.error('AI Understanding pre-commit: unexpected error:', err.message);
    process.exit(1);
}
