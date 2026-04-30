const fs = require('fs');
const path = require('path');
const os = require('os');

function readClaudeSettings() {
    try {
        const filePath = path.join(os.homedir(), '.claude', 'settings.json');
        if (!fs.existsSync(filePath)) return {};
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
    } catch {
        return {};
    }
}

function writeClaudeSettings(settings) {
    try {
        const filePath = path.join(os.homedir(), '.claude', 'settings.json');
        const content = JSON.stringify(settings, null, 2);
        fs.writeFileSync(filePath, content, 'utf-8');
    } catch (err) {
        console.error('Failed to write Claude settings:', err.message);
    }
}

function readCodexConfig() {
    try {
        const filePath = path.join(os.homedir(), '.codex', 'config.toml');
        if (!fs.existsSync(filePath)) return '';
        return fs.readFileSync(filePath, 'utf-8');
    } catch {
        return '';
    }
}

function writeCodexConfig(content) {
    try {
        const filePath = path.join(os.homedir(), '.codex', 'config.toml');
        fs.writeFileSync(filePath, content, 'utf-8');
    } catch (err) {
        console.error('Failed to write Codex config:', err.message);
    }
}

function tokenizeCommand(cmdStr) {
    const tokens = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let i = 0;

    while (i < cmdStr.length) {
        const ch = cmdStr[i];

        if (ch === '\\' && i + 1 < cmdStr.length) {
            current += cmdStr[i] + cmdStr[i + 1];
            i += 2;
            continue;
        }

        if (ch === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
            current += ch;
            i++;
            continue;
        }

        if (ch === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
            current += ch;
            i++;
            continue;
        }

        if ((ch === ' ' || ch === '\t') && !inSingleQuote && !inDoubleQuote) {
            if (current.trim()) tokens.push(current.trim());
            current = '';
            i++;
            continue;
        }

        current += ch;
        i++;
    }

    if (current.trim()) tokens.push(current.trim());
    return tokens;
}

function generalizePath(pathStr, projectRoot) {
    if (!pathStr || !projectRoot) return '*';

    const normalized = pathStr.replace(/\/$/, '');
    const projNorm = projectRoot.replace(/\/$/, '');

    if (normalized.startsWith(projNorm)) {
        const base = projNorm.split('/').slice(0, -1).join('/');
        return base + '/**';
    }

    const homeDir = os.homedir();
    if (normalized.startsWith(homeDir)) {
        const parts = normalized.split('/');
        if (parts.length > 4) {
            const base = parts.slice(0, 3).join('/');
            return base + '/**';
        }
    }

    return '*';
}

function isPathLike(token) {
    return token.startsWith('/') || token.includes('/') || token.startsWith('~');
}

function isFlag(token) {
    return token.startsWith('-') && token.length > 1 && token[1] !== '/';
}

function isSubcommandLike(token) {
    return /^[a-zA-Z0-9._\-]+$/.test(token) && !token.startsWith('-') && !token.startsWith('/');
}

function generalizeClaudePerm(rawPerm, projectRoot) {
    if (!rawPerm || typeof rawPerm !== 'string') return '';

    const parenMatch = rawPerm.match(/^(\w+)\((.*)\)$/);
    if (!parenMatch) {
        return rawPerm.trim();
    }

    const [, tool, cmdStr] = parenMatch;

    const tokens = tokenizeCommand(cmdStr);
    if (tokens.length === 0) return `${tool}(*)`;

    const rebuilt = [];
    let lastWasFlag = false;

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        if (isFlag(token)) {
            rebuilt.push(token);
            lastWasFlag = true;
            continue;
        }

        if (lastWasFlag) {
            rebuilt.push('*');
            return `${tool}(${rebuilt.join(' ')})`;
        }

        if (isSubcommandLike(token)) {
            rebuilt.push(token);
            continue;
        }

        rebuilt.push('*');
        return `${tool}(${rebuilt.join(' ')})`;
    }

    if (rebuilt.length === 0 || !rebuilt[rebuilt.length - 1].endsWith('*')) {
        rebuilt.push('*');
    }

    const pattern = rebuilt.join(' ');
    return `${tool}(${pattern})`;
}

function isClaudePermCovered(candidate, existingPerms) {
    if (!candidate || !Array.isArray(existingPerms)) return false;

    for (const existing of existingPerms) {
        if (existing === candidate) return true;
    }

    // Extract inner command from "Tool(command)" format
    const candidateMatch = candidate.match(/^(\w+)\((.*)\)$/);
    if (!candidateMatch) return false;
    const [, candTool, candCmd] = candidateMatch;

    for (const existing of existingPerms) {
        const existingMatch = existing.match(/^(\w+)\((.*)\)$/);
        if (!existingMatch) continue;
        const [, exTool, exCmd] = existingMatch;

        if (candTool !== exTool) continue;

        if (exCmd.endsWith('*')) {
            const exPrefix = exCmd.slice(0, -1).trim();
            const candTrimmed = candCmd.trim();
            if (exPrefix === '' || candTrimmed.startsWith(exPrefix)) return true;
        }
    }

    return false;
}

