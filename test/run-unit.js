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
    assert.ok(bootstrapped.includes('Immediately read the nearest AGENTS.md'));

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

console.log('unit tests passed');
