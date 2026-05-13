const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const settings = {
    agents: ['claude', 'codex', 'copilot'],
    autoGitignore: false,
    autoDetect: true,
    codexProjectSwitchBootstrap: true,
    followActiveEditor: true,
    followTerminalCwd: true,
    maxActions: 3,
};

const mockVscode = {
    workspace: {
        workspaceFolders: null,
        getConfiguration: () => ({
            get: key => settings[key],
            update: async (key, value) => { settings[key] = value; },
        }),
        createFileSystemWatcher: () => ({
            onDidChange: () => {},
            onDidCreate: () => {},
            dispose: () => {},
        }),
        onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
        openTextDocument: async doc => doc,
    },
    window: {
        activeTerminal: null,
        activeTextEditor: null,
        onDidChangeActiveTerminal: () => ({ dispose: () => {} }),
        onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async () => undefined,
        showQuickPick: async () => undefined,
        showInputBox: async () => undefined,
        showTextDocument: async () => undefined,
        withProgress: async (_options, task) => task(),
    },
    commands: {
        registerCommand: () => ({ dispose: () => {} }),
    },
    Uri: {
        file: fsPath => ({ fsPath }),
    },
    RelativePattern: function RelativePattern(base, pattern) {
        this.base = base;
        this.pattern = pattern;
    },
    ProgressLocation: {
        Notification: 1,
    },
    ConfigurationTarget: {
        Global: 1,
    },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return mockVscode;
    return originalLoad.call(this, request, parent, isMain);
};

const context = require('../src/context');
const inject = require('../src/inject');
const claude = require('../src/claude');
const extension = require('../src/extension');
const permissions = require('../src/permissions');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-context-runner-'));
}

function count(content, needle) {
    return content.split(needle).length - 1;
}

function testContextMemoryNormalization() {
    const dir = tmpDir();
    const ctx = context.createDefaultContext('Demo', dir);
    ctx.v = 1;
    ctx.n = 'Run unit tests';
    ctx.a = ['one', 'two', 'three', 'two', 'four'];
    ctx.d = Array.from({ length: 25 }, (_, i) => `decision-${i}`);
    ctx.c = Array.from({ length: 25 }, (_, i) => `constraint-${i}`);
    ctx.f = Array.from({ length: 35 }, (_, i) => `file-${i}`);
    ctx.b = Array.from({ length: 18 }, (_, i) => `blocker-${i}`);

    context.saveContext(dir, 'Demo', ctx);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'Demo.json'), 'utf8'));

    assert.strictEqual(saved.v, 3);
    assert.strictEqual(saved.n, 'Run unit tests');
    assert.deepStrictEqual(saved.a, ['three', 'two', 'four']);
    assert.strictEqual(saved.h.length, 1);
    assert.ok(saved.h[0].includes('compacted 1 older action'));
    assert.ok(saved.h[0].includes('one'));
    assert.strictEqual(saved.d.length, 20);
    assert.strictEqual(saved.c.length, 20);
    assert.strictEqual(saved.f.length, 30);
    assert.strictEqual(saved.b.length, 15);
    assert.strictEqual(saved.m.compactionVersion, 1);
    assert.ok(saved.m.compactedAt);
    assert.ok(saved.lastUsed);
}

function testHistoryCap() {
    const result = context.compactActions(
        ['old-1', 'old-2', 'recent'],
        Array.from({ length: 12 }, (_, i) => `history-${i}`),
        1
    );

    assert.deepStrictEqual(result.actions, ['recent']);
    assert.strictEqual(result.history.length, 12);
    assert.strictEqual(result.history[0], 'history-1');
    assert.ok(result.history[11].includes('old-1'));
    assert.ok(result.compacted);
}

function testCompactInjectionProjection() {
    const block = inject.buildInjectionBlock({
        v: 3,
        p: 'Demo',
        root: '/tmp/Demo',
        t: 'task',
        i: 'intent',
        n: 'next',
        s: { phase: 'test' },
        b: ['blocker'],
        d: ['decision'],
        c: ['constraint'],
        f: ['src/inject.js'],
        h: ['older summary'],
        a: ['recent action'],
        e: null,
        m: { compactedAt: 'never' },
        createdAt: '2026-01-01T00:00:00.000Z',
        lastUsed: '2026-01-02T00:00:00.000Z',
    });
    const firstLine = block.split('\n')[0];
    assert.ok(firstLine.startsWith(`${inject.AGENT_CONTEXT_NAME}=`));

    const projected = JSON.parse(firstLine.slice(`${inject.AGENT_CONTEXT_NAME}=`.length));
    assert.deepStrictEqual(projected.b, ['blocker']);
    assert.deepStrictEqual(projected.d, ['decision']);
    assert.deepStrictEqual(projected.c, ['constraint']);
    assert.deepStrictEqual(projected.f, ['src/inject.js']);
    assert.deepStrictEqual(projected.h, ['older summary']);
    assert.deepStrictEqual(projected.a, ['recent action']);
    assert.strictEqual(projected.mem,       undefined);
    assert.strictEqual(projected.createdAt, undefined);
    assert.strictEqual(projected.lastUsed,  undefined);
    assert.strictEqual(projected.m,         undefined);
    assert.ok(!block.includes('Raw context'));
    assert.ok(!block.includes('Project     :'));
}

function testPathContainment() {
    const { isSameOrChildPath } = extension.__test;
    assert.strictEqual(isSameOrChildPath('/tmp/Project', '/tmp/Project'), true);
    assert.strictEqual(isSameOrChildPath('/tmp/Project', '/tmp/Project/src'), true);
    assert.strictEqual(isSameOrChildPath('/tmp/Project', '/tmp/ProjectX'), false);
}

function testCurrentLocationPathHelpers() {
    const { getEditorPath, getTerminalCwd } = extension.__test;
    assert.strictEqual(
        getEditorPath({ document: { uri: { scheme: 'file', fsPath: '/tmp/Project/' } } }),
        '/tmp/Project'
    );
    assert.strictEqual(
        getEditorPath({ document: { uri: { scheme: 'untitled', fsPath: '/tmp/Project' } } }),
        null
    );
    assert.strictEqual(
        getTerminalCwd({ shellIntegration: { cwd: { fsPath: '/tmp/Project/src/' } } }),
        '/tmp/Project/src'
    );
    assert.strictEqual(
        getTerminalCwd({ shellIntegration: { cwd: '/tmp/Project/src/' } }),
        '/tmp/Project/src'
    );
}

