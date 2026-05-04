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

function captureNewClaudePerms(beforeAllow, afterAllow, projectRoot, existingPerms = [], preventRemovalCapture = false) {
    if (!Array.isArray(beforeAllow) || !Array.isArray(afterAllow)) return [];

    const beforeSet = new Set(beforeAllow);
    let newRaw = afterAllow.filter(p => !beforeSet.has(p));

    if (preventRemovalCapture) {
        newRaw = newRaw.filter(perm => {
            const m = perm.match(/^(\w+)\((.*)\)$/);
            if (!m) return true;
            const [, tool, cmd] = m;
            if (tool.toLowerCase() === 'bash' && isRemovalCommand(cmd)) return false;
            return true;
        });
    }

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

function extractCodexTrust(content, root) {
    if (!root || !content) return null;
    const lines = content.split('\n');
    const sectionHeader = `[projects."${root}"]`;
    let inSection = false;
    for (const line of lines) {
        if (line.trim() === sectionHeader) { inSection = true; continue; }
        if (inSection) {
            if (line.trim().startsWith('[')) break;
            const m = line.trim().match(/^trust_level\s*=\s*"(.+)"$/);
            if (m) return m[1];
        }
    }
    return null;
}

function applyCodexTrust(root, trustLevel) {
    if (!root || !trustLevel) return;

    const content = readCodexConfig();
    const updated = updateCodexTomlContent(content, root, trustLevel);
    writeCodexConfig(updated);
}

// ── Codex full-auto mode ──────────────────────────────────────────────────────

const BASHRC_FULL_AUTO_MARKER = '# AI Context — Codex full-auto';
const BASHRC_FULL_AUTO_END    = '# /AI Context — Codex full-auto';
const BASHRC_FULL_AUTO_ALIAS  = "alias codex='codex --approval-mode full-auto'";

function globalRegion(lines) {
    const idx = lines.findIndex(l => l.trim().startsWith('['));
    return idx === -1 ? lines.length : idx;
}

function setCodexGlobalApprovalPolicy(enabled) {
    let content = readCodexConfig();
    const lines = content ? content.split('\n') : [];
    let firstSection = globalRegion(lines);

    // Find any top-level scalar approval_policy = "..." and sandbox_mode keys
    let policyIdx  = -1;
    let sandboxIdx = -1;
    for (let i = 0; i < firstSection; i++) {
        if (lines[i].trim().startsWith('approval_policy')) policyIdx  = i;
        if (lines[i].trim().startsWith('sandbox_mode'))    sandboxIdx = i;
    }

    if (enabled) {
        // Remove scalar approval_policy key — [approval_policy.granular] section takes over
        if (policyIdx !== -1) {
            lines.splice(policyIdx, 1);
            firstSection--;
            if (sandboxIdx > policyIdx) sandboxIdx--;
        }
        // Ensure sandbox_mode is present
        if (sandboxIdx !== -1) {
            lines[sandboxIdx] = 'sandbox_mode = "danger-full-access"';
        } else {
            lines.splice(firstSection, 0, 'sandbox_mode = "danger-full-access"');
        }
        writeCodexConfig(updateCodexGranularConfig(lines.join('\n'), {
            sandbox_approval: false,
            rules:            false,
            mcp_elicitations: false,
        }));
    } else {
        // Remove scalar keys and the [approval_policy.granular] section
        [policyIdx, sandboxIdx]
            .filter(i => i !== -1)
            .sort((a, b) => b - a)
            .forEach(i => lines.splice(i, 1));
        writeCodexConfig(removeCodexGranularSection(lines.join('\n')));
    }
}

function updateCodexGranularConfig(content, config) {
    const lines  = content ? content.split('\n') : [];
    const header = '[approval_policy.granular]';

    let sectionIdx = -1;
    let sectionEnd = lines.length;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === header) {
            sectionIdx = i;
            for (let j = i + 1; j < lines.length; j++) {
                if (lines[j].trim().startsWith('[')) { sectionEnd = j; break; }
            }
            break;
        }
    }

    const configLines = Object.entries(config).map(([k, v]) => `${k} = ${v}`);

    if (sectionIdx !== -1) {
        lines.splice(sectionIdx + 1, sectionEnd - sectionIdx - 1, ...configLines);
    } else {
        const firstProject = lines.findIndex(l => l.trim().startsWith('[projects.'));
        const insertAt = firstProject !== -1 ? firstProject : lines.length;
        lines.splice(insertAt, 0, '', header, ...configLines, '');
    }

    return lines.join('\n');
}

