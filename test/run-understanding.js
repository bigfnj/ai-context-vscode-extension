const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const u = require('../src/understanding');

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