function testSyncActiveContextForPath() {
    const ctxDir  = tmpDir();
    const project = tmpDir();
    context.saveContext(ctxDir, 'Project', context.createDefaultContext('Project', project));

    let active = null;
    const wsState = {
        get: () => active,
        update: async (_key, value) => { active = value; },
    };

    const matched = extension.__test.syncActiveContextForPath(
        ctxDir,
        wsState,
        path.join(project, 'src'),
        { notify: false }
    );

    assert.strictEqual(matched, 'Project');
    assert.strictEqual(active, 'Project');
    assert.ok(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8').includes(inject.AGENT_CONTEXT_NAME));
}

function testInjectionMarkerRepair() {
    const dir = tmpDir();
    const file = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(file, `Header\n${inject.INJECT_START}\nstale block without end`);

    inject.injectIntoFile(file, 'fresh block');
    const injected = fs.readFileSync(file, 'utf8');
    assert.strictEqual(count(injected, inject.INJECT_START), 1);
    assert.strictEqual(count(injected, inject.INJECT_END), 1);
    assert.ok(injected.includes('Header'));
    assert.ok(injected.includes('fresh block'));
    assert.ok(!injected.includes('stale block'));

    inject.clearInjection(file);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'Header\n');
}

function testInvalidRootIsSkipped() {
    const dir = tmpDir();
    const missingRoot = path.join(dir, 'missing');
    const result = inject.autoInject({
        p: 'Missing',
        root: missingRoot,
        t: 'init',
        s: {},
        a: [],
    });

    assert.strictEqual(result, false);
    assert.strictEqual(fs.existsSync(path.join(missingRoot, 'AGENTS.md')), false);
}

function testCodexBootstrapInjection() {
    const dir = tmpDir();
    const file = path.join(dir, 'AGENTS.md');

    assert.strictEqual(inject.autoInjectCodexBootstrap(dir), true);
    inject.autoInjectCodexBootstrap(dir);

    const bootstrapped = fs.readFileSync(file, 'utf8');
    assert.strictEqual(count(bootstrapped, inject.BOOTSTRAP_START), 1);
    assert.strictEqual(count(bootstrapped, inject.BOOTSTRAP_END), 1);
    assert.ok(bootstrapped.includes(`Projects root: ${dir}`));
    assert.ok(bootstrapped.includes('Read the nearest AGENTS.md from that target directory'));
    assert.ok(bootstrapped.includes('Your VERY FIRST tool call MUST be to read AGENTS.md'));

    inject.injectIntoFile(file, 'context block');
    const withContext = fs.readFileSync(file, 'utf8');
    assert.strictEqual(count(withContext, inject.BOOTSTRAP_START), 1);
    assert.strictEqual(count(withContext, inject.INJECT_START), 1);

    inject.clearInjection(file);
    const afterClear = fs.readFileSync(file, 'utf8');
    assert.ok(afterClear.includes(inject.BOOTSTRAP_START));
    assert.ok(!afterClear.includes(inject.INJECT_START));
}

function testCodexTargetsNestedGitRoots() {
    const dir = tmpDir();
    const nestedRepo = path.join(dir, 'nested-repo');
    fs.mkdirSync(path.join(nestedRepo, '.git'), { recursive: true });

    const previousAgents = settings.agents;
    settings.agents = ['codex'];

    const targets = inject.getInjectionTargets(dir)
        .map(filePath => path.relative(dir, filePath).replace(/\\/g, '/'))
        .sort();

    assert.deepStrictEqual(targets, [
        'AGENTS.md',
        'nested-repo/AGENTS.md',
    ]);

    settings.agents = previousAgents;
}

function testCodexTargetsDedupRootGitRepo() {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.git'));

    const previousAgents = settings.agents;
    settings.agents = ['codex'];

    assert.deepStrictEqual(inject.getInjectionTargets(dir), [path.join(dir, 'AGENTS.md')]);

    settings.agents = previousAgents;
}

function testKiloTargetsAgentMd() {
    const dir = tmpDir();
    const nestedRepo = path.join(dir, 'nested-repo');
    fs.mkdirSync(path.join(nestedRepo, '.git'), { recursive: true });

    const previousAgents = settings.agents;
    settings.agents = ['kilo'];

    const targets = inject.getInjectionTargets(dir)
        .map(filePath => path.relative(dir, filePath).replace(/\\/g, '/'))
        .sort();

    assert.deepStrictEqual(targets, [
        'AGENTS.md',
        'nested-repo/AGENTS.md',
    ]);

    settings.agents = previousAgents;
}

function testCodexKiloTargetsDeduplicate() {
    const dir = tmpDir();
    const nestedRepo = path.join(dir, 'nested-repo');
    fs.mkdirSync(path.join(nestedRepo, '.git'), { recursive: true });

    const previousAgents = settings.agents;
    settings.agents = ['codex', 'kilo'];

    const targets = inject.getInjectionTargets(dir)
        .map(filePath => path.relative(dir, filePath).replace(/\\/g, '/'))
        .sort();

    assert.deepStrictEqual(targets, [
        'AGENTS.md',
        'nested-repo/AGENTS.md',
    ]);

    settings.agents = previousAgents;
}