function removeCodexGranularSection(content) {
    const lines  = content ? content.split('\n') : [];
    const header = '[approval_policy.granular]';

    let sectionIdx = -1;
    let sectionEnd = lines.length;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === header) {
            sectionIdx = i;
            for (let j = i + 1; j < lines.length; j++) {
                if (lines[j].trim().startsWith('[')) { sectionEnd = j; break; }
            }
            break;
        }
    }

    if (sectionIdx === -1) return content;

    // Also remove the blank line preceding the section header if present
    const removeFrom = (sectionIdx > 0 && lines[sectionIdx - 1].trim() === '')
        ? sectionIdx - 1
        : sectionIdx;
    lines.splice(removeFrom, sectionEnd - removeFrom);
    return lines.join('\n');
}

// ── Removal command detection ─────────────────────────────────────────────────

const REMOVAL_PATTERNS = [
    /^(rm|rmdir|del|erase|remove|wipe|unlink|uninstall|purge)$/i,
    /^rm\s/i,
    /^rmdir\s/i,
    /^del\s/i,
    /^erase\s/i,
];

function isRemovalCommand(cmdStr) {
    if (!cmdStr || typeof cmdStr !== 'string') return false;
    const trimmed = cmdStr.trim();
    for (const pattern of REMOVAL_PATTERNS) {
        if (pattern.test(trimmed)) return true;
    }
    return false;
}

function filterRemovalCommands(commands) {
    if (!Array.isArray(commands)) return [];
    return commands.filter(cmd => !isRemovalCommand(cmd));
}

function hasRemovalCommands(claudePerms) {
    if (!Array.isArray(claudePerms)) return false;
    for (const perm of claudePerms) {
        const m = perm.match(/^(\w+)\((.*)\)$/);
        if (!m) continue;
        const [, tool, cmd] = m;
        if (tool.toLowerCase() === 'bash' && isRemovalCommand(cmd)) return true;
    }
    return false;
}

function purgeRemovalCommandsFromAllow(allowList) {
    if (!Array.isArray(allowList)) return [];
    return allowList.filter(perm => {
        const m = perm.match(/^(\w+)\((.*)\)$/);
        if (!m) return true;
        const [, tool, cmd] = m;
        if (tool.toLowerCase() === 'bash' && isRemovalCommand(cmd)) return false;
        return true;
    });
}

// ── Codex safeCommands ────────────────────────────────────────────────────────

function extractCodexSafeCommands(content) {
    if (!content) return [];
    const lines = content.split('\n');
    for (const line of lines) {
        if (line.trim().startsWith('[')) break;
        const m = line.match(/^safeCommands\s*=\s*\[([^\]]*)\]/);
        if (m) {
            return m[1].split(',')
                .map(s => s.trim().replace(/^["']|["']$/g, ''))
                .filter(Boolean);
        }
    }
    return [];
}

function setCodexSafeCommands(commands) {
    const content = readCodexConfig();
    const lines   = content ? content.split('\n') : [];
    let firstSection = globalRegion(lines);

    let existingIdx = -1;
    for (let i = 0; i < firstSection; i++) {
        if (lines[i].trim().startsWith('safeCommands')) { existingIdx = i; break; }
    }

    const value = `safeCommands = [${commands.map(c => `"${c.replace(/"/g, '\\"')}"`).join(', ')}]`;
    if (existingIdx !== -1) {
        lines[existingIdx] = value;
    } else {
        lines.splice(firstSection, 0, value);
    }
    writeCodexConfig(lines.join('\n'));
}

