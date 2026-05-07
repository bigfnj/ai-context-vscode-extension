const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const u = require('../src/understanding');
const hook = require('../src/hook');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'aiu-test-'));
}

function rm(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

function fixtureProject() {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'foo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'console.log("a");\n');
    fs.writeFileSync(path.join(root, 'src', 'b.js'), 'console.log("b");\n');
    fs.writeFileSync(path.join(root, 'test', 'a.test.js'), 'assert(true);\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        name: 'fixture-pkg',
        version: '0.1.0',
        main: 'src/a.js',
        engines: { vscode: '^1.84' },
    }, null, 2));
    fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'node_modules', 'foo', 'index.js'), 'module.exports = 1;\n');
    return root;
}

// ─── sha1 ────────────────────────────────────────────────────────────────────

function testSha1MatchesNodeCrypto() {
    const content = 'hello world\n';
    const expected = crypto.createHash('sha1').update(content).digest('hex');
    assert.strictEqual(u.sha1(content), expected);
    assert.strictEqual(u.sha1(content).length, 40);
    assert.ok(/^[0-9a-f]{40}$/.test(u.sha1(content)));
}

function testSha1FileReadsBytes() {
    const dir = tmpDir();
    const file = path.join(dir, 'x.txt');
    fs.writeFileSync(file, 'abc');
    assert.strictEqual(u.sha1File(file), 'a9993e364706816aba3e25717850c26c9cd0d89d');
    rm(dir);
}

// ─── glob matching ───────────────────────────────────────────────────────────

function testGlobMatching() {
    assert.ok(u.matchesAny('src/foo.js', ['src/**']));
    assert.ok(u.matchesAny('src/sub/foo.js', ['src/**']));
    assert.ok(u.matchesAny('package.json', ['package.json']));
    assert.ok(!u.matchesAny('package-lock.json', ['package.json']));
    assert.ok(u.matchesAny('package-lock.json', ['*.lock', 'package-lock.json']));
    assert.ok(u.matchesAny('jest.config.js', ['*.config.{js,ts,json,mjs,cjs}']));
    assert.ok(u.matchesAny('jest.config.cjs', ['*.config.{js,ts,json,mjs,cjs}']));
    assert.ok(!u.matchesAny('jest.config.py', ['*.config.{js,ts,json,mjs,cjs}']));
    assert.ok(u.matchesAny('a/b/c/img.png', ['**/*.png']));
    assert.ok(!u.matchesAny('a/b/c/img.png', ['**/*.jpg']));
    assert.ok(u.matchesAny('node_modules/foo/index.js', ['node_modules/**']));
}

// ─── validateEntry ───────────────────────────────────────────────────────────

function validEntry(rel = 'src/a.js') {
    return {
        schema: 1,
        path: rel,
        sha1: 'a'.repeat(40),
        purpose: 'Does a thing.',
        exports: [],
        imports: [],
        called_by: [],
        calls_out_to: [],
        invariants: [],
        gotchas: [],
    };
}

function testValidateEntryHappy() {
    const result = u.validateEntry(validEntry(), 'src/a.js');
    assert.deepStrictEqual(result, { ok: true });
}

function testValidateEntryRejectsBadSha1() {
    const e = validEntry();
    e.sha1 = 'NOT-HEX';
    const r = u.validateEntry(e, 'src/a.js');
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(m => m.includes('sha1')));
}

function testValidateEntryRejectsUppercaseSha1() {
    const e = validEntry();
    e.sha1 = 'A'.repeat(40);
    const r = u.validateEntry(e, 'src/a.js');
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(m => m.includes('sha1')));
}

function testValidateEntryRejectsEmptyPurpose() {
    const e = validEntry();
    e.purpose = '';
    const r = u.validateEntry(e, 'src/a.js');
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(m => m.includes('purpose')));
}

function testValidateEntryRejectsWrongSchema() {
    const e = validEntry();
    e.schema = 2;
    const r = u.validateEntry(e, 'src/a.js');
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(m => m.includes('schema')));
}

function testValidateEntryRejectsUnknownField() {
    const e = validEntry();
    e.bonus = 'nope';
    const r = u.validateEntry(e, 'src/a.js');
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(m => m.includes('unknown field')));
}