function testAutoInjectWritesNestedCodexTargets() {
    const dir = tmpDir();
    const nestedRepo = path.join(dir, 'nested-repo');
    fs.mkdirSync(path.join(nestedRepo, '.git'), { recursive: true });

    const previousAgents = settings.agents;
    settings.agents = ['codex'];

    const result = inject.autoInject({
        v: 3,
        p: 'Nested',
        root: dir,
        t: 'init',
        s: {},
        a: [],
    });

    assert.strictEqual(result, true);
    assert.ok(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').includes(inject.AGENT_CONTEXT_NAME));
    assert.ok(fs.readFileSync(path.join(nestedRepo, 'AGENTS.md'), 'utf8').includes(inject.AGENT_CONTEXT_NAME));

    settings.agents = previousAgents;
}

function testGitignoreUsesNestedGitRoot() {
    const dir = tmpDir();
    const nestedRepo = path.join(dir, 'nested-repo');
    fs.mkdirSync(path.join(nestedRepo, '.git'), { recursive: true });

    inject.updateGitignore(dir, [
        path.join(dir, 'AGENTS.md'),
        path.join(nestedRepo, 'AGENTS.md'),
    ]);

    assert.strictEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'AGENTS.md\n');
    assert.strictEqual(fs.readFileSync(path.join(nestedRepo, '.gitignore'), 'utf8'), 'AGENTS.md\n');
}

function testContextUpdateParsing() {
    const response = [
        'CTX_UPDATE:{"old":true}',
        'content',
        'CTX_UPDATE:{"new":true}',
    ].join('\n');
    assert.deepStrictEqual(claude.extractContextUpdate(response), { new: true });
    assert.strictEqual(claude.stripContextUpdate(response), 'content');
}

// The injected instruction must steer the agent toward the .json.update sidecar
// and explicitly forbid echoing CTX_UPDATE into chat. The plain wall-of-JSON
// leak that this guards against showed up in user-visible Claude Code surfaces
// because nothing strips it from the IDE chat view.
function testInjectionForbidsInlineCtxUpdate() {
    const single = inject.buildInjectionBlock(
        { v: 3, p: 'Demo', root: '/tmp/Demo' },
        '/tmp/.ai-context/Demo.json',
    );
    assert.ok(single.includes('Do NOT include'),
        'single-context block must explicitly forbid inline CTX_UPDATE');
    assert.ok(single.includes('.update'),
        'single-context block must still tell the agent where the sidecar lives');

    const multi = inject.buildMultiInjectionBlock(
        [
            { v: 3, p: 'Demo',  root: '/tmp/Demo'  },
            { v: 3, p: 'Other', root: '/tmp/Other' },
        ],
        { Demo: '/tmp/.ai-context/Demo.json', Other: '/tmp/.ai-context/Other.json' },
    );
    assert.ok(multi.includes('Do NOT include'),
        'multi-context block must also forbid inline CTX_UPDATE');
}

// Belt-and-suspenders: if an agent ever wrote CTX_UPDATE into the agent file
// itself (CLAUDE.md / AGENTS.md) instead of the sidecar, the next injectIntoFile
// must remove those leaked lines from regions OUTSIDE our marker block while
// leaving the literal `CTX_UPDATE:{...}` template inside the marker untouched.
function testScrubLeakedContextUpdatesOutsideMarker() {
    const dir = tmpDir();
    const agentFile = path.join(dir, 'CLAUDE.md');

    const original = [
        'Pre-existing user notes.',
        'CTX_UPDATE:{"v":3,"p":"Leaked","t":"should-be-stripped"}',
        '',
        inject.INJECT_START,
        'AI_CONTEXT={"v":3,"p":"Demo"}',
        'After each response, write a single line `CTX_UPDATE:{"v":3,...}` to ...update — preserved inside block.',
        inject.INJECT_END,
        '',
        'Trailing notes.',
        'CTX_UPDATE:{"v":3,"p":"AlsoLeaked"}',
        '',
    ].join('\n');
    fs.writeFileSync(agentFile, original);

    const cleaned = inject.scrubLeakedContextUpdates(original);
    assert.ok(!cleaned.includes('"Leaked"'),
        'leak before the marker block must be stripped');
    assert.ok(!cleaned.includes('"AlsoLeaked"'),
        'leak after the marker block must be stripped');
    assert.ok(cleaned.includes('preserved inside block'),
        'instruction text inside the marker block must be preserved');
    assert.ok(cleaned.includes('Pre-existing user notes.'),
        'non-CTX_UPDATE content outside the block must survive');

    // injectIntoFile must apply the scrub before writing the refreshed block.
    inject.injectIntoFile(agentFile, 'AI_CONTEXT={"v":3,"p":"Demo"}\nrefreshed-instruction');
    const after = fs.readFileSync(agentFile, 'utf8');
    assert.ok(!after.includes('"Leaked"'),    'injectIntoFile should scrub leaks before re-injecting');
    assert.ok(!after.includes('"AlsoLeaked"'), 'injectIntoFile should scrub trailing leaks too');
    assert.ok(after.includes('refreshed-instruction'),
        'refreshed block content must be written');
}

// Without an existing marker block the scrub still removes leaked CTX_UPDATE
// lines from the whole file.
function testScrubLeakedContextUpdatesWithoutMarker() {
    const input = [
        'first line',
        'CTX_UPDATE:{"leak":1}',
        '   CTX_UPDATE:{"indented-leak":2}',
        'last line',
    ].join('\n');
    const cleaned = inject.scrubLeakedContextUpdates(input);
    assert.strictEqual(cleaned, 'first line\nlast line');
}

testContextMemoryNormalization();
testHistoryCap();
testCompactInjectionProjection();
testPathContainment();
testCurrentLocationPathHelpers();
testSyncActiveContextForPath();
testInjectionMarkerRepair();
testInvalidRootIsSkipped();
testCodexBootstrapInjection();
testCodexTargetsNestedGitRoots();
testCodexTargetsDedupRootGitRepo();
testKiloTargetsAgentMd();
testCodexKiloTargetsDeduplicate();
testAutoInjectWritesNestedCodexTargets();
testGitignoreUsesNestedGitRoot();
testContextUpdateParsing();
testInjectionForbidsInlineCtxUpdate();
testScrubLeakedContextUpdatesOutsideMarker();
testScrubLeakedContextUpdatesWithoutMarker();