function applyCodexSafeCommands(storedCommands) {
    if (!Array.isArray(storedCommands) || storedCommands.length === 0) return;
    const existing = extractCodexSafeCommands(readCodexConfig());
    const merged   = [...new Set([...existing, ...storedCommands])];
    if (merged.length !== existing.length) setCodexSafeCommands(merged);
}

// Derives Codex safeCommand prefixes from a Claude-style allow list.
// Bash(git *) → "git",  Bash(du -sh) → "du -sh",  Bash(*) → skipped.
function deriveSafeCommandsFromAllow(allowList) {
    if (!Array.isArray(allowList)) return [];
    const results = [];
    for (const perm of allowList) {
        const m = perm.match(/^Bash\((.+)\)$/);
        if (!m) continue;
        const cmd = m[1].replace(/\s*\*$/, '').trim();
        if (cmd) results.push(cmd);
    }
    return [...new Set(results)];
}

function setCodexBashAlias(enabled) {
    const bashrcPath = path.join(os.homedir(), '.bashrc');
    let content = '';
    try { content = fs.readFileSync(bashrcPath, 'utf-8'); } catch { return; }

    const hasBlock = content.includes(BASHRC_FULL_AUTO_MARKER);

    if (enabled && !hasBlock) {
        const block = `\n${BASHRC_FULL_AUTO_MARKER}\n${BASHRC_FULL_AUTO_ALIAS}\n${BASHRC_FULL_AUTO_END}`;
        fs.writeFileSync(bashrcPath, content + block, 'utf-8');
    } else if (!enabled && hasBlock) {
        const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re  = new RegExp(
            `\\n?${esc(BASHRC_FULL_AUTO_MARKER)}\\n.*\\n${esc(BASHRC_FULL_AUTO_END)}`,
            'g'
        );
        fs.writeFileSync(bashrcPath, content.replace(re, ''), 'utf-8');
    }
}

// Verify-and-revert toggle for project-local Codex sandbox mode.
// Returns { ok: true } on success, or { ok: false, error: string } on failure.
// On verification failure the prior file content is restored so the toggle
// reflects on-disk reality.
function applyCodexSandboxMode(projectRoot, enabled) {
    if (!projectRoot) return { ok: false, error: 'no projectRoot provided' };
    const configDir  = path.join(projectRoot, '.codex');
    const configPath = path.join(configDir, 'config.toml');
    const fileExistedBefore = fs.existsSync(configPath);

    if (!fs.existsSync(configDir)) {
        if (!enabled) return { ok: true };
        try {
            fs.mkdirSync(configDir, { recursive: true });
        } catch (err) {
            return { ok: false, error: `cannot create .codex/: ${err.message}` };
        }
    }

    const priorContent = fileExistedBefore ? fs.readFileSync(configPath, 'utf-8') : '';
    const lines   = priorContent.split('\n');
    const keyLine = /^sandbox_mode\s*=/;
    const idx     = lines.findIndex(l => keyLine.test(l));

    let updated;
    if (enabled) {
        const newLine = 'sandbox_mode = "danger-full-access"';
        updated = idx >= 0
            ? [...lines.slice(0, idx), newLine, ...lines.slice(idx + 1)]
            : [newLine, ...lines];
    } else {
        updated = idx >= 0
            ? lines.filter((_, i) => i !== idx)
            : lines;
    }

    const newContent = updated.join('\n');
    try {
        fs.writeFileSync(configPath, newContent, 'utf-8');
    } catch (err) {
        return { ok: false, error: `cannot write config: ${err.message}` };
    }

    // Verify by reading the file back and re-checking the sandbox_mode line.
    const revert = () => {
        try {
            if (!fileExistedBefore) fs.unlinkSync(configPath);
            else fs.writeFileSync(configPath, priorContent, 'utf-8');
        } catch { /* best effort */ }
    };

    let readBack;
    try {
        readBack = fs.readFileSync(configPath, 'utf-8');
    } catch (err) {
        revert();
        return { ok: false, error: `cannot read config back: ${err.message}` };
    }

    const readBackHasFullAccess = readBack
        .split('\n')
        .some(l => keyLine.test(l) && l.includes('"danger-full-access"'));

    if (enabled && !readBackHasFullAccess) {
        revert();
        return { ok: false, error: 'wrote config but sandbox_mode line not present after readback' };
    }
    if (!enabled && readBackHasFullAccess) {
        revert();
        return { ok: false, error: 'sandbox_mode line still present after disable' };
    }

    return { ok: true };
}