function testValidateEntryRejectsMissingRequired() {
    const e = validEntry();
    delete e.imports;
    const r = u.validateEntry(e, 'src/a.js');
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(m => m.includes('imports')));
}

function testValidateEntryRejectsPathMismatch() {
    const e = validEntry('src/a.js');
    const r = u.validateEntry(e, 'src/b.js');
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(m => m.includes('does not match location')));
}

function testValidateEntryAllowsEmptyArrays() {
    const r = u.validateEntry(validEntry(), 'src/a.js');
    assert.strictEqual(r.ok, true);
}

function testValidateEntryKeyFunctions() {
    const e = validEntry();
    e.key_functions = [{ name: 'doThing', summary: 'Does the thing.' }];
    assert.strictEqual(u.validateEntry(e, 'src/a.js').ok, true);

    e.key_functions = [{ name: '', summary: 'x' }];
    assert.strictEqual(u.validateEntry(e, 'src/a.js').ok, false);
}

// ─── validateMeta ────────────────────────────────────────────────────────────

function validMeta() {
    return {
        schema: 1,
        project: 'fixture-pkg',
        last_audit_commit: 'abc1234',
        last_audit_at: '2026-05-07T15:00:00Z',
        generator: 'ai-context-runner/3.11.0',
        overview: 'A fixture.',
        frameworks: [{ name: 'Node.js' }],
        tracked_globs: { include: ['src/**'], exclude: ['node_modules/**'] },
        graph: '',
    };
}

function testValidateMetaHappy() {
    assert.deepStrictEqual(u.validateMeta(validMeta()), { ok: true });
}

function testValidateMetaRejectsBadFrameworks() {
    const m = validMeta();
    m.frameworks = [{ version: '1.0' }];
    const r = u.validateMeta(m);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(s => s.includes('frameworks')));
}

function testValidateMetaRejectsBadTrackedGlobs() {
    const m = validMeta();
    m.tracked_globs = { include: 'nope' };
    const r = u.validateMeta(m);
    assert.strictEqual(r.ok, false);
}

// ─── validateOperation ───────────────────────────────────────────────────────

function testValidateOperationUnderCap() {
    const r = u.validateOperation({ writes: ['a', 'b', 'c'], deletes: [], existingCount: 30 });
    assert.deepStrictEqual(r, { ok: true });
}

function testValidateOperationOverCap() {
    const r = u.validateOperation({
        writes: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'],
        deletes: [],
        existingCount: 30,
    });
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(m => m.includes('mass-edit')));
}

function testValidateOperationBootstrapBypass() {
    const r = u.validateOperation({
        writes: Array(100).fill('x'),
        deletes: [],
        existingCount: 1,
        bootstrap: true,
    });
    assert.deepStrictEqual(r, { ok: true });
}

function testValidateOperationCountsDeletes() {
    const r = u.validateOperation({
        writes: ['a', 'b', 'c', 'd', 'e'],
        deletes: ['x', 'y', 'z', 'w', 'v', 'u'],
        existingCount: 30,
    });
    assert.strictEqual(r.ok, false);
}