// Verifies that normalizeContext accepts the old mem:{b,d,c,f} format produced
// by the previous injection schema and promotes it to top-level fields.
function testMemFormatFallback() {
    const dir = tmpDir();
    const ctxWithMem = {
        v: 3, p: 'Demo', root: dir, t: 'task',
        mem: { b: ['blocker-mem'], d: ['decision-mem'], c: ['constraint-mem'], f: ['file-mem.js'] },
        h: [], a: [], s: {}, n: '', i: '', e: null,
    };
    context.saveContext(dir, 'Demo', ctxWithMem);
    const loaded = context.loadContext(dir, 'Demo');
    assert.deepStrictEqual(loaded.b, ['blocker-mem'],    'b should be promoted from mem');
    assert.deepStrictEqual(loaded.d, ['decision-mem'],   'd should be promoted from mem');
    assert.deepStrictEqual(loaded.c, ['constraint-mem'], 'c should be promoted from mem');
    assert.deepStrictEqual(loaded.f, ['file-mem.js'],    'f should be promoted from mem');
}

// Verifies the sidecar round-trip: extractContextUpdate parses the file, the
// merged result survives normalizeContext, and top-level fields win over mem.
function testSidecarRoundTrip() {
    const dir  = tmpDir();
    const base = context.createDefaultContext('Demo', dir);
    base.b = ['existing-blocker'];
    context.saveContext(dir, 'Demo', base);

    // Simulate Claude writing CTX_UPDATE with top-level fields (new format)
    const sidecarContent = 'CTX_UPDATE:{"v":3,"p":"Demo","n":"next action","b":["new-blocker"],"d":["new-decision"],"a":["did thing"],"s":{"phase":"work"},"c":[],"f":[],"h":[],"e":null}';
    const update = claude.extractContextUpdate(sidecarContent);
    assert.ok(update, 'extractContextUpdate should parse sidecar content');
    assert.strictEqual(update.n, 'next action');

    const current = context.loadContext(dir, 'Demo');
    context.saveContext(dir, 'Demo', { ...current, ...update });
    const saved = context.loadContext(dir, 'Demo');

    assert.strictEqual(saved.n, 'next action');
    assert.deepStrictEqual(saved.b, ['new-blocker'],   'b from CTX_UPDATE should win');
    assert.deepStrictEqual(saved.d, ['new-decision'],  'd from CTX_UPDATE should win');
    assert.deepStrictEqual(saved.a, ['did thing'],     'a from CTX_UPDATE should be saved');
    assert.strictEqual(saved.p, 'Demo');
}

testMemFormatFallback();
testSidecarRoundTrip();

function testGeneralizeClaudePerm() {
    const projectRoot = '/home/bigfnj/projects/MyProject';

    assert.strictEqual(permissions.__test.generalizeClaudePerm('WebSearch', projectRoot), 'WebSearch', 'bare tool unchanged');
    assert.strictEqual(permissions.__test.generalizeClaudePerm('Bash(python3)', projectRoot), 'Bash(python3 *)', 'bare command gets trailing wildcard');
    assert.strictEqual(permissions.__test.generalizeClaudePerm('Bash(python3 -c \'import openpyxl; from openpyxl import load_workbook\')', projectRoot), 'Bash(python3 -c *)', 'python3 -c quoted arg becomes wildcard');
    assert.strictEqual(permissions.__test.generalizeClaudePerm('Bash(python3 -m pip show python-docx)', projectRoot), 'Bash(python3 -m *)', 'python3 -m args become wildcard');
    assert.strictEqual(permissions.__test.generalizeClaudePerm('Bash(sed -n \'70,80p\' /home/bigfnj/projects/MyProject/AI_UNDERSTANDING.md)', projectRoot), 'Bash(sed -n *)', 'sed with quoted range and path becomes wildcard');
    assert.strictEqual(permissions.__test.generalizeClaudePerm('Bash(git commit -m \'some message\')', projectRoot), 'Bash(git commit -m *)', 'git commit quoted message becomes wildcard');
    assert.strictEqual(permissions.__test.generalizeClaudePerm('Bash(npx markdownlint-cli2 *)', projectRoot), 'Bash(npx markdownlint-cli2 *)', 'already wildcarded unchanged');
}

function testIsClaudePermCovered() {
    assert.strictEqual(permissions.__test.isClaudePermCovered('WebSearch', ['WebSearch']), true, 'exact match');
    assert.strictEqual(permissions.__test.isClaudePermCovered('Bash(python3 -c \'x\')', ['Bash(python3 -c *)']), true, 'wildcard covers specific');
    assert.strictEqual(permissions.__test.isClaudePermCovered('Bash(python3 -c *)', ['Bash(python3 *)']), true, 'broader wildcard covers narrower');
    assert.strictEqual(permissions.__test.isClaudePermCovered('Bash(git *)', ['Bash(python3 *)']), false, 'no match');
    assert.strictEqual(permissions.__test.isClaudePermCovered('Bash(python3 *)', ['Bash(python3 -c *)']), false, 'narrower does not cover broader');
}

function testCaptureNewClaudePerms() {
    const projectRoot = '/home/bigfnj/projects/MyProject';

    // Test 1: deduplication across multiple new perms that generalize to same pattern
    const before1 = ['WebSearch'];
    const after1  = ['WebSearch', 'Bash(python3 -c \'x\')', 'Bash(python3 -c \'y\')'];
    const result1 = permissions.__test.captureNewClaudePerms(before1, after1, projectRoot, []);
    assert.deepStrictEqual(result1, ['Bash(python3 -c *)'], 'deduplicate multi new perms to same pattern');

    // Test 2: new perm already covered by existing
    const before2 = [];
    const after2  = ['Bash(git commit -m \'msg\')'];
    const existing2 = ['Bash(git *)'];
    const result2 = permissions.__test.captureNewClaudePerms(before2, after2, projectRoot, existing2);
    assert.deepStrictEqual(result2, [], 'new perm covered by existing');
}