// ── Codex rules file (~/.codex/rules/default.rules) ──────────────────────────
// Codex persists "always allow" approvals here as Starlark-format
// prefix_rule(pattern=[...], decision="allow") entries. We read this so the
// extension can capture new persistent approvals into the active context's
// allow-list (paralleling how ~/.claude/settings.json is watched).

function readCodexRulesFile() {
    try {
        const rulesPath = path.join(os.homedir(), '.codex', 'rules', 'default.rules');
        if (!fs.existsSync(rulesPath)) return '';
        return fs.readFileSync(rulesPath, 'utf-8');
    } catch {
        return '';
    }
}

// Parses Codex prefix_rule entries. Handles whitespace flexibility, single or
// double quotes around tokens, comments (lines starting with #). Ignores any
// rule shape we don't recognize — Codex's grammar may grow over time.
function parseCodexRules(content) {
    if (!content) return [];
    const rules = [];
    const re = /prefix_rule\s*\(\s*pattern\s*=\s*\[([^\]]*)\]\s*,\s*decision\s*=\s*["']([a-zA-Z_]+)["']\s*\)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
        const tokens = m[1]
            .split(',')
            .map(s => s.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean);
        if (tokens.length === 0) continue;
        rules.push({ pattern: tokens, decision: m[2].toLowerCase() });
    }
    return rules;
}

// Convert allow-decision Codex rules into Claude-format perm entries
// (Bash(<tokens> *)) so they flow through the existing per-context perms
// pipeline and downstream sync (applyClaudePerms, deriveSafeCommandsFromAllow).
// Deny-decision rules are ignored — they don't grant permissions.
function codexRulesToClaudeAllow(rules) {
    if (!Array.isArray(rules)) return [];
    const out = [];
    for (const r of rules) {
        if (!r || r.decision !== 'allow') continue;
        if (!Array.isArray(r.pattern) || r.pattern.length === 0) continue;
        const cmd = r.pattern.join(' ').trim();
        if (!cmd) continue;
        out.push(`Bash(${cmd} *)`);
    }
    return out;
}

// Reverse of codexRulesToClaudeAllow: take Claude-format perm entries from
// the active context's allow-list and produce { pattern, decision: "allow" }
// rule objects suitable for writing to ~/.codex/rules/default.rules.
//
// Rejects entries Codex's prefix_rule grammar cannot match against:
//   - Non-Bash entries (WebSearch, Skill(...), etc.)
//   - Wildcard-everything Bash(*) — too dangerous and grammar-invalid
//   - Tokens containing shell metacharacters Codex won't evaluate
//     (per docs: redirections, substitutions, env vars, wildcards inside
//     a token, etc. — these commands skip rule matching at runtime anyway)
function claudeAllowToCodexRules(allow) {
    if (!Array.isArray(allow)) return [];
    const out = [];
    for (const raw of allow) {
        if (typeof raw !== 'string') continue;
        const m = raw.match(/^Bash\((.+)\)$/);
        if (!m) continue;
        // Strip a single trailing wildcard (the per-context convention) but
        // reject wildcards mid-pattern.
        const inner = m[1].trim().replace(/\s*\*\s*$/, '').trim();
        if (!inner) continue; // was Bash(*) alone
        const tokens = inner.split(/\s+/);
        if (tokens.length === 0) continue;
        const safe = tokens.every(t => /^[A-Za-z0-9._/+@:=,-]+$/.test(t));
        if (!safe) continue;
        out.push({ pattern: tokens, decision: 'allow' });
    }
    return out;
}