function testValidateOperationEmptyExisting() {
    const r = u.validateOperation({ writes: ['a'], deletes: [], existingCount: 0 });
    assert.deepStrictEqual(r, { ok: true });
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

function testCrudRoundTrip() {
    const root = tmpDir();
    const entry = validEntry('src/a.js');
    u.writeEntry(root, 'src/a.js', entry);
    assert.ok(fs.existsSync(path.join(root, 'AI_UNDERSTANDING', 'src', 'a.js.aiu.json')));
    const back = u.readEntry(root, 'src/a.js');
    assert.deepStrictEqual(back, entry);
    assert.strictEqual(u.deleteEntry(root, 'src/a.js'), true);
    assert.strictEqual(u.deleteEntry(root, 'src/a.js'), false);
    rm(root);
}

function testWriteEntryRejectsInvalid() {
    const root = tmpDir();
    const bad = validEntry('src/a.js');
    bad.sha1 = 'bogus';
    assert.throws(() => u.writeEntry(root, 'src/a.js', bad), /Invalid entry/);
    rm(root);
}

function testWriteEntryRejectsPathTraversal() {
    const root = tmpDir();
    assert.throws(() => u.writeEntry(root, '../escape.js', validEntry('../escape.js')),
        /Path traversal/);
    rm(root);
}

function testListEntries() {
    const root = tmpDir();
    u.writeEntry(root, 'src/a.js', validEntry('src/a.js'));
    u.writeEntry(root, 'src/sub/b.js', validEntry('src/sub/b.js'));
    u.writeMeta(root, validMeta());
    const list = u.listEntries(root);
    assert.deepStrictEqual(list, ['src/a.js', 'src/sub/b.js']);
    rm(root);
}

function testMetaCrud() {
    const root = tmpDir();
    u.writeMeta(root, validMeta());
    const back = u.readMeta(root);
    assert.strictEqual(back.project, 'fixture-pkg');
    rm(root);
}

// ─── Skeleton / generateSkeleton ────────────────────────────────────────────

function testMakeSkeletonEntry() {
    const e = u.makeSkeletonEntry('src/x.js', 'b'.repeat(40));
    assert.strictEqual(e.purpose, 'TODO');
    assert.deepStrictEqual(e.exports, []);
    assert.strictEqual(e.path, 'src/x.js');
    assert.strictEqual(u.validateEntry(e, 'src/x.js').ok, true);
}

function testGenerateSkeletonOnFixture() {
    const root = fixtureProject();
    const result = u.generateSkeleton(root);

    // Tracked: src/a.js, src/b.js, test/a.test.js, package.json
    // Excluded: README.md (not in include), package-lock.json (excluded), node_modules/**
    assert.deepStrictEqual(result.files.sort(), [
        'package.json',
        'src/a.js',
        'src/b.js',
        'test/a.test.js',
    ]);

    // Each entry passes validation and has correct sha1.
    for (const rel of result.files) {
        const entry = u.readEntry(root, rel);
        assert.strictEqual(u.validateEntry(entry, rel).ok, true);
        const expected = u.sha1(fs.readFileSync(path.join(root, rel)));
        assert.strictEqual(entry.sha1, expected);
        assert.strictEqual(entry.purpose, 'TODO');
    }

    // _meta.json present and valid.
    const meta = u.readMeta(root);
    assert.strictEqual(u.validateMeta(meta).ok, true);
    assert.strictEqual(meta.project, 'fixture-pkg');
    assert.ok(meta.frameworks.some(f => f.name === 'VS Code Extension API'));
    assert.ok(meta.frameworks.some(f => f.name === 'Node.js'));

    // Re-running on identical tree produces identical sha1s.
    const second = u.generateSkeleton(root);
    for (const rel of second.files) {
        assert.strictEqual(u.readEntry(root, rel).sha1, u.sha1File(path.join(root, rel)));
    }

    rm(root);
}

function testListTrackedExcludesAiuRoot() {
    const root = fixtureProject();
    u.generateSkeleton(root);
    // After bootstrap, AI_UNDERSTANDING/ exists. A second listing must not include it.
    const files = u.listTrackedSourceFiles(root, u.DEFAULT_TRACKED_GLOBS);
    assert.ok(!files.some(f => f.startsWith('AI_UNDERSTANDING/')));
    rm(root);
}

// ─── computeStatus / staleness ──────────────────────────────────────────────

function testComputeStatusUninitialized() {
    const root = fixtureProject();
    const s = u.computeStatus(root);
    assert.strictEqual(s.initialized, false);
    // Without _meta we use defaults — every tracked file is "untracked" until bootstrap.
    assert.strictEqual(s.untracked.length, 4);
    assert.strictEqual(s.fresh.length, 0);
    assert.strictEqual(s.stale.length, 0);
    assert.strictEqual(s.orphan.length, 0);
    rm(root);
}

function testComputeStatusCleanAfterBootstrap() {
    const root = fixtureProject();
    u.generateSkeleton(root);
    const s = u.computeStatus(root);
    assert.strictEqual(s.initialized, true);
    assert.strictEqual(s.fresh.length, 4);
    assert.strictEqual(s.stale.length, 0);
    assert.strictEqual(s.untracked.length, 0);
    assert.strictEqual(s.orphan.length, 0);
    assert.strictEqual(u.isClean(s), true);
    rm(root);
}

function testComputeStatusDetectsStale() {
    const root = fixtureProject();
    u.generateSkeleton(root);
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'console.log("modified");\n');
    const s = u.computeStatus(root);
    assert.deepStrictEqual(s.stale, ['src/a.js']);
    assert.strictEqual(s.fresh.length, 3);
    assert.strictEqual(u.isClean(s), false);
    rm(root);
}