function testUpdateCodexTomlContent() {
    // Test 1: append new section
    const content1 = 'model = "gpt-5.5"\nmodel_reasoning_effort = "xhigh"\n';
    const result1 = permissions.__test.updateCodexTomlContent(content1, '/home/user/MyProject', 'trusted');
    assert.ok(result1.includes('[projects."/home/user/MyProject"]'), 'new section header added');
    assert.ok(result1.includes('trust_level = "trusted"'), 'trust_level added');

    // Test 2: update existing section
    const content2 = '[projects."/home/user/MyProject"]\ntrust_level = "low"\n';
    const result2 = permissions.__test.updateCodexTomlContent(content2, '/home/user/MyProject', 'high');
    assert.ok(result2.includes('trust_level = "high"'), 'trust_level updated to high');
    assert.ok(!result2.includes('trust_level = "low"'), 'old trust_level removed');

    // Test 3: preserve unrelated sections
    const content3 = '[projects."/other"]\ntrust_level = "medium"\n[projects."/home/user/MyProject"]\ntrust_level = "low"\n';
    const result3 = permissions.__test.updateCodexTomlContent(content3, '/home/user/MyProject', 'trusted');
    assert.ok(result3.includes('[projects."/other"]'), 'unrelated section preserved');
    assert.ok(result3.includes('trust_level = "medium"'), 'unrelated trust_level preserved');
    assert.ok(result3.includes('trust_level = "trusted"'), 'target trust_level updated');
}

function testSearchContexts() {
    const dir = tmpDir();
    context.saveContext(dir, 'AlphaProject', { ...context.createDefaultContext('AlphaProject', '/home/user/alpha'), n: 'working on auth', d: ['use JWT tokens'] });
    context.saveContext(dir, 'BetaService',  { ...context.createDefaultContext('BetaService',  '/home/user/beta'),  f: ['src/database.js'] });
    context.saveContext(dir, 'GammaApp',     { ...context.createDefaultContext('GammaApp',     '/home/user/gamma'), n: 'frontend work' });

    const results = context.searchContexts(dir, 'alpha');
    assert.ok(results.length > 0, 'search finds AlphaProject');
    assert.strictEqual(results[0].name, 'AlphaProject', 'AlphaProject is top result for "alpha"');

    const authResults = context.searchContexts(dir, 'auth');
    assert.ok(authResults.some(r => r.name === 'AlphaProject'), 'note match finds AlphaProject');

    const dbResults = context.searchContexts(dir, 'database');
    assert.ok(dbResults.some(r => r.name === 'BetaService'), 'file match finds BetaService');

    const noResults = context.searchContexts(dir, 'zzznomatch');
    assert.strictEqual(noResults.length, 0, 'no results for unmatched query');

    fs.rmSync(dir, { recursive: true, force: true });
}

function testCheckContextHealth() {
    const dir = tmpDir();

    // Healthy context pointing at existing dir
    const ctx1 = context.createDefaultContext('TestCtx', dir);
    const h1 = context.checkContextHealth(ctx1);
    assert.ok(!h1.ok || h1.warnings.some(w => w.includes('git')), 'non-git root gets warning');

    // Missing root
    const ctx2 = { ...context.createDefaultContext('NoRoot', '/nonexistent/path/xyz') };
    const h2 = context.checkContextHealth(ctx2);
    assert.ok(!h2.ok, 'missing root is unhealthy');
    assert.ok(h2.warnings.some(w => w.includes('not found')), 'missing root warning present');

    // Error flag
    const ctx3 = { ...context.createDefaultContext('ErrCtx', dir), e: 'ctx_parse_err' };
    const h3 = context.checkContextHealth(ctx3);
    assert.ok(!h3.ok, 'error flag is unhealthy');

    // No root set
    const ctx4 = context.createDefaultContext('NoRootSet', '');
    const h4 = context.checkContextHealth(ctx4);
    assert.ok(!h4.ok, 'empty root is unhealthy');

    fs.rmSync(dir, { recursive: true, force: true });
}

function testTemplates() {
    const dir = tmpDir();

    // Create a base context and save as template
    const base = context.createDefaultContext('MyProject', '/home/user/myproject');
    base.d = ['Use TypeScript', 'Prefer functional patterns'];
    base.c = ['No external dependencies'];
    base.f = ['src/index.ts', 'src/utils.ts'];
    base.n = 'working on refactor';
    context.saveContext(dir, 'MyProject', base);

    // Manually mark as template
    const tplCtx = { ...base, p: 'MyProject-template', a: [], s: {}, m: { isTemplate: true } };
    context.saveContext(dir, 'MyProject-template', tplCtx);

    const templates = context.listTemplates(dir);
    assert.ok(templates.includes('MyProject-template'), 'template appears in listTemplates');
    assert.ok(!templates.includes('MyProject'), 'non-template excluded from listTemplates');

    // Create from template
    context.createFromTemplate(dir, 'MyProject-template', 'NewProject', '/home/user/new');
    const newCtx = context.loadContext(dir, 'NewProject');
    assert.deepStrictEqual(newCtx.d, base.d, 'decisions copied from template');
    assert.deepStrictEqual(newCtx.c, base.c, 'constraints copied from template');
    assert.deepStrictEqual(newCtx.f, base.f, 'files copied from template');
    assert.strictEqual(newCtx.n, base.n, 'note copied from template');
    assert.deepStrictEqual(newCtx.a, [], 'actions reset in new context');
    assert.deepStrictEqual(newCtx.s, {}, 'session state reset in new context');

    fs.rmSync(dir, { recursive: true, force: true });
}

function testApplyCodexSandboxMode() {
    const root = tmpDir();
    const cfg = path.join(root, '.codex', 'config.toml');

    // Off when no config exists yet → returns ok and writes nothing
    const r0 = permissions.applyCodexSandboxMode(root, null);
    assert.strictEqual(r0.ok, true, 'mode=null on missing config returns ok');
    assert.strictEqual(fs.existsSync(cfg), false, 'no config created when mode=null');

    // workspace-write writes the line
    const r1 = permissions.applyCodexSandboxMode(root, 'workspace-write');
    assert.strictEqual(r1.ok, true, 'workspace-write succeeds');
    assert.ok(fs.readFileSync(cfg, 'utf-8').includes('sandbox_mode = "workspace-write"'), 'workspace-write line present');

    // Switch to danger-full-access overwrites the line (no duplicate)
    const r2 = permissions.applyCodexSandboxMode(root, 'danger-full-access');
    assert.strictEqual(r2.ok, true, 'danger-full-access succeeds');
    const content2 = fs.readFileSync(cfg, 'utf-8');
    assert.ok(content2.includes('sandbox_mode = "danger-full-access"'), 'danger-full-access line present');
    assert.ok(!content2.includes('sandbox_mode = "workspace-write"'), 'old workspace-write line replaced');
    assert.strictEqual(content2.split('sandbox_mode').length - 1, 1, 'exactly one sandbox_mode line');

    // null removes the line
    const r3 = permissions.applyCodexSandboxMode(root, null);
    assert.strictEqual(r3.ok, true, 'null removes the line');
    assert.ok(!fs.readFileSync(cfg, 'utf-8').includes('sandbox_mode'), 'sandbox_mode removed');

    // Invalid mode rejected
    const r4 = permissions.applyCodexSandboxMode(root, 'bogus');
    assert.strictEqual(r4.ok, false, 'invalid mode rejected');

    fs.rmSync(root, { recursive: true, force: true });
}

