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

// Toggle the global `approval_policy = "never"` line in ~/.codex/config.toml.
// Called in lockstep with the per-project sandbox-mode toggle: enabling sandbox
// bypass implies a "no friction" posture, so suppressing approval prompts
// globally avoids re-introducing friction on language runtimes / network calls
// at the approval gate (which sits before the sandbox in Codex's pipeline).
//
// Always strips the [approval_policy.granular] section because current Codex
// rejects it ("granular is not a unit variant") and silently falls back to
// "on-request", which would override the scalar approval_policy we just wrote.
// Comments (#) and the rest of the file are left alone.
// Writes the global ~/.codex/config.toml `approval_policy` scalar.
//   value === 'never'      → maximum automation (rejected by managed-account cloud reqs)
//   value === 'untrusted'  → skip prompts for trusted projects + matched local rules
//                            (the strongest setting that managed accounts accept)
//   value === null         → remove the line, but ONLY if we wrote it (i.e. the current
//                            value is one of our two managed values). Manually-set
//                            policies like "on-request" are left untouched.
// Legacy boolean form `setCodexApprovalPolicyNever(true|false)` is preserved as a
// thin wrapper for backwards compatibility within the codebase.
const MANAGED_APPROVAL_VALUES = new Set(['never', 'untrusted']);

function setCodexApprovalPolicy(value) {
    if (value !== null && !MANAGED_APPROVAL_VALUES.has(value)) {
        return { ok: false, error: `invalid approval_policy value: ${value}` };
    }
    const content = readCodexConfig();
    const lines = content ? content.split('\n') : [];

    const firstSectionIdx = (() => {
        const idx = lines.findIndex(l => l.trim().startsWith('['));
        return idx === -1 ? lines.length : idx;
    })();

    let policyIdx = -1;
    for (let i = 0; i < firstSectionIdx; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith('#')) continue;
        if (/^approval_policy\s*=/.test(trimmed)) { policyIdx = i; break; }
    }

    if (value) {
        const newLine = `approval_policy = "${value}"`;
        if (policyIdx !== -1) lines[policyIdx] = newLine;
        else lines.splice(firstSectionIdx, 0, newLine);
    } else if (policyIdx !== -1) {
        const m = lines[policyIdx].match(/=\s*"([^"]*)"/);
        const current = m ? m[1] : null;
        if (current && MANAGED_APPROVAL_VALUES.has(current)) {
            lines.splice(policyIdx, 1);
        }
        // else: leave user-set policy alone
    }

    const stripped = removeCodexGranularSection(lines.join('\n'));
    writeCodexConfig(stripped);
    return { ok: true };
}

function setCodexApprovalPolicyNever(enabled) {
    setCodexApprovalPolicy(enabled ? 'never' : null);
}

// Picks the strongest approval_policy value compatible with active cloud
// requirements, given the union of per-context sandbox modes. Returns
// 'never' | 'untrusted' | null (null means: clear our managed policy line).
// See syncCodexApprovalPolicyToSandbox in extension.js for the contract.
function deriveApprovalPolicyForSandboxModes({ anyDanger, anyWsWrite }) {
    const cr = probeCloudRequirements();
    const cloudActive = !!(cr && cr.active && !cr.expired);
    const allows = (val) => !cloudActive || (Array.isArray(cr.approvalAllowed) && cr.approvalAllowed.includes(val));
    if (anyDanger) {
        if (allows('never'))     return 'never';
        if (allows('untrusted')) return 'untrusted';
        return null;
    }
    if (anyWsWrite && cloudActive && allows('untrusted')) return 'untrusted';
    return null;
}

// ── Removal command detection ─────────────────────────────────────────────────