function testComputeStatusDetectsUntracked() {
    const root = fixtureProject();
    u.generateSkeleton(root);
    fs.writeFileSync(path.join(root, 'src', 'newfile.js'), '// new\n');
    const s = u.computeStatus(root);
    assert.deepStrictEqual(s.untracked, ['src/newfile.js']);
    assert.strictEqual(u.isClean(s), false);
    rm(root);
}

function testComputeStatusDetectsOrphan() {
    const root = fixtureProject();
    u.generateSkeleton(root);
    fs.unlinkSync(path.join(root, 'src', 'b.js'));
    const s = u.computeStatus(root);
    assert.deepStrictEqual(s.orphan, ['src/b.js']);
    assert.strictEqual(u.isClean(s), false);
    rm(root);
}

function testComputeStatusRespectsCustomGlobs() {
    const root = fixtureProject();
    u.generateSkeleton(root, {
        tracked_globs: { include: ['src/**'], exclude: [] },
    });
    const s = u.computeStatus(root);
    // Only src/* should be tracked. test/ and package.json drop out of fresh AND
    // out of orphan (their .aiu.json was never written).
    assert.deepStrictEqual(s.fresh.sort(), ['src/a.js', 'src/b.js']);
    assert.strictEqual(s.orphan.length, 0);
    rm(root);
}

function testFormatStatusBar() {
    assert.strictEqual(u.formatStatusBar(null), 'AIU: ?');
    assert.strictEqual(
        u.formatStatusBar({ initialized: false, fresh: [], stale: [], untracked: [], orphan: [] }),
        'AIU: not initialized'
    );
    assert.strictEqual(
        u.formatStatusBar({ initialized: true, fresh: ['a'], stale: [], untracked: [], orphan: [] }),
        'AIU: clean'
    );
    assert.strictEqual(
        u.formatStatusBar({
            initialized: true,
            fresh: [],
            stale: ['a', 'b', 'c'],
            untracked: ['d'],
            orphan: [],
        }),
        'AIU: 3 stale, 1 untracked'
    );
    assert.strictEqual(
        u.formatStatusBar({
            initialized: true,
            fresh: [],
            stale: ['a'],
            untracked: ['b'],
            orphan: ['c', 'd'],
        }),
        'AIU: 1 stale, 1 untracked, 2 orphan'
    );
}

// ─── buildAiuInjectionBlock (spec §8.3 + §8 rules) ───────────────────────────

function testBuildAiuInjectionBlockUninitialized() {
    const text = u.buildAiuInjectionBlock({ initialized: false });
    assert.ok(text.includes('AIU_STATUS=not_initialized'));
    assert.ok(text.includes('AI_UNDERSTANDING_FORMAT.md'));
    // Must not include the AIU_STALE arrays when uninitialized.
    assert.ok(!text.includes('AIU_STALE='));
}

function testBuildAiuInjectionBlockClean() {
    const text = u.buildAiuInjectionBlock({
        initialized: true,
        fresh: ['src/a.js'],
        stale: [], untracked: [], orphan: [],
    });
    assert.ok(text.includes('AIU_STALE=[]'));
    assert.ok(text.includes('AIU_UNTRACKED=[]'));
    assert.ok(text.includes('AIU_ORPHAN=[]'));
    assert.ok(text.includes('last_audit_commit'));
    assert.ok(text.includes('AI_UNDERSTANDING_FORMAT.md'));
}