function testApplyCodexSandboxNetworkAccess() {
    const root = tmpDir();
    const cfg = path.join(root, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, 'sandbox_mode = "workspace-write"\n', 'utf-8');

    // Enable: writes section
    permissions.applyCodexSandboxNetworkAccess(root, true);
    const c1 = fs.readFileSync(cfg, 'utf-8');
    assert.ok(c1.includes('[sandbox_workspace_write]'), 'section present');
    assert.ok(c1.includes('network_access = true'), 'network_access = true present');
    assert.ok(c1.includes('sandbox_mode = "workspace-write"'), 'sandbox_mode preserved');

    // Disable: removes section, leaves rest intact
    permissions.applyCodexSandboxNetworkAccess(root, false);
    const c2 = fs.readFileSync(cfg, 'utf-8');
    assert.ok(!c2.includes('[sandbox_workspace_write]'), 'section removed');
    assert.ok(!c2.includes('network_access'), 'network_access removed');
    assert.ok(c2.includes('sandbox_mode = "workspace-write"'), 'sandbox_mode still present');

    // Re-enable is idempotent (no duplicate sections)
    permissions.applyCodexSandboxNetworkAccess(root, true);
    permissions.applyCodexSandboxNetworkAccess(root, true);
    const c3 = fs.readFileSync(cfg, 'utf-8');
    assert.strictEqual(c3.split('[sandbox_workspace_write]').length - 1, 1, 'exactly one section');

    fs.rmSync(root, { recursive: true, force: true });
}

function testProbeSandboxRuntime() {
    const r = permissions.probeSandboxRuntime();
    assert.ok(r && typeof r === 'object', 'returns object');
    assert.ok(['macos', 'windows', 'linux', 'wsl2'].includes(r.platform), 'known platform: ' + r.platform);
    assert.strictEqual(typeof r.ok, 'boolean', 'ok is boolean');
    if (!r.ok) {
        assert.ok(r.advice, 'advice provided when not ok');
    }
}

function testProbeCloudRequirements() {
    // Swap HOME so probeCloudRequirements reads from our tmp dir.
    const origHome = process.env.HOME;
    const home = tmpDir();
    process.env.HOME = home;
    try {
        // No cache file → returns null
        assert.strictEqual(permissions.probeCloudRequirements(), null, 'no cache file → null');

        fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
        const cachePath = path.join(home, '.codex', 'cloud-requirements-cache.json');

        // Active cache with restrictions
        const future = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        const past = new Date(Date.now() - 60 * 1000).toISOString();
        const tomlActive = [
            'allowed_sandbox_modes = ["read-only", "workspace-write"]',
            'allowed_approval_policies = ["on-request", "untrusted"]',
            'allowed_web_search_modes = ["cached"]',
            '[[rules.prefix_rules]]',
            'pattern = [{ any_of = ["python"] }]',
            'decision = "prompt"',
            '[[rules.prefix_rules]]',
            'decision = "prompt"',
        ].join('\n');
        fs.writeFileSync(cachePath, JSON.stringify({
            signed_payload: { expires_at: future, account_id: 'acct-1', contents: tomlActive },
        }), 'utf-8');
        const r1 = permissions.probeCloudRequirements();
        assert.ok(r1 && r1.active === true, 'active cache returns active=true');
        assert.strictEqual(r1.expired, false, 'unexpired cache reads as not expired');
        assert.deepStrictEqual(r1.sandboxAllowed, ['read-only', 'workspace-write'], 'sandbox list parsed');
        assert.deepStrictEqual(r1.approvalAllowed, ['on-request', 'untrusted'], 'approval list parsed');
        assert.strictEqual(r1.prefixRulesPromptCount, 2, 'prompt-rule count counts both blocks');
        // First block has `any_of = ["python"]`, second block has no pattern, so only python is captured.
        assert.ok(r1.shadowedFirstTokens instanceof Set, 'shadowedFirstTokens is a Set');
        assert.ok(r1.shadowedFirstTokens.has('python'), 'python token mined from any_of');
        assert.strictEqual(r1.shadowedFirstTokens.size, 1, 'patternless block contributes no tokens');

        // Expired cache
        fs.writeFileSync(cachePath, JSON.stringify({
            signed_payload: { expires_at: past, contents: 'allowed_sandbox_modes = ["read-only"]' },
        }), 'utf-8');
        const r2 = permissions.probeCloudRequirements();
        assert.strictEqual(r2.expired, true, 'past expires_at marked expired');

        // Malformed JSON → null
        fs.writeFileSync(cachePath, '{ not json', 'utf-8');
        assert.strictEqual(permissions.probeCloudRequirements(), null, 'malformed cache → null');

        // Missing signed_payload → null
        fs.writeFileSync(cachePath, JSON.stringify({}), 'utf-8');
        assert.strictEqual(permissions.probeCloudRequirements(), null, 'missing payload → null');

        // Missing keys in TOML → arrays come back null
        fs.writeFileSync(cachePath, JSON.stringify({
            signed_payload: { expires_at: future, contents: '# empty' },
        }), 'utf-8');
        const r3 = permissions.probeCloudRequirements();
        assert.strictEqual(r3.sandboxAllowed, null, 'missing sandbox key → null array');
        assert.strictEqual(r3.approvalAllowed, null, 'missing approval key → null array');
    } finally {
        if (origHome === undefined) delete process.env.HOME;
        else process.env.HOME = origHome;
        fs.rmSync(home, { recursive: true, force: true });
    }
}

