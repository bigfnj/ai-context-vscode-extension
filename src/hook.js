// AI Understanding pre-commit hook installer.
// Copies cli/aiu-precommit.js into the target repo's .git/hooks/ so the hook
// is self-contained per-repo and survives extension version bumps. The
// pre-commit shell wrapper just exec's node on the copied driver.
//
// Pure node — no vscode dependency.

const fs = require('fs');
const path = require('path');

const HOOK_FILENAME = 'pre-commit';
const DRIVER_FILENAME = 'aiu-precommit.js';
const HOOK_MARKER = '# AI Understanding pre-commit hook (managed by ai-context-runner)';
const BACKUP_SUFFIX = '.aiu-backup';

function gitDir(projectRoot) {
    return path.join(projectRoot, '.git');
}

function hooksDir(projectRoot) {
    return path.join(gitDir(projectRoot), 'hooks');
}

function hookPath(projectRoot) {
    return path.join(hooksDir(projectRoot), HOOK_FILENAME);
}

function driverPath(projectRoot) {
    return path.join(hooksDir(projectRoot), DRIVER_FILENAME);
}

function backupPath(projectRoot) {
    return hookPath(projectRoot) + BACKUP_SUFFIX;
}

function isGitRepo(projectRoot) {
    return fs.existsSync(gitDir(projectRoot));
}

function isHookInstalled(projectRoot) {
    const p = hookPath(projectRoot);
    if (!fs.existsSync(p)) return false;
    try { return fs.readFileSync(p, 'utf8').includes(HOOK_MARKER); }
    catch { return false; }
}

function buildHookBody(driverAbsolutePath) {
    const lines = [
        '#!/usr/bin/env bash',
        HOOK_MARKER,
        '# Spec: AI_UNDERSTANDING_FORMAT.md §9 (block-narrow mode).',
        '# Override: git commit --no-verify',
        '',
        `exec node ${JSON.stringify(driverAbsolutePath)} "$@"`,
        '',
    ];
    return lines.join('\n');
}

// Returns one of: 'installed', 'reinstalled'.
// Throws if projectRoot is not a git repo or hookSourcePath is missing.
function installHook(projectRoot, hookSourcePath) {
    if (!isGitRepo(projectRoot)) {
        throw new Error(`Not a git repository: ${projectRoot}`);
    }
    if (!fs.existsSync(hookSourcePath)) {
        throw new Error(`Hook driver source not found: ${hookSourcePath}`);
    }
    const dir = hooksDir(projectRoot);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const target = hookPath(projectRoot);
    const wasOurs = isHookInstalled(projectRoot);

    if (fs.existsSync(target) && !wasOurs) {
        fs.renameSync(target, backupPath(projectRoot));
    }

    const driver = driverPath(projectRoot);
    fs.copyFileSync(hookSourcePath, driver);
    try { fs.chmodSync(driver, 0o755); } catch { /* Windows */ }

    fs.writeFileSync(target, buildHookBody(driver));
    try { fs.chmodSync(target, 0o755); } catch { /* Windows */ }

    return wasOurs ? 'reinstalled' : 'installed';
}

// Returns one of: 'uninstalled', 'restored-backup', 'noop'.
function uninstallHook(projectRoot) {
    if (!isHookInstalled(projectRoot)) return 'noop';
    const target = hookPath(projectRoot);
    fs.unlinkSync(target);
    const driver = driverPath(projectRoot);
    if (fs.existsSync(driver)) fs.unlinkSync(driver);
    const backup = backupPath(projectRoot);
    if (fs.existsSync(backup)) {
        fs.renameSync(backup, target);
        return 'restored-backup';
    }
    return 'uninstalled';
}

module.exports = {
    HOOK_FILENAME,
    DRIVER_FILENAME,
    HOOK_MARKER,
    BACKUP_SUFFIX,
    isGitRepo,
    isHookInstalled,
    installHook,
    uninstallHook,
    hookPath,
    driverPath,
    backupPath,
    buildHookBody,
};