function testBuildAiuInjectionBlockWithFiles() {
    const text = u.buildAiuInjectionBlock({
        initialized: true,
        fresh: [],
        stale: ['src/a.js', 'src/b.js'],
        untracked: ['src/c.js'],
        orphan: ['src/old.js'],
    });
    assert.ok(text.includes('AIU_STALE=["src/a.js","src/b.js"]'));
    assert.ok(text.includes('AIU_UNTRACKED=["src/c.js"]'));
    assert.ok(text.includes('AIU_ORPHAN=["src/old.js"]'));
    // Each AIU_* line is parseable as JSON-array-after-equals.
    const stale = JSON.parse(text.match(/AIU_STALE=(\[.*\])/)[1]);
    assert.deepStrictEqual(stale, ['src/a.js', 'src/b.js']);
}

function testBuildAiuInjectionBlockHasAgentRules() {
    const text = u.buildAiuInjectionBlock({
        initialized: true,
        fresh: [], stale: [], untracked: [], orphan: [],
    });
    // The §8 rules an AI agent must follow.
    assert.ok(text.toLowerCase().includes('same turn'));      // §8.2
    assert.ok(text.toLowerCase().includes('regenerate'));     // §8.4
    assert.ok(text.toLowerCase().includes('mass edits'));     // §7 cross-entry rule 1
    assert.ok(text.toLowerCase().includes('last_audit_commit')); // §8.3
}

function testBuildAiuInjectionBlockProjectScoped() {
    const text = u.buildAiuInjectionBlock(
        { initialized: true, fresh: ['src/a.js'], stale: [], untracked: [], orphan: [] },
        { project: 'my-app', root: '/home/dev/projects/my-app' }
    );
    assert.ok(text.includes('AIU_PROJECT="my-app"'));
    assert.ok(text.includes('AIU_ROOT="/home/dev/projects/my-app"'));
    assert.ok(text.includes('/home/dev/projects/my-app/AI_UNDERSTANDING/'));
    // The instruction telling the agent to ingest AIU paired with AI_CONTEXT.
    assert.ok(text.toLowerCase().includes('after ingesting the ai_context'));
    assert.ok(text.includes('"my-app"'));
}

function testBuildAiuInjectionBlockUninitializedScoped() {
    const text = u.buildAiuInjectionBlock(
        { initialized: false },
        { project: 'my-app', root: '/x/y' }
    );
    assert.ok(text.includes('AIU_PROJECT="my-app"'));
    assert.ok(text.includes('AIU_ROOT="/x/y"'));
    assert.ok(text.includes('AIU_STATUS=not_initialized'));
    assert.ok(text.includes('/x/y/AI_UNDERSTANDING/'));
}

// ─── inject.injectMarkedBlock idempotence ───────────────────────────────────

function testInjectMarkedBlockIdempotent() {
    // Stub vscode for inject.js
    const Module = require('module');
    const orig = Module._load;
    Module._load = function(req, parent, isMain) {
        if (req === 'vscode') return {
            workspace: { workspaceFolders: null, getConfiguration: () => ({ get: () => null }) },
        };
        return orig.call(this, req, parent, isMain);
    };
    delete require.cache[require.resolve('../src/inject')];
    const inj = require('../src/inject');
    Module._load = orig;

    const dir = tmpDir();
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, 'existing prose\n');

    const wrote1 = inj.injectMarkedBlock(file, 'BODY', '<!-- S -->', '<!-- E -->');
    const wrote2 = inj.injectMarkedBlock(file, 'BODY', '<!-- S -->', '<!-- E -->');
    assert.strictEqual(wrote1, true);
    assert.strictEqual(wrote2, false, 'second write with identical content should short-circuit');

    const wrote3 = inj.injectMarkedBlock(file, 'CHANGED', '<!-- S -->', '<!-- E -->');
    assert.strictEqual(wrote3, true);
    rm(dir);
}