function testCloudShadowedFiltering() {
    // Mines the shadowed-first-tokens set from a representative cloud TOML
    // (modeled on the real ~/.codex/cloud-requirements-cache.json the user runs
    // under) and verifies that claudeAllowToCodexRules + deriveSafeCommandsFromAllow
    // both honor it. The cache writer keeps blocks varied: any_of, a single
    // literal token, and a forbidden decision (also shadow-eligible).
    const origHome = process.env.HOME;
    const home = tmpDir();
    process.env.HOME = home;
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const cachePath = path.join(home, '.codex', 'cloud-requirements-cache.json');
    const future = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const toml = [
        'allowed_sandbox_modes = ["read-only", "workspace-write"]',
        'allowed_approval_policies = ["on-request", "untrusted"]',
        '[[rules.prefix_rules]]',
        'pattern = [{ any_of = ["python", "python3", "node"] }]',
        'decision = "prompt"',
        '[[rules.prefix_rules]]',
        'pattern = [{ any_of = ["npx", "npm", "pip"] }]',
        'decision = "prompt"',
        '[[rules.prefix_rules]]',
        'pattern = [{ token = "kubectl" }]',
        'decision = "forbidden"',
        '[agents]',
        'max_threads = 2',
    ].join('\n');
    fs.writeFileSync(cachePath, JSON.stringify({
        signed_payload: { expires_at: future, account_id: 'acct-x', contents: toml },
    }), 'utf-8');

    try {
        const shadow = permissions.getCloudShadowedFirstTokens();
        assert.ok(shadow instanceof Set, 'getCloudShadowedFirstTokens returns a Set');
        for (const t of ['python', 'python3', 'node', 'npx', 'npm', 'pip', 'kubectl']) {
            assert.ok(shadow.has(t), `shadow set contains ${t}`);
        }
        assert.ok(!shadow.has('pip3'), 'pip3 is NOT shadowed (cloud lists pip, not pip3)');
        assert.ok(!shadow.has('git'), 'git is NOT shadowed');

        // Mixed allow list — some shadowed, some not.
        const allow = [
            'Bash(git status --short *)',     // keep
            'Bash(python3 -c *)',             // drop (python3 shadowed)
            'Bash(python3 *)',                // drop
            'Bash(node *)',                   // drop
            'Bash(npx markdownlint-cli2 *)',  // drop
            'Bash(pip3 list *)',              // keep (pip3 ≠ pip)
            'Bash(kubectl get pods *)',       // drop (forbidden also shadows)
            'Bash(rg --files *)',             // keep
        ];

        const rules = permissions.claudeAllowToCodexRules(allow, shadow);
        const ruleFirstTokens = rules.map(r => r.pattern[0]);
        assert.deepStrictEqual(
            ruleFirstTokens.sort(),
            ['git', 'pip3', 'rg'].sort(),
            'claudeAllowToCodexRules drops shadowed entries, keeps the rest',
        );

        const safe = permissions.deriveSafeCommandsFromAllow(allow, shadow);
        assert.ok(!safe.some(c => c.startsWith('python')), 'derived safeCommands drops python3*');
        assert.ok(!safe.some(c => c.startsWith('node')), 'derived safeCommands drops node*');
        assert.ok(!safe.some(c => c.startsWith('npx')), 'derived safeCommands drops npx*');
        assert.ok(!safe.some(c => c.startsWith('kubectl')), 'derived safeCommands drops kubectl*');
        assert.ok(safe.includes('git status --short'), 'derived safeCommands keeps git');
        assert.ok(safe.includes('pip3 list'), 'derived safeCommands keeps pip3 (not pip)');

        // Null shadow set → no filtering (legacy behavior preserved).
        const rulesUnfiltered = permissions.claudeAllowToCodexRules(allow, null);
        assert.strictEqual(rulesUnfiltered.length, 8, 'null shadow set → no filter applied');

        // Count helper agrees on the drop count.
        assert.strictEqual(
            permissions.countCloudShadowedAllow(allow, shadow),
            5,
            'countCloudShadowedAllow agrees: 4 runtime/pm + 1 kubectl = 5 shadowed',
        );
        assert.strictEqual(
            permissions.countCloudShadowedAllow(allow, null),
            0,
            'null shadow set → zero shadowed count',
        );

        // Expired cache → getCloudShadowedFirstTokens returns null.
        const past = new Date(Date.now() - 60 * 1000).toISOString();
        fs.writeFileSync(cachePath, JSON.stringify({
            signed_payload: { expires_at: past, contents: toml },
        }), 'utf-8');
        assert.strictEqual(
            permissions.getCloudShadowedFirstTokens(),
            null,
            'expired cache → null shadow set',
        );
    } finally {
        if (origHome === undefined) delete process.env.HOME;
        else process.env.HOME = origHome;
        fs.rmSync(home, { recursive: true, force: true });
    }
}