// Patterns for commands the extension must never auto-allow when the
// "Prevent Removal Capture" toggle is on. Covers OS file removal, database
// DDL/DML destructives (SQL + NoSQL), container/orchestrator deletes, cloud
// CLI delete subcommands, IaC destroys, package uninstalls, and git
// destructives. Designed to match RAW commands (with quoted SQL strings
// intact) — apply the filter BEFORE generalization so wildcards don't hide
// destructive content.
const REMOVAL_PATTERNS = [
    // ── OS file removal ──
    /^(rm|rmdir|del|erase|remove|wipe|unlink|uninstall|purge)$/i,
    /^rm\b/i,
    /^rmdir\b/i,
    /^del\b/i,
    /^erase\b/i,
    /^unlink\b/i,
    /^find\b.*\s-delete\b/i,
    /^find\b.*\s-exec\s+rm\b/i,

    // ── Database destructive (SQL DDL/DML) ──
    /\bdrop\s+(table|database|schema|index|view|function|procedure|trigger|sequence|tablespace|role|user|owned|materialized\s+view|extension)\b/i,
    /\btruncate\s+(table|only)\b/i,
    /\bdelete\s+from\b/i,
    /\bdrop\s+if\s+exists\b/i,
    /\balter\s+table\s+\S+\s+drop\b/i, // ALTER TABLE foo DROP COLUMN/CONSTRAINT/...

    // ── NoSQL destructive (MongoDB shell / mongosh) ──
    /\b(?:db\.\w+\.)?drop\s*\(\s*\)/i,
    /\b(?:db\.\w+\.)?(deleteMany|deleteOne|remove)\s*\(/i,
    /\b(?:db\.\w+\.)?dropIndex(?:es)?\s*\(/i,
    /\bdropDatabase\s*\(/i,

    // ── Redis destructive ──
    /^redis-cli\b.*\b(flushall|flushdb|del)\b/i,
    /\b(flushall|flushdb)\b/i,

    // ── Container / orchestrator destructive ──
    /^(docker|podman)\s+(rm|rmi)\b/i,
    /^(docker|podman)\s+(volume|network|container|image|stack|service|secret|config|pod|system)\s+(rm|rmi|prune)\b/i,
    /^kubectl\s+(delete|drain)\b/i,
    /^helm\s+(delete|uninstall)\b/i,

    // ── Cloud CLIs — delete in subcommand position ──
    /^aws\s+\S+\s+(delete|rm|rb)\b/i,
    /^aws\s+s3\s+(rm|rb)\b/i,
    /^gcloud\s+\S+(\s+\S+)*\s+delete\b/i,
    /^az\s+\S+(\s+\S+)*\s+delete\b/i,

    // ── IaC destructive ──
    /^terraform\s+destroy\b/i,
    /^terraform\s+state\s+rm\b/i,
    /^terraform\s+apply\s+-destroy\b/i,
    /^pulumi\s+destroy\b/i,

    // ── Package manager uninstall / remove ──
    /^(npm|yarn|pnpm)\s+(uninstall|remove|rm)\b/i,
    /^pip3?\s+uninstall\b/i,
    /^cargo\s+remove\b/i,
    /^(apt|apt-get)\s+(remove|purge|autoremove)\b/i,
    /^dnf\s+(remove|erase|autoremove)\b/i,
    /^yum\s+(remove|erase)\b/i,
    /^brew\s+(uninstall|remove)\b/i,
    /^pacman\s+-R/i,

    // ── Git destructive / history-rewriting ──
    /^git\s+rm\b/i,
    /^git\s+reset\s+--hard\b/i,
    /^git\s+clean\s+-[a-z]*[fdx]/i,
    /^git\s+(branch|tag)\s+-[Dd]\b/i,
    /^git\s+push\b.*\s(?:-f|--force|--force-with-lease|--delete)\b/i,
    /^git\s+update-ref\s+-d\b/i,
    /^git\s+filter-branch\b/i,
    /^git\s+filter-repo\b/i,

    // ── Generic destructive verbs as standalone commands ──
    /^drop\b/i,
    /^destroy\b/i,
    /^truncate\b/i,
    /^wipe\b/i,
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
// Pass a Set of cloud-shadowed first tokens (from getCloudShadowedFirstTokens)
// to drop any entry whose argv[0] would be force-prompted by the cloud rule
// engine anyway — those safeCommands are no-ops at runtime and just bloat
// the Codex config.
function deriveSafeCommandsFromAllow(allowList, shadowedFirstTokens = null) {
    if (!Array.isArray(allowList)) return [];
    const results = [];
    for (const perm of allowList) {
        const m = perm.match(/^Bash\((.+)\)$/);
        if (!m) continue;
        const cmd = m[1].replace(/\s*\*$/, '').trim();
        if (!cmd) continue;
        if (shadowedFirstTokens && shadowedFirstTokens.size > 0) {
            const first = cmd.split(/\s+/)[0];
            if (shadowedFirstTokens.has(first)) continue;
        }
        results.push(cmd);
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
// Tri-state sandbox mode for the project's .codex/config.toml.
//   mode === 'workspace-write'    → safer default; workspace-only writes, network off
//   mode === 'danger-full-access' → no sandbox; pair with approval_policy=never for zero friction
//   mode === null | undefined     → remove the sandbox_mode line (Codex falls back to its built-in default)
const VALID_SANDBOX_MODES = new Set(['workspace-write', 'danger-full-access']);

function applyCodexSandboxMode(projectRoot, mode) {
    if (!projectRoot) return { ok: false, error: 'no projectRoot provided' };
    if (mode != null && !VALID_SANDBOX_MODES.has(mode)) {
        return { ok: false, error: `invalid sandbox mode: ${mode}` };
    }
    const configDir  = path.join(projectRoot, '.codex');
    const configPath = path.join(configDir, 'config.toml');
    const fileExistedBefore = fs.existsSync(configPath);

    if (!fs.existsSync(configDir)) {
        if (!mode) return { ok: true };
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
    if (mode) {
        const newLine = `sandbox_mode = "${mode}"`;
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

    const readBackMode = (() => {
        for (const l of readBack.split('\n')) {
            if (!keyLine.test(l)) continue;
            const m = l.match(/=\s*"([^"]+)"/);
            return m ? m[1] : null;
        }
        return null;
    })();

    if (mode && readBackMode !== mode) {
        revert();
        return { ok: false, error: `wrote sandbox_mode but readback shows ${readBackMode || 'absent'}` };
    }
    if (!mode && readBackMode !== null) {
        revert();
        return { ok: false, error: `sandbox_mode line still present (${readBackMode}) after disable` };
    }

    return { ok: true };
}

// Toggles the [sandbox_workspace_write] section's network_access flag in the
// project's .codex/config.toml. Only meaningful when sandbox_mode is
// "workspace-write"; for any other mode the section is harmless but unused.
// enabled === true   → write/replace the section with network_access = true
// enabled === false  → remove the section entirely (Codex defaults to no network)
function applyCodexSandboxNetworkAccess(projectRoot, enabled) {
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
    const stripped = stripCodexSection(priorContent, 'sandbox_workspace_write');

    const newContent = enabled
        ? (stripped.endsWith('\n') || stripped === '' ? stripped : stripped + '\n') +
          '[sandbox_workspace_write]\nnetwork_access = true\n'
        : stripped;

    try {
        fs.writeFileSync(configPath, newContent, 'utf-8');
    } catch (err) {
        return { ok: false, error: `cannot write config: ${err.message}` };
    }
    return { ok: true };
}

// Removes a single named TOML section (and its entries up to the next section
// header or EOF). Tolerant of leading whitespace; preserves all other content.
function stripCodexSection(content, sectionName) {
    if (!content) return '';
    const lines = content.split('\n');
    const headerRe = new RegExp(`^\\s*\\[${sectionName}\\]\\s*$`);
    const out = [];
    let inSection = false;
    for (const line of lines) {
        if (headerRe.test(line)) { inSection = true; continue; }
        if (inSection) {
            if (/^\s*\[/.test(line)) { inSection = false; out.push(line); }
            // else: skip section body
        } else {
            out.push(line);
        }
    }
    return out.join('\n');
}

// Detects the host platform's sandbox runtime requirement for Codex.
// Linux/WSL2: needs `bwrap` (bubblewrap) on PATH. macOS: built-in Seatbelt.
// Windows native: built-in PowerShell sandbox.
//
// Returns { platform, ok, detail, advice? } — `ok` is false only when the
// platform requires an external binary and we can't find it.
function probeSandboxRuntime() {
    const platform = process.platform;
    if (platform === 'darwin') {
        return { platform: 'macos', ok: true, detail: 'Seatbelt (built-in)' };
    }
    if (platform === 'win32') {
        return { platform: 'windows', ok: true, detail: 'PowerShell native sandbox' };
    }
    // Linux (incl. WSL2): need bwrap
    const isWSL = (() => {
        try {
            const v = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
            return v.includes('microsoft') || v.includes('wsl');
        } catch { return false; }
    })();
    const label = isWSL ? 'wsl2' : 'linux';
    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    for (const dir of pathDirs) {
        if (!dir) continue;
        const candidate = path.join(dir, 'bwrap');
        try {
            if (fs.existsSync(candidate)) {
                return { platform: label, ok: true, detail: `bwrap at ${candidate}` };
            }
        } catch { /* keep looking */ }
    }
    return {
        platform: label,
        ok: false,
        detail: 'bubblewrap not found on PATH',
        advice: 'sudo apt install bubblewrap',
    };
}

// Reads the locally-cached cloud requirements (managed Codex deployments,
// e.g. enterprise / ChatGPT-team accounts) and reports which sandbox modes
// and approval policies are allowed. Returns null when no cache exists
// (personal / unmanaged Codex installs hit this branch). When restrictions
// are present, choices outside `sandboxAllowed` / `approvalAllowed` will be
// silently downgraded by Codex at runtime to the policy-allowed fallback.
//
// Cache file: ~/.codex/cloud-requirements-cache.json — a JSON envelope
// whose `signed_payload.contents` is a TOML document. We parse the few
// keys we care about with regex to avoid pulling in a TOML dependency.
function probeCloudRequirements() {
    const cachePath = path.join(os.homedir(), '.codex', 'cloud-requirements-cache.json');
    if (!fs.existsSync(cachePath)) return null;
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    } catch { return null; }
    const payload = raw && raw.signed_payload;
    if (!payload || typeof payload.contents !== 'string') return null;
    const toml = payload.contents;
    const expiresAt = payload.expires_at || null;
    const expired = !!(expiresAt && new Date(expiresAt) < new Date());

    const extractList = (key) => {
        const m = toml.match(new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm'));
        if (!m) return null;
        return m[1]
            .split(',')
            .map(s => s.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean);
    };

    return {
        active: true,
        expired,
        expiresAt,
        sandboxAllowed:   extractList('allowed_sandbox_modes'),
        approvalAllowed:  extractList('allowed_approval_policies'),
        webSearchAllowed: extractList('allowed_web_search_modes'),
        prefixRulesPromptCount: (toml.match(/decision\s*=\s*"prompt"/g) || []).length,
        shadowedFirstTokens: extractCloudShadowedFirstTokens(toml),
        accountId: payload.account_id || null,
        source: 'cloud-requirements-cache.json',
    };
}

// Walk the cloud-requirements TOML for `[[rules.prefix_rules]]` blocks whose
// decision is "prompt" or "forbidden" and collect the first-token values from
// each `pattern = [{ token = "..." }]` or `pattern = [{ any_of = [...] }]`.
// These tokens cannot be downgraded to "allow" by local rules — the rule
// engine takes the max over matches and Prompt/Forbidden > Allow. Any local
// allow whose first token sits in this set is dead weight: it gets written
// to default.rules but the cloud rule fires anyway. Returns null when no
// cache is present, the cache has expired, or no shadowing tokens parse out.
function extractCloudShadowedFirstTokens(toml) {
    if (typeof toml !== 'string' || !toml) return null;
    const tokens = new Set();
    // Split on `[[rules.prefix_rules]]` header; skip the leading prologue.
    const blocks = toml.split(/^\s*\[\[rules\.prefix_rules\]\]\s*$/m).slice(1);
    for (const raw of blocks) {
        // A block ends at the next TOML table header (`[...`). Take only
        // body lines before that to avoid bleeding into adjacent sections.
        const body = raw.split(/^\s*\[(?!\[)/m)[0].split(/^\s*\[\[/m)[0];
        if (!/decision\s*=\s*"(prompt|forbidden)"/i.test(body)) continue;
        // Pattern shapes the engine accepts:
        //   pattern = [{ token = "foo" }]
        //   pattern = [{ any_of = ["a", "b", ...] }]
        // We only mine the FIRST pattern element because cloud blocks the
        // command's argv[0]; later tokens are positional refinements.
        const patternMatch = body.match(/pattern\s*=\s*\[\s*\{([^}]*)\}/);
        if (!patternMatch) continue;
        const inner = patternMatch[1];
        const anyOf = inner.match(/any_of\s*=\s*\[([^\]]+)\]/);
        if (anyOf) {
            for (const item of anyOf[1].split(',')) {
                const t = item.trim().replace(/^["']|["']$/g, '');
                if (t) tokens.add(t);
            }
            continue;
        }
        const literal = inner.match(/token\s*=\s*"([^"]+)"/);
        if (literal) tokens.add(literal[1]);
    }
    return tokens.size > 0 ? tokens : null;
}

// Convenience wrapper around probeCloudRequirements for callers that only
// need the shadowed-token set (rule-derivation paths). Returns null when
// the cache is missing, expired, or has no prompt/forbidden prefix rules.
function getCloudShadowedFirstTokens() {
    const cr = probeCloudRequirements();
    if (!cr || cr.expired) return null;
    return cr.shadowedFirstTokens || null;
}

// Counts how many entries in a Claude perms.allow array would be filtered
// out by the active cloud-shadowed token set. Used by the settings panel
// to warn the user when their local trusted list contains dead weight.
function countCloudShadowedAllow(allow, shadowedFirstTokens) {
    if (!Array.isArray(allow) || !shadowedFirstTokens || shadowedFirstTokens.size === 0) return 0;
    let n = 0;
    for (const raw of allow) {
        if (typeof raw !== 'string') continue;
        const m = raw.match(/^Bash\((.+)\)$/);
        if (!m) continue;
        const inner = m[1].trim().replace(/\s*\*\s*$/, '').trim();
        if (!inner) continue;
        const first = inner.split(/\s+/)[0];
        if (shadowedFirstTokens.has(first)) n++;
    }
    return n;
}

// ── Codex rollout JSONL parsing ─────────────────────────────────────────────
// Codex writes per-session transcripts to ~/.codex/sessions/<Y>/<M>/<D>/
// rollout-<TS>-<UUID>.jsonl. Each event_msg.exec_command_end event carries the
// command Codex actually executed. Auto-capturing those (filtered for shapes
// that can be safely turned into prefix rules and respecting the
// preventRemovalCapture toggle) lets us promote commands to persistent
// per-context perms without the user having to pick "Always allow" each time.

// Codex usually wraps shell commands as ["/bin/bash", "-lc", "<cmd>"]. Returns
// the inner bash string, or null if the array doesn't fit that shape (which
// means it's a non-shell exec we can't safely map to a Codex prefix rule).
function extractBashCommandFromCodexExec(commandArray) {
    if (!Array.isArray(commandArray) || commandArray.length < 3) return null;
    const a0 = String(commandArray[0] || '').toLowerCase();
    if (!a0.endsWith('bash') && !a0.endsWith('/sh') && !a0.endsWith('zsh') && a0 !== 'bash' && a0 !== 'sh') {
        // Allow paths like /bin/bash, /usr/bin/bash, /bin/sh
        if (!/(^|\/)(ba|z)?sh$/.test(a0)) return null;
    }
    for (let i = 1; i < commandArray.length - 1; i++) {
        const flag = String(commandArray[i] || '');
        if (flag === '-c' || flag === '-lc' || flag === '-l' || flag === '-ic') {
            const cmd = String(commandArray[i + 1] || '').trim();
            return cmd || null;
        }
    }
    return null;
}

// Returns true if the command is a shape Codex's prefix-rule grammar can match
// at runtime. Per the official rules docs, commands using shell metacharacters,
// env-var prefixes, redirections, substitutions, heredocs, or wildcards are
// skipped during rule evaluation — capturing those would produce phantom rules
// that never fire. Mirror that filter at the capture layer.
function isRuleSafeCommand(cmd) {
    if (!cmd || typeof cmd !== 'string') return false;
    if (cmd.length > 240) return false;
    if (/[|&;`$()<>]/.test(cmd)) return false;            // pipes, control ops, subst, redir
    if (/^\s*[A-Z_][A-Z0-9_]*=/.test(cmd)) return false;   // env-var prefix
    if (/<<\s*['"]?\w+['"]?/.test(cmd)) return false;     // heredoc
    if (/[*?]/.test(cmd)) return false;                    // glob/wildcard
    return true;
}

// Filter that drops removal commands when the aiContext.preventRemovalCapture
// toggle is on. Wraps purgeRemovalCommandsFromAllow so all watchers can use a
// consistent gate without each repeating the toggle check. Pass the boolean
// directly so this stays vscode-free (the caller reads the config).
function applyRemovalFilter(allowEntries, preventRemovalEnabled) {
    if (!preventRemovalEnabled) return allowEntries;
    return purgeRemovalCommandsFromAllow(allowEntries);
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
// Same shadow-filter contract as deriveSafeCommandsFromAllow — entries whose
// argv[0] sits in an active cloud prompt/forbidden rule are skipped, because
// the engine takes the max over matches and Allow loses to Prompt/Forbidden.
function claudeAllowToCodexRules(allow, shadowedFirstTokens = null) {
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
        if (shadowedFirstTokens && shadowedFirstTokens.size > 0 && shadowedFirstTokens.has(tokens[0])) continue;
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
    applyCodexSandboxNetworkAccess,
    probeSandboxRuntime,
    probeCloudRequirements,
    getCloudShadowedFirstTokens,
    countCloudShadowedAllow,
    setCodexGlobalApprovalPolicy,
    setCodexApprovalPolicy,
    setCodexApprovalPolicyNever,
    deriveApprovalPolicyForSandboxModes,
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
    extractBashCommandFromCodexExec,
    isRuleSafeCommand,
    applyRemovalFilter,
    __test: {
        generalizeClaudePerm,
        isClaudePermCovered,
        captureNewClaudePerms,
        updateCodexTomlContent,
        tokenizeCommand,
        generalizePath,
    },
};