function testInjectMarkedBlockUpdatesInPlace() {
    const Module = require('module');
    const orig = Module._load;
    Module._load = function(req, parent, isMain) {
        if (req === 'vscode') return {
            workspace: { workspaceFolders: null, getConfiguration: () => ({ get: () => null }) },
        };
        return orig.call(this, req, parent, isMain);
    };
    delete require.cache[require.resolve('../src/inject')];
    const inj = require('../src/inject');
    Module._load = orig;

    const dir = tmpDir();
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, 'top\n\n<!-- S -->\nold\n<!-- E -->\n\nbottom\n');

    inj.injectMarkedBlock(file, 'new', '<!-- S -->', '<!-- E -->');
    const result = fs.readFileSync(file, 'utf8');
    assert.ok(result.includes('top'));
    assert.ok(result.includes('bottom'));
    assert.ok(result.includes('<!-- S -->\nnew\n<!-- E -->'));
    assert.ok(!result.includes('old'));
    // Single occurrence of the marker pair (no duplication).
    assert.strictEqual(result.split('<!-- S -->').length - 1, 1);
    rm(dir);
}

// ─── hook installer ─────────────────────────────────────────────────────────

const HOOK_SOURCE = path.resolve(__dirname, '..', 'cli', 'aiu-precommit.js');

function tmpGitRepo() {
    const dir = tmpDir();
    execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'aiu-test@example.com']);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'aiu-test']);
    execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
    return dir;
}

function testHookInstallerInstall() {
    const root = tmpGitRepo();
    assert.strictEqual(hook.isHookInstalled(root), false);
    const result = hook.installHook(root, HOOK_SOURCE);
    assert.strictEqual(result, 'installed');
    assert.strictEqual(hook.isHookInstalled(root), true);
    assert.ok(fs.existsSync(hook.hookPath(root)));
    assert.ok(fs.existsSync(hook.driverPath(root)));
    const body = fs.readFileSync(hook.hookPath(root), 'utf8');
    assert.ok(body.includes(hook.HOOK_MARKER));
    assert.ok(body.includes('exec node'));
    rm(root);
}

function testHookInstallerReinstallIsIdempotent() {
    const root = tmpGitRepo();
    hook.installHook(root, HOOK_SOURCE);
    const second = hook.installHook(root, HOOK_SOURCE);
    assert.strictEqual(second, 'reinstalled');
    rm(root);
}

function testHookInstallerBacksUpExistingHook() {
    const root = tmpGitRepo();
    fs.writeFileSync(hook.hookPath(root), '#!/bin/sh\necho user hook\n', { mode: 0o755 });
    const result = hook.installHook(root, HOOK_SOURCE);
    assert.strictEqual(result, 'installed');
    assert.ok(fs.existsSync(hook.backupPath(root)));
    assert.ok(fs.readFileSync(hook.backupPath(root), 'utf8').includes('user hook'));
    rm(root);
}

function testHookInstallerUninstallRestoresBackup() {
    const root = tmpGitRepo();
    fs.writeFileSync(hook.hookPath(root), '#!/bin/sh\necho user hook\n', { mode: 0o755 });
    hook.installHook(root, HOOK_SOURCE);
    const r = hook.uninstallHook(root);
    assert.strictEqual(r, 'restored-backup');
    assert.strictEqual(hook.isHookInstalled(root), false);
    assert.ok(fs.readFileSync(hook.hookPath(root), 'utf8').includes('user hook'));
    rm(root);
}

function testHookInstallerUninstallNoBackup() {
    const root = tmpGitRepo();
    hook.installHook(root, HOOK_SOURCE);
    const r = hook.uninstallHook(root);
    assert.strictEqual(r, 'uninstalled');
    assert.strictEqual(fs.existsSync(hook.hookPath(root)), false);
    assert.strictEqual(fs.existsSync(hook.driverPath(root)), false);
    rm(root);
}

function testHookInstallerUninstallNoop() {
    const root = tmpGitRepo();
    const r = hook.uninstallHook(root);
    assert.strictEqual(r, 'noop');
    rm(root);
}

function testHookInstallerRejectsNonGit() {
    const root = tmpDir();
    assert.throws(() => hook.installHook(root, HOOK_SOURCE), /Not a git repository/);
    rm(root);
}

// ─── hook integration: actually run the hook against a real git repo ────────

function gitC(root, args, opts) {
    return execFileSync('git', ['-C', root, ...args], opts || {});
}