function testDeriveApprovalPolicyForSandboxModes() {
    // Swap HOME so we can stage cloud-requirements caches independently.
    const origHome = process.env.HOME;
    const home = tmpDir();
    process.env.HOME = home;
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const cachePath = path.join(home, '.codex', 'cloud-requirements-cache.json');
    const fut = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const writeCache = (sandboxAllowed, approvalAllowed) => fs.writeFileSync(cachePath, JSON.stringify({
        signed_payload: {
            expires_at: fut,
            contents: `allowed_sandbox_modes = [${sandboxAllowed.map(s => `"${s}"`).join(', ')}]\n` +
                      `allowed_approval_policies = [${approvalAllowed.map(s => `"${s}"`).join(', ')}]\n`,
        },
    }), 'utf-8');

    try {
        // Personal / unmanaged install: no cache → all-off returns null, danger returns 'never'
        if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
        assert.strictEqual(
            permissions.deriveApprovalPolicyForSandboxModes({ anyDanger: false, anyWsWrite: false }),
            null, 'all off → null (no cloud)');
        assert.strictEqual(
            permissions.deriveApprovalPolicyForSandboxModes({ anyDanger: true, anyWsWrite: false }),
            'never', 'danger → never (no cloud)');
        assert.strictEqual(
            permissions.deriveApprovalPolicyForSandboxModes({ anyDanger: false, anyWsWrite: true }),
            null, 'workspace-write → null (no cloud — leave policy alone)');

        // Managed: cloud allows untrusted, forbids never. Danger AND workspace-write
        // both upgrade to 'untrusted'.
        writeCache(['read-only', 'workspace-write'], ['on-request', 'untrusted']);
        assert.strictEqual(
            permissions.deriveApprovalPolicyForSandboxModes({ anyDanger: true, anyWsWrite: false }),
            'untrusted', 'danger under cloud → untrusted fallback');
        assert.strictEqual(
            permissions.deriveApprovalPolicyForSandboxModes({ anyDanger: false, anyWsWrite: true }),
            'untrusted', 'workspace-write under cloud → untrusted (QoL upgrade)');
        assert.strictEqual(
            permissions.deriveApprovalPolicyForSandboxModes({ anyDanger: false, anyWsWrite: false }),
            null, 'all off under cloud → null');

        // Managed: cloud allows neither (worst-case)
        writeCache(['read-only'], ['on-request']);
        assert.strictEqual(
            permissions.deriveApprovalPolicyForSandboxModes({ anyDanger: true, anyWsWrite: false }),
            null, 'danger when cloud allows neither → null (no managed line written)');
        assert.strictEqual(
            permissions.deriveApprovalPolicyForSandboxModes({ anyDanger: false, anyWsWrite: true }),
            null, 'workspace-write when cloud allows neither → null');
    } finally {
        if (origHome === undefined) delete process.env.HOME;
        else process.env.HOME = origHome;
        fs.rmSync(home, { recursive: true, force: true });
    }
}

function testSetCodexApprovalPolicy() {
    const origHome = process.env.HOME;
    const home = tmpDir();
    process.env.HOME = home;
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const cfg = path.join(home, '.codex', 'config.toml');
    try {
        // null on empty file is a no-op
        permissions.setCodexApprovalPolicy(null);
        assert.ok(!fs.existsSync(cfg) || !fs.readFileSync(cfg, 'utf-8').includes('approval_policy'),
            'null on empty config writes nothing');

        // Write 'untrusted'
        permissions.setCodexApprovalPolicy('untrusted');
        assert.ok(fs.readFileSync(cfg, 'utf-8').includes('approval_policy = "untrusted"'), 'untrusted line present');

        // Overwrite with 'never'
        permissions.setCodexApprovalPolicy('never');
        const after1 = fs.readFileSync(cfg, 'utf-8');
        assert.ok(after1.includes('approval_policy = "never"'), 'never line present');
        assert.ok(!after1.includes('approval_policy = "untrusted"'), 'old untrusted line replaced');
        assert.strictEqual(after1.split('approval_policy').length - 1, 1, 'exactly one approval_policy line');

        // null removes our managed line
        permissions.setCodexApprovalPolicy(null);
        assert.ok(!fs.readFileSync(cfg, 'utf-8').includes('approval_policy'), 'managed line removed');

        // null leaves a user-set non-managed value alone
        fs.writeFileSync(cfg, 'approval_policy = "on-request"\n', 'utf-8');
        permissions.setCodexApprovalPolicy(null);
        assert.ok(fs.readFileSync(cfg, 'utf-8').includes('approval_policy = "on-request"'),
            'user-set on-request preserved');

        // Invalid value rejected
        const r = permissions.setCodexApprovalPolicy('bogus');
        assert.strictEqual(r.ok, false, 'invalid value rejected');
    } finally {
        if (origHome === undefined) delete process.env.HOME;
        else process.env.HOME = origHome;
        fs.rmSync(home, { recursive: true, force: true });
    }
}

function testContextNormalizeSandboxFields() {
    const dir = tmpDir();
    // Legacy boolean field is intentionally NOT migrated — fields are removed
    // from disk in the v4.1.0 cleanup, and normalizeContext defaults the new
    // enum to null when absent.
    const legacy = {
        ...context.createDefaultContext('Legacy', dir),
        perms: { allow: [], codex: 'trusted', safeCommands: [], sandboxMode: true },
    };
    context.saveContext(dir, 'Legacy', legacy);
    const loaded = context.loadContext(dir, 'Legacy');
    assert.strictEqual(loaded.perms.codexSandboxMode, null, 'legacy boolean does not seed new enum');
    assert.strictEqual('sandboxMode' in loaded.perms, false, 'legacy field stripped on normalize');

    // Valid enum values round-trip
    for (const mode of ['workspace-write', 'danger-full-access']) {
        const ctx = { ...context.createDefaultContext('M', dir), perms: { allow: [], codex: 'trusted', safeCommands: [], codexSandboxMode: mode, codexNetworkAccess: false } };
        context.saveContext(dir, 'M', ctx);
        assert.strictEqual(context.loadContext(dir, 'M').perms.codexSandboxMode, mode, `${mode} round-trips`);
    }

    // Garbage enum reverts to null
    const bad = { ...context.createDefaultContext('B', dir), perms: { allow: [], codex: 'trusted', safeCommands: [], codexSandboxMode: 'bogus', codexNetworkAccess: false } };
    context.saveContext(dir, 'B', bad);
    assert.strictEqual(context.loadContext(dir, 'B').perms.codexSandboxMode, null, 'invalid enum coerced to null');

    fs.rmSync(dir, { recursive: true, force: true });
}

testGeneralizeClaudePerm();
testIsClaudePermCovered();
testCaptureNewClaudePerms();
testUpdateCodexTomlContent();
testSearchContexts();
testCheckContextHealth();
testTemplates();
testApplyCodexSandboxMode();
testApplyCodexSandboxNetworkAccess();
testProbeSandboxRuntime();
testProbeCloudRequirements();
testCloudShadowedFiltering();
testDeriveApprovalPolicyForSandboxModes();
testSetCodexApprovalPolicy();
testContextNormalizeSandboxFields();

console.log('unit tests passed');
