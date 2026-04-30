const vscode = require('vscode');
const { spawn } = require('child_process');
const { buildAgentContext } = require('./inject');

// Returns the configured CLI path, defaulting to 'claude' on PATH.
function getCliPath() {
    const config  = vscode.workspace.getConfiguration('aiContext');
    const cliPath = config.get('cliPath');
    return cliPath && cliPath.trim() ? cliPath.trim() : 'claude';
}

function buildPrompt(ctx, task) {
    return `You are resuming a prior AI session.

<context>
${JSON.stringify(buildAgentContext(ctx))}
</context>

Task: ${task}

Rules:
- Do NOT ask for missing context
- Continue execution immediately
- After your response, output the updated context on its own line prefixed EXACTLY with "CTX_UPDATE:" (no space before the JSON)
- CTX_UPDATE may include only changed fields; omitted fields are preserved by the extension
- Use "n" for the next concrete action, as one short sentence
- Use "d" for durable decisions, "c" for constraints, "f" for important files, and "b" for blockers
- Use "h" for compacted summaries of older actions; preserve it unless you are deliberately summarizing history
- Use "a" only for recent meaningful actions; do not log every file read or trivial step
- Keep all arrays compact, deduplicated, and ordered from oldest to newest
- Context schema: {"v":3,"p":"str","root":"str","t":"str","i":"str","n":"str","s":{},"b":[],"d":[],"c":[],"f":[],"h":[],"a":[],"e":"str|null"}

CTX_UPDATE:{"v":3,...}`;
}

// Scans from the bottom of the response for the last CTX_UPDATE: line.
// Searching from the bottom makes it immune to JSON appearing in code blocks
// or the injected context earlier in the response.
function extractContextUpdate(response) {
    const lines = response.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith('CTX_UPDATE:')) {
            try {
                return JSON.parse(line.slice('CTX_UPDATE:'.length).trim());
            } catch {
                return null;
            }
        }
    }
    return null;
}

function stripContextUpdate(response) {
    return response
        .split('\n')
        .filter(l => !l.trim().startsWith('CTX_UPDATE:'))
        .join('\n')
        .trimEnd();
}

// Calls the configured AI CLI in non-interactive print mode.
// Prompt is passed via stdin to avoid OS argument-length limits on large contexts.
function runWithClaude(prompt) {
    return new Promise((resolve, reject) => {
        const cli  = getCliPath();
        const proc = spawn(cli, ['-p', '--output-format', 'text', '-'], {
            env:   { ...process.env },
            shell: process.platform === 'win32',
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', d => { stdout += d.toString(); });
        proc.stderr.on('data', d => { stderr += d.toString(); });

        proc.stdin.write(prompt, 'utf8');
        proc.stdin.end();

        proc.on('error', err => reject(
            err.code === 'ENOENT'
                ? new Error(`CLI not found: "${cli}". Set aiContext.cliPath or add it to PATH.`)
                : err
        ));

        proc.on('close', code =>
            code === 0
                ? resolve(stdout)
                : reject(new Error(stderr.trim() || `CLI exited with code ${code}`))
        );
    });
}

module.exports = { getCliPath, buildPrompt, extractContextUpdate, stripContextUpdate, runWithClaude };