function formatCodexRule(rule) {
    const pattern = rule.pattern.map(t => `"${t.replace(/"/g, '\\"')}"`).join(', ');
    return `prefix_rule(pattern=[${pattern}], decision="${rule.decision}")`;
}

// Additive merge into ~/.codex/rules/default.rules: preserves every existing
// line (manual user edits, deny rules, anything we don't recognize) and
// appends any derived rules whose pattern is not already present. Returns
// the count of newly-written rules.
function applyCodexRulesFile(rules) {
    if (!Array.isArray(rules) || rules.length === 0) return 0;
    const rulesDir  = path.join(os.homedir(), '.codex', 'rules');
    const rulesPath = path.join(rulesDir, 'default.rules');
    let existingContent = '';
    try {
        if (!fs.existsSync(rulesDir)) fs.mkdirSync(rulesDir, { recursive: true });
        if (fs.existsSync(rulesPath)) existingContent = fs.readFileSync(rulesPath, 'utf-8');
    } catch (err) {
        console.error('Failed to read Codex rules file:', err.message);
        return 0;
    }

    const existing = parseCodexRules(existingContent);
    const existingKeys = new Set(existing.map(r => `${r.decision}:${r.pattern.join(' ')}`));

    const toAppend = [];
    for (const r of rules) {
        const key = `${r.decision}:${r.pattern.join(' ')}`;
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);
        toAppend.push(r);
    }
    if (toAppend.length === 0) return 0;

    const lines = toAppend.map(formatCodexRule);
    const sep   = (existingContent && !existingContent.endsWith('\n')) ? '\n' : '';
    const next  = existingContent + sep + lines.join('\n') + '\n';
    try {
        fs.writeFileSync(rulesPath, next, 'utf-8');
    } catch (err) {
        console.error('Failed to write Codex rules file:', err.message);
        return 0;
    }
    return toAppend.length;
}

// Soft probe: verify the codex CLI binary exists and runs. Returns
// { ok: true } if `codex --version` exits cleanly within 2s, otherwise
// { ok: false, error: string }. Callers should use this for warning UX
// only — config validity does not depend on the binary being installed.
function probeCodexBinary() {
    return new Promise(resolve => {
        const { execFile } = require('child_process');
        execFile('codex', ['--version'], { timeout: 2000 }, (err) => {
            if (!err) return resolve({ ok: true });
            if (err.code === 'ENOENT')  return resolve({ ok: false, error: 'codex CLI not on PATH' });
            if (err.killed)             return resolve({ ok: false, error: 'codex --version timed out after 2s' });
            const first = (err.message || '').split('\n')[0].slice(0, 160);
            return resolve({ ok: false, error: `codex --version exited with: ${first}` });
        });
    });
}

function applyCodexFullAuto(enabled) {
    setCodexGlobalApprovalPolicy(!!enabled);
    setCodexBashAlias(!!enabled);
}

function listRemovalCommands(contextAllow) {
    const result = [];

    for (const perm of (contextAllow || [])) {
        const m = perm.match(/^(\w+)\((.+)\)$/);
        if (!m) continue;
        if (m[1].toLowerCase() === 'bash' && isRemovalCommand(m[2])) {
            result.push({ source: 'context', perm });
        }
    }

    const claudeAllow = readClaudeSettings()?.permissions?.allow || [];
    for (const perm of claudeAllow) {
        const m = perm.match(/^(\w+)\((.+)\)$/);
        if (!m) continue;
        if (m[1].toLowerCase() === 'bash' && isRemovalCommand(m[2])) {
            result.push({ source: 'claude', perm });
        }
    }

    const codexCommands = extractCodexSafeCommands(readCodexConfig());
    for (const cmd of codexCommands) {
        if (isRemovalCommand(cmd)) {
            result.push({ source: 'codex', perm: cmd });
        }
    }

    return result;
}