function captureNewClaudePerms(beforeAllow, afterAllow, projectRoot, existingPerms = []) {
    if (!Array.isArray(beforeAllow) || !Array.isArray(afterAllow)) return [];

    const beforeSet = new Set(beforeAllow);
    const newRaw = afterAllow.filter(p => !beforeSet.has(p));

    const result = [];
    for (const raw of newRaw) {
        const generalized = generalizeClaudePerm(raw, projectRoot);
        if (!isClaudePermCovered(generalized, [...existingPerms, ...result])) {
            result.push(generalized);
        }
    }

    return result;
}

function applyClaudePerms(storedPerms) {
    if (!Array.isArray(storedPerms) || storedPerms.length === 0) return;

    const settings = readClaudeSettings();

    if (!settings.permissions) settings.permissions = {};
    if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];

    const existing = settings.permissions.allow;
    for (const perm of storedPerms) {
        if (!isClaudePermCovered(perm, existing)) {
            existing.push(perm);
        }
    }

    writeClaudeSettings(settings);
}

function updateCodexTomlContent(content, root, trustLevel) {
    if (!root || !trustLevel) return content;

    const lines = content.split('\n');
    const sectionHeader = `[projects."${root}"]`;
    let sectionFound = false;
    let sectionStartIdx = -1;
    let sectionEndIdx = -1;

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === sectionHeader) {
            sectionFound = true;
            sectionStartIdx = i;

            for (let j = i + 1; j < lines.length; j++) {
                if (lines[j].trim().startsWith('[')) {
                    sectionEndIdx = j;
                    break;
                }
            }
            if (sectionEndIdx === -1) sectionEndIdx = lines.length;
            break;
        }
    }

    if (sectionFound) {
        let trustFound = false;
        for (let i = sectionStartIdx + 1; i < sectionEndIdx; i++) {
            if (lines[i].trim().startsWith('trust_level')) {
                lines[i] = `trust_level = "${trustLevel}"`;
                trustFound = true;
                break;
            }
        }
        if (!trustFound) {
            lines.splice(sectionStartIdx + 1, 0, `trust_level = "${trustLevel}"`);
        }
    } else {
        lines.push(`[projects."${root}"]`);
        lines.push(`trust_level = "${trustLevel}"`);
    }

    return lines.join('\n');
}

function applyCodexTrust(root, trustLevel) {
    if (!root || !trustLevel) return;

    const content = readCodexConfig();
    const updated = updateCodexTomlContent(content, root, trustLevel);
    writeCodexConfig(updated);
}

function consolidatePermissionsToGlobal(contexts, loadContext, saveContext) {
    if (!Array.isArray(contexts) || contexts.length === 0) return { consolidated: [], count: 0 };

    const patternFreq = {};
    const patternToProjects = {};

    for (const ctxName of contexts) {
        try {
            const ctx = loadContext(ctxName);
            const claudePerms = (ctx.perms && ctx.perms.claude) ? ctx.perms.claude : [];

            for (const perm of claudePerms) {
                if (!patternFreq[perm]) {
                    patternFreq[perm] = 0;
                    patternToProjects[perm] = [];
                }
                patternFreq[perm]++;
                patternToProjects[perm].push(ctxName);
            }
        } catch {
            // Skip invalid contexts
        }
    }

    const toPromote = Object.entries(patternFreq)
        .filter(([, freq]) => freq >= 2)
        .map(([perm]) => perm);

    if (toPromote.length === 0) return { consolidated: [], count: 0 };

    applyClaudePerms(toPromote);

    for (const ctxName of contexts) {
        try {
            const ctx = loadContext(ctxName);
            const claudePerms = (ctx.perms && ctx.perms.claude) ? ctx.perms.claude : [];
            const filtered = claudePerms.filter(p => !toPromote.includes(p));

            if (filtered.length !== claudePerms.length) {
                saveContext(ctxName, { ...ctx, perms: { ...ctx.perms, claude: filtered } });
            }
        } catch {
            // Skip invalid contexts
        }
    }

    return { consolidated: toPromote, count: toPromote.length };
}

module.exports = {
    readClaudeSettings,
    writeClaudeSettings,
    readCodexConfig,
    writeCodexConfig,
    generalizeClaudePerm,
    isClaudePermCovered,
    captureNewClaudePerms,
    applyClaudePerms,
    updateCodexTomlContent,
    applyCodexTrust,
    consolidatePermissionsToGlobal,
    __test: {
        generalizeClaudePerm,
        isClaudePermCovered,
        captureNewClaudePerms,
        updateCodexTomlContent,
        tokenizeCommand,
        generalizePath,
    },
};