function testHookIntegrationNoMetaIsNoop() {
    const root = tmpGitRepo();
    fs.writeFileSync(path.join(root, 'README.md'), '# repo\n');
    gitC(root, ['add', 'README.md']);
    const result = spawnSync('node', [HOOK_SOURCE], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(result.status, 0,
        `expected exit 0 for repo without _meta.json, got ${result.status}: ${result.stderr}`);
    rm(root);
}

function testHookIntegrationCleanCommitPasses() {
    const root = tmpGitRepo();
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'console.log(1);\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: 'fx', version: '0.1.0'}));
    u.generateSkeleton(root);
    gitC(root, ['add', '-A']);
    const result = spawnSync('node', [HOOK_SOURCE], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(result.status, 0,
        `clean commit should pass; got ${result.status}: ${result.stderr}`);
    rm(root);
}

function testHookIntegrationBlocksMissingSidecar() {
    const root = tmpGitRepo();
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'console.log(1);\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: 'fx'}));
    u.generateSkeleton(root);
    gitC(root, ['add', '-A']);
    gitC(root, ['commit', '-m', 'init', '-q']);
    // Add a new source file but DON'T create its sidecar.
    fs.writeFileSync(path.join(root, 'src', 'b.js'), 'console.log(2);\n');
    gitC(root, ['add', 'src/b.js']);
    const result = spawnSync('node', [HOOK_SOURCE], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(result.status, 1, 'missing sidecar should block');
    assert.ok(result.stderr.includes('missing sidecar'),
        `expected "missing sidecar" in stderr; got: ${result.stderr}`);
    rm(root);
}

function testHookIntegrationBlocksStaleSidecar() {
    const root = tmpGitRepo();
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'console.log(1);\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: 'fx'}));
    u.generateSkeleton(root);
    gitC(root, ['add', '-A']);
    gitC(root, ['commit', '-m', 'init', '-q']);
    // Modify source but don't refresh sha1 in sidecar.
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'console.log("changed");\n');
    gitC(root, ['add', 'src/a.js']);
    const result = spawnSync('node', [HOOK_SOURCE], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(result.status, 1, 'stale sidecar should block');
    assert.ok(result.stderr.includes('sha1'),
        `expected sha1 in stderr; got: ${result.stderr}`);
    rm(root);
}

function testHookIntegrationOrphanSidecarDeletion() {
    const root = tmpGitRepo();
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'console.log(1);\n');
    fs.writeFileSync(path.join(root, 'src', 'b.js'), 'console.log(2);\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: 'fx'}));
    u.generateSkeleton(root);
    gitC(root, ['add', '-A']);
    gitC(root, ['commit', '-m', 'init', '-q']);
    // Remove the sidecar but leave the source file alone.
    fs.unlinkSync(path.join(root, 'AI_UNDERSTANDING', 'src', 'b.js.aiu.json'));
    gitC(root, ['add', '-A']);
    const result = spawnSync('node', [HOOK_SOURCE], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(result.status, 1, 'orphan sidecar deletion should block');
    assert.ok(result.stderr.includes('staged for deletion'),
        `expected orphan message; got: ${result.stderr}`);
    rm(root);
}

function testHookIntegrationPairedDeletionPasses() {
    const root = tmpGitRepo();
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'console.log(1);\n');
    fs.writeFileSync(path.join(root, 'src', 'b.js'), 'console.log(2);\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: 'fx'}));
    u.generateSkeleton(root);
    gitC(root, ['add', '-A']);
    gitC(root, ['commit', '-m', 'init', '-q']);
    // Delete both sides — should pass.
    fs.unlinkSync(path.join(root, 'src', 'b.js'));
    fs.unlinkSync(path.join(root, 'AI_UNDERSTANDING', 'src', 'b.js.aiu.json'));
    gitC(root, ['add', '-A']);
    const result = spawnSync('node', [HOOK_SOURCE], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(result.status, 0,
        `paired deletion should pass; got ${result.status}: ${result.stderr}`);
    rm(root);
}

// ─── aiu.buildTooltip (pure formatter — no vscode runtime needed) ───────────

function testBuildTooltip() {
    // Stub out vscode require for this test only — buildTooltip itself doesn't
    // call into vscode, but loading aiu.js does `require('vscode')`.
    const Module = require('module');
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'vscode') return {};
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../src/aiu')];
    const aiu = require('../src/aiu');
    Module._load = originalLoad;

    assert.strictEqual(aiu.buildTooltip(null), 'AI Understanding');
    assert.ok(aiu.buildTooltip({ initialized: false, fresh: [], stale: [], untracked: [], orphan: [] })
        .includes('not initialized'));
    assert.ok(aiu.buildTooltip({ initialized: true, fresh: ['a', 'b'], stale: [], untracked: [], orphan: [] })
        .includes('clean'));
    const tt = aiu.buildTooltip({
        initialized: true, fresh: [],
        stale: ['s1', 's2'], untracked: ['u1'], orphan: [],
    });
    assert.ok(tt.includes('stale (2)'));
    assert.ok(tt.includes('untracked (1)'));
    assert.ok(tt.includes('Click for details'));
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const tests = [
    testSha1MatchesNodeCrypto,
    testSha1FileReadsBytes,
    testGlobMatching,
    testValidateEntryHappy,
    testValidateEntryRejectsBadSha1,
    testValidateEntryRejectsUppercaseSha1,
    testValidateEntryRejectsEmptyPurpose,
    testValidateEntryRejectsWrongSchema,
    testValidateEntryRejectsUnknownField,
    testValidateEntryRejectsMissingRequired,
    testValidateEntryRejectsPathMismatch,
    testValidateEntryAllowsEmptyArrays,
    testValidateEntryKeyFunctions,
    testValidateMetaHappy,
    testValidateMetaRejectsBadFrameworks,
    testValidateMetaRejectsBadTrackedGlobs,
    testValidateOperationUnderCap,
    testValidateOperationOverCap,
    testValidateOperationBootstrapBypass,
    testValidateOperationCountsDeletes,
    testValidateOperationEmptyExisting,
    testCrudRoundTrip,
    testWriteEntryRejectsInvalid,
    testWriteEntryRejectsPathTraversal,
    testListEntries,
    testMetaCrud,
    testMakeSkeletonEntry,
    testGenerateSkeletonOnFixture,
    testListTrackedExcludesAiuRoot,
    testComputeStatusUninitialized,
    testComputeStatusCleanAfterBootstrap,
    testComputeStatusDetectsStale,
    testComputeStatusDetectsUntracked,
    testComputeStatusDetectsOrphan,
    testComputeStatusRespectsCustomGlobs,
    testFormatStatusBar,
    testBuildAiuInjectionBlockUninitialized,
    testBuildAiuInjectionBlockClean,
    testBuildAiuInjectionBlockWithFiles,
    testBuildAiuInjectionBlockHasAgentRules,
    testBuildAiuInjectionBlockProjectScoped,
    testBuildAiuInjectionBlockUninitializedScoped,
    testInjectMarkedBlockIdempotent,
    testInjectMarkedBlockUpdatesInPlace,
    testHookInstallerInstall,
    testHookInstallerReinstallIsIdempotent,
    testHookInstallerBacksUpExistingHook,
    testHookInstallerUninstallRestoresBackup,
    testHookInstallerUninstallNoBackup,
    testHookInstallerUninstallNoop,
    testHookInstallerRejectsNonGit,
    testHookIntegrationNoMetaIsNoop,
    testHookIntegrationCleanCommitPasses,
    testHookIntegrationBlocksMissingSidecar,
    testHookIntegrationBlocksStaleSidecar,
    testHookIntegrationOrphanSidecarDeletion,
    testHookIntegrationPairedDeletionPasses,
    testBuildTooltip,
];

let failed = 0;
for (const t of tests) {
    try {
        t();
    } catch (err) {
        failed++;
        console.error(`FAIL ${t.name}: ${err.message}`);
        if (process.env.VERBOSE) console.error(err.stack);
    }
}

if (failed > 0) {
    console.error(`${failed} of ${tests.length} understanding tests failed`);
    process.exit(1);
}
console.log(`understanding tests passed (${tests.length})`);