function removeRemovalCommandFromClaudeGlobal(perm) {
    const settings = readClaudeSettings();
    if (!settings.permissions || !Array.isArray(settings.permissions.allow)) return false;
    const before = settings.permissions.allow.length;
    settings.permissions.allow = settings.permissions.allow.filter(p => p !== perm);
    if (settings.permissions.allow.length === before) return false;
    writeClaudeSettings(settings);
    return true;
}

function removeRemovalCommandFromCodex(cmd) {
    const existing = extractCodexSafeCommands(readCodexConfig());
    const filtered = existing.filter(c => c !== cmd);
    if (filtered.length === existing.length) return false;
    setCodexSafeCommands(filtered);
    return true;
}

function purgeRemovalMemory() {
    const settings = readClaudeSettings();
    if (!settings.permissions) settings.permissions = {};
    if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];

    const beforeClaude = settings.permissions.allow.length;
    settings.permissions.allow = purgeRemovalCommandsFromAllow(settings.permissions.allow);
    const claudeRemoved = beforeClaude - settings.permissions.allow.length;
    writeClaudeSettings(settings);

    const codexContent = readCodexConfig();
    const existing = extractCodexSafeCommands(codexContent);
    const filtered = filterRemovalCommands(existing);
    let codexRemoved = 0;
    if (filtered.length !== existing.length) {
        codexRemoved = existing.length - filtered.length;
        setCodexSafeCommands(filtered);
    }

    return { removed: claudeRemoved + codexRemoved, claude: claudeRemoved, codex: codexRemoved };
}

function consolidatePermissionsToGlobal(contexts, loadContext, saveContext) {
    if (!Array.isArray(contexts) || contexts.length === 0) return { consolidated: [], count: 0 };

    const patternFreq = {};
    const patternToProjects = {};

    for (const ctxName of contexts) {
        try {
            const ctx = loadContext(ctxName);
            const allowPerms = (ctx.perms && ctx.perms.allow) ? ctx.perms.allow : [];

            for (const perm of allowPerms) {
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
            const allowPerms = (ctx.perms && ctx.perms.allow) ? ctx.perms.allow : [];
            const filtered = allowPerms.filter(p => !toPromote.includes(p));

            if (filtered.length !== allowPerms.length) {
                saveContext(ctxName, { ...ctx, perms: { ...ctx.perms, allow: filtered } });
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
    extractCodexTrust,
    applyCodexTrust,
    consolidatePermissionsToGlobal,
    applyCodexFullAuto,
    applyCodexSandboxMode,
    setCodexGlobalApprovalPolicy,
    setCodexBashAlias,
    updateCodexGranularConfig,
    removeCodexGranularSection,
    extractCodexSafeCommands,
    setCodexSafeCommands,
    applyCodexSafeCommands,
    deriveSafeCommandsFromAllow,
    isRemovalCommand,
    filterRemovalCommands,
    hasRemovalCommands,
    purgeRemovalCommandsFromAllow,
    purgeRemovalMemory,
    listRemovalCommands,
    removeRemovalCommandFromClaudeGlobal,
    removeRemovalCommandFromCodex,
    probeCodexBinary,
    readCodexRulesFile,
    parseCodexRules,
    codexRulesToClaudeAllow,
    claudeAllowToCodexRules,
    formatCodexRule,
    applyCodexRulesFile,
    __test: {
        generalizeClaudePerm,
        isClaudePermCovered,
        captureNewClaudePerms,
        updateCodexTomlContent,
        tokenizeCommand,
        generalizePath,
    },
};
