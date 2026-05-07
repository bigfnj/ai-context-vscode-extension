// AI_UNDERSTANDING — schema v1 implementation.
// Spec: AI_UNDERSTANDING_FORMAT.md

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const MASS_EDIT_CAP = 1 / 3; // §7 cross-entry rule 1

const REQUIRED_ENTRY_FIELDS = {
    schema: 'integer',
    path: 'string',
    sha1: 'string',
    purpose: 'string',
    exports: 'array',
    imports: 'array',
    called_by: 'array',
    calls_out_to: 'array',
    invariants: 'array',
    gotchas: 'array',
};
const OPTIONAL_ENTRY_FIELDS = {
    key_functions: 'object-array',
};
const ALLOWED_ENTRY_KEYS = new Set([
    ...Object.keys(REQUIRED_ENTRY_FIELDS),
    ...Object.keys(OPTIONAL_ENTRY_FIELDS),
]);

const REQUIRED_META_FIELDS = {
    schema: 'integer',
    project: 'string',
    last_audit_commit: 'string',
    last_audit_at: 'string',
    generator: 'string',
    overview: 'string',
    frameworks: 'array',
    tracked_globs: 'object',
    graph: 'string',
};
const OPTIONAL_META_FIELDS = {
    test_command: 'string',
};
const ALLOWED_META_KEYS = new Set([
    ...Object.keys(REQUIRED_META_FIELDS),
    ...Object.keys(OPTIONAL_META_FIELDS),
]);

const DEFAULT_TRACKED_GLOBS = {
    include: [
        'src/**',
        'test/**',
        'tests/**',
        '__tests__/**',
        'package.json',
        '*.config.{js,ts,json,mjs,cjs}',
        'tsconfig.json',
        'vite.config.*',
        'webpack.config.*',
    ],
    exclude: [
        'node_modules/**',
        'dist/**',
        'build/**',
        'out/**',
        'coverage/**',
        '*.lock',
        'package-lock.json',
        'yarn.lock',
        'pnpm-lock.yaml',
        '**/*.png',
        '**/*.jpg',
        '**/*.jpeg',
        '**/*.gif',
        '**/*.svg',
        '**/*.ico',
        '**/*.woff',
        '**/*.woff2',
        '**/*.ttf',
        '**/*.eot',
        '.vscode-test/**',
        '.git/**',
    ],
};

// ─── Path helpers ────────────────────────────────────────────────────────────

function aiuRoot(projectRoot) {
    return path.join(projectRoot, 'AI_UNDERSTANDING');
}

function aiuPathFor(projectRoot, sourceRelPath) {
    const rel = toPosix(sourceRelPath);
    return path.join(aiuRoot(projectRoot), rel + '.aiu.json');
}

function metaPathFor(projectRoot) {
    return path.join(aiuRoot(projectRoot), '_meta.json');
}

function toPosix(p) {
    return String(p).split(path.sep).join('/');
}

function ensureSafeRelPath(relPath) {
    const p = toPosix(relPath);
    if (!p) throw new Error('Empty relative path.');
    if (path.isAbsolute(p)) throw new Error(`Absolute path not allowed: ${p}`);
    if (p.split('/').some(seg => seg === '..')) {
        throw new Error(`Path traversal not allowed: ${p}`);
    }
    return p;
}

// ─── Hashing ─────────────────────────────────────────────────────────────────

function sha1(content) {
    return crypto.createHash('sha1').update(content).digest('hex');
}

function sha1File(absPath) {
    return sha1(fs.readFileSync(absPath));
}

// ─── Glob matching ───────────────────────────────────────────────────────────

function escapeRegex(s) {
    return s.replace(/[.+^$()|\\[\]]/g, '\\$&');
}

function globToRegex(glob) {
    let re = '^';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                if (glob[i + 2] === '/') {
                    re += '(?:[^/]+/)*';
                    i += 2;
                } else {
                    re += '.*';
                    i += 1;
                }
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else if (c === '{') {
            const end = glob.indexOf('}', i);
            if (end === -1) { re += '\\{'; continue; }
            const opts = glob.slice(i + 1, end).split(',').map(escapeRegex);
            re += '(?:' + opts.join('|') + ')';
            i = end;
        } else {
            re += escapeRegex(c);
        }
    }
    return new RegExp(re + '$');
}

function matchesAny(relPath, globs) {
    if (!Array.isArray(globs)) return false;
    const p = toPosix(relPath);
    for (const g of globs) {
        if (globToRegex(g).test(p)) return true;
    }
    return false;
}

// ─── Validation ──────────────────────────────────────────────────────────────

function typeMatches(value, expected) {
    switch (expected) {
        case 'string': return typeof value === 'string';
        case 'integer': return Number.isInteger(value);
        case 'array': return Array.isArray(value);
        case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
        case 'object-array':
            return Array.isArray(value)
                && value.every(v => v !== null && typeof v === 'object' && !Array.isArray(v));
        default: return false;
    }
}

function validateEntry(entry, sourceRelPath) {
    const errors = [];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        return { ok: false, errors: ['entry must be an object'] };
    }

    for (const [field, type] of Object.entries(REQUIRED_ENTRY_FIELDS)) {
        if (!(field in entry)) {
            errors.push(`missing required field: ${field}`);
        } else if (!typeMatches(entry[field], type)) {
            errors.push(`field ${field} must be ${type}`);
        }
    }

    for (const [field, type] of Object.entries(OPTIONAL_ENTRY_FIELDS)) {
        if (field in entry && !typeMatches(entry[field], type)) {
            errors.push(`field ${field} must be ${type}`);
        }
    }

    for (const key of Object.keys(entry)) {
        if (!ALLOWED_ENTRY_KEYS.has(key)) {
            errors.push(`unknown field: ${key}`);
        }
    }

    if (entry.schema !== undefined && entry.schema !== SCHEMA_VERSION) {
        errors.push(`schema must equal ${SCHEMA_VERSION} (got ${entry.schema})`);
    }

    if (typeof entry.sha1 === 'string' && !/^[0-9a-f]{40}$/.test(entry.sha1)) {
        errors.push('sha1 must be 40 lowercase hex characters');
    }

    if (typeof entry.purpose === 'string' && entry.purpose.length === 0) {
        errors.push('purpose must be non-empty');
    }

    if (sourceRelPath !== undefined && typeof entry.path === 'string') {
        const expected = toPosix(sourceRelPath);
        if (entry.path !== expected) {
            errors.push(`path field "${entry.path}" does not match location "${expected}"`);
        }
    }

    if (Array.isArray(entry.key_functions)) {
        entry.key_functions.forEach((kf, i) => {
            if (typeof kf.name !== 'string' || !kf.name) {
                errors.push(`key_functions[${i}].name must be a non-empty string`);
            }
            if (typeof kf.summary !== 'string' || !kf.summary) {
                errors.push(`key_functions[${i}].summary must be a non-empty string`);
            }
        });
    }

    return errors.length ? { ok: false, errors } : { ok: true };
}

function validateMeta(meta) {
    const errors = [];
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
        return { ok: false, errors: ['meta must be an object'] };
    }

    for (const [field, type] of Object.entries(REQUIRED_META_FIELDS)) {
        if (!(field in meta)) {
            errors.push(`missing required field: ${field}`);
        } else if (!typeMatches(meta[field], type)) {
            errors.push(`field ${field} must be ${type}`);
        }
    }

    for (const [field, type] of Object.entries(OPTIONAL_META_FIELDS)) {
        if (field in meta && !typeMatches(meta[field], type)) {
            errors.push(`field ${field} must be ${type}`);
        }
    }

    for (const key of Object.keys(meta)) {
        if (!ALLOWED_META_KEYS.has(key)) {
            errors.push(`unknown field: ${key}`);
        }
    }

    if (meta.schema !== undefined && meta.schema !== SCHEMA_VERSION) {
        errors.push(`schema must equal ${SCHEMA_VERSION} (got ${meta.schema})`);
    }

    if (meta.tracked_globs && typeof meta.tracked_globs === 'object') {
        if (!Array.isArray(meta.tracked_globs.include)) {
            errors.push('tracked_globs.include must be an array');
        }
        if (!Array.isArray(meta.tracked_globs.exclude)) {
            errors.push('tracked_globs.exclude must be an array');
        }
    }

    if (Array.isArray(meta.frameworks)) {
        meta.frameworks.forEach((fw, i) => {
            if (!fw || typeof fw !== 'object' || typeof fw.name !== 'string' || !fw.name) {
                errors.push(`frameworks[${i}] must be an object with a non-empty name`);
            }
        });
    }

    return errors.length ? { ok: false, errors } : { ok: true };
}

// op = { writes: string[], deletes: string[], existingCount: number, bootstrap?: boolean }
// Enforces the §7 cross-entry mass-edit cap. Path-mirror is enforced via
// ensureSafeRelPath at write-time; orphan pairing is the hook's job.
function validateOperation(op) {
    const errors = [];
    const writes = Array.isArray(op.writes) ? op.writes : [];
    const deletes = Array.isArray(op.deletes) ? op.deletes : [];
    const existing = Number.isInteger(op.existingCount) ? op.existingCount : 0;

    if (op.bootstrap) return { ok: true };

    if (existing > 0) {
        const touched = writes.length + deletes.length;
        const ratio = touched / existing;
        if (ratio > MASS_EDIT_CAP) {
            errors.push(
                `mass-edit cap exceeded: ${touched}/${existing} (${(ratio * 100).toFixed(1)}%) ` +
                `> ${(MASS_EDIT_CAP * 100).toFixed(1)}%`
            );
        }
    }

    return errors.length ? { ok: false, errors } : { ok: true };
}

// ─── Per-file CRUD ───────────────────────────────────────────────────────────

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(absPath) {
    const text = fs.readFileSync(absPath, 'utf8');
    return JSON.parse(text);
}

function writeJson(absPath, value) {
    ensureDir(path.dirname(absPath));
    fs.writeFileSync(absPath, JSON.stringify(value, null, 2) + '\n');
}

function readEntry(projectRoot, sourceRelPath) {
    const rel = ensureSafeRelPath(sourceRelPath);
    return readJson(aiuPathFor(projectRoot, rel));
}

function writeEntry(projectRoot, sourceRelPath, entry) {
    const rel = ensureSafeRelPath(sourceRelPath);
    const result = validateEntry(entry, rel);
    if (!result.ok) {
        throw new Error(`Invalid entry for ${rel}:\n  - ${result.errors.join('\n  - ')}`);
    }
    writeJson(aiuPathFor(projectRoot, rel), entry);
}

function deleteEntry(projectRoot, sourceRelPath) {
    const rel = ensureSafeRelPath(sourceRelPath);
    const abs = aiuPathFor(projectRoot, rel);
    if (!fs.existsSync(abs)) return false;
    fs.unlinkSync(abs);
    return true;
}

function readMeta(projectRoot) {
    return readJson(metaPathFor(projectRoot));
}

function writeMeta(projectRoot, meta) {
    const result = validateMeta(meta);
    if (!result.ok) {
        throw new Error(`Invalid _meta.json:\n  - ${result.errors.join('\n  - ')}`);
    }
    writeJson(metaPathFor(projectRoot), meta);
}

function listEntries(projectRoot) {
    const root = aiuRoot(projectRoot);
    if (!fs.existsSync(root)) return [];
    const out = [];
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop();
        for (const name of fs.readdirSync(dir)) {
            const abs = path.join(dir, name);
            const stat = fs.statSync(abs);
            if (stat.isDirectory()) { stack.push(abs); continue; }
            if (name === '_meta.json') continue;
            if (!name.endsWith('.aiu.json')) continue;
            const rel = toPosix(path.relative(root, abs)).replace(/\.aiu\.json$/, '');
            out.push(rel);
        }
    }
    return out.sort();
}

// ─── Skeleton / bootstrap ────────────────────────────────────────────────────

function makeSkeletonEntry(sourceRelPath, sha1Hex) {
    return {
        schema: SCHEMA_VERSION,
        path: toPosix(sourceRelPath),
        sha1: sha1Hex,
        purpose: 'TODO',
        exports: [],
        imports: [],
        called_by: [],
        calls_out_to: [],
        invariants: [],
        gotchas: [],
    };
}

function makeSkeletonMeta(opts) {
    const o = opts || {};
    return {
        schema: SCHEMA_VERSION,
        project: o.project || '',
        last_audit_commit: o.last_audit_commit || '',
        last_audit_at: o.last_audit_at || '',
        generator: o.generator || '',
        overview: o.overview || '',
        frameworks: Array.isArray(o.frameworks) ? o.frameworks : [],
        tracked_globs: o.tracked_globs || {
            include: DEFAULT_TRACKED_GLOBS.include.slice(),
            exclude: DEFAULT_TRACKED_GLOBS.exclude.slice(),
        },
        graph: o.graph || '',
    };
}

function detectFrameworks(projectRoot) {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) return [];
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { return []; }
    const frameworks = [];
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    if (pkg.engines && pkg.engines.vscode) {
        frameworks.push({ name: 'VS Code Extension API', version: pkg.engines.vscode });
    }
    if (pkg.engines && pkg.engines.node) {
        frameworks.push({ name: 'Node.js', version: pkg.engines.node });
    } else if (Object.keys(deps).length || pkg.main) {
        frameworks.push({ name: 'Node.js' });
    }
    return frameworks;
}

function listTrackedSourceFiles(projectRoot, trackedGlobs) {
    const include = (trackedGlobs && trackedGlobs.include) || DEFAULT_TRACKED_GLOBS.include;
    const exclude = (trackedGlobs && trackedGlobs.exclude) || DEFAULT_TRACKED_GLOBS.exclude;
    const out = [];
    const stack = [''];
    while (stack.length) {
        const rel = stack.pop();
        const abs = rel ? path.join(projectRoot, rel) : projectRoot;
        let entries;
        try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
        for (const ent of entries) {
            const childRel = rel ? toPosix(path.join(rel, ent.name)) : ent.name;
            if (ent.isDirectory()) {
                // Prune excluded directory subtrees early.
                if (matchesAny(childRel + '/', exclude)) continue;
                if (matchesAny(childRel, exclude)) continue;
                if (childRel === 'AI_UNDERSTANDING') continue;
                stack.push(childRel);
                continue;
            }
            if (!ent.isFile()) continue;
            if (matchesAny(childRel, exclude)) continue;
            if (!matchesAny(childRel, include)) continue;
            out.push(childRel);
        }
    }
    return out.sort();
}

function generateSkeleton(projectRoot, opts) {
    const o = opts || {};
    const trackedGlobs = o.tracked_globs || DEFAULT_TRACKED_GLOBS;
    const files = listTrackedSourceFiles(projectRoot, trackedGlobs);

    const meta = makeSkeletonMeta({
        project: o.project || readPackageName(projectRoot) || path.basename(projectRoot),
        last_audit_commit: o.last_audit_commit || '',
        last_audit_at: o.last_audit_at || '',
        generator: o.generator || '',
        overview: o.overview || '',
        frameworks: o.frameworks || detectFrameworks(projectRoot),
        tracked_globs: trackedGlobs,
        graph: o.graph || '',
    });

    writeMeta(projectRoot, meta);

    for (const rel of files) {
        const hash = sha1File(path.join(projectRoot, rel));
        const entry = makeSkeletonEntry(rel, hash);
        writeEntry(projectRoot, rel, entry);
    }

    return { files, meta };
}

// ─── Status / staleness ──────────────────────────────────────────────────────

// Returns:
//   {
//     initialized: bool,         // _meta.json exists
//     fresh: string[],           // tracked, sidecar present, sha1 matches
//     stale: string[],           // tracked, sidecar present, sha1 differs
//     untracked: string[],       // tracked, sidecar missing
//     orphan: string[],          // sidecar present, source missing (project-rel paths)
//     trackedGlobs: object,      // resolved globs (from meta if present, else defaults)
//   }
//
// Counts are derivable from array lengths. "AIU-clean" when stale/untracked/orphan
// are all empty and initialized is true.
function computeStatus(projectRoot) {
    const result = {
        initialized: fs.existsSync(metaPathFor(projectRoot)),
        fresh: [],
        stale: [],
        untracked: [],
        orphan: [],
        trackedGlobs: null,
    };

    let trackedGlobs = DEFAULT_TRACKED_GLOBS;
    if (result.initialized) {
        try {
            const meta = readMeta(projectRoot);
            if (meta && meta.tracked_globs) trackedGlobs = meta.tracked_globs;
        } catch { /* fall through to defaults */ }
    }
    result.trackedGlobs = trackedGlobs;

    const sourceFiles = listTrackedSourceFiles(projectRoot, trackedGlobs);
    const sourceSet = new Set(sourceFiles);
    const entryPaths = listEntries(projectRoot);
    const entrySet = new Set(entryPaths);

    for (const rel of sourceFiles) {
        if (!entrySet.has(rel)) {
            result.untracked.push(rel);
            continue;
        }
        let entrySha;
        try { entrySha = readEntry(projectRoot, rel).sha1; }
        catch { result.untracked.push(rel); continue; }
        const fileSha = sha1File(path.join(projectRoot, rel));
        if (entrySha === fileSha) result.fresh.push(rel);
        else result.stale.push(rel);
    }

    for (const rel of entryPaths) {
        if (!sourceSet.has(rel)) result.orphan.push(rel);
    }

    return result;
}

function isClean(status) {
    return !!status
        && status.initialized
        && status.stale.length === 0
        && status.untracked.length === 0
        && status.orphan.length === 0;
}

// One-line summary suitable for a status bar.
//   not initialized        → "AIU: not initialized"
//   clean                  → "AIU: clean"
//   needs work             → "AIU: 3 stale, 1 untracked"
function formatStatusBar(status) {
    if (!status) return 'AIU: ?';
    if (!status.initialized) return 'AIU: not initialized';
    if (isClean(status)) return 'AIU: clean';
    const parts = [];
    if (status.stale.length)     parts.push(`${status.stale.length} stale`);
    if (status.untracked.length) parts.push(`${status.untracked.length} untracked`);
    if (status.orphan.length)    parts.push(`${status.orphan.length} orphan`);
    return `AIU: ${parts.join(', ')}`;
}

function readPackageName(projectRoot) {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) return null;
    try { return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).name || null; }
    catch { return null; }
}

module.exports = {
    SCHEMA_VERSION,
    MASS_EDIT_CAP,
    DEFAULT_TRACKED_GLOBS,

    aiuRoot,
    aiuPathFor,
    metaPathFor,

    sha1,
    sha1File,

    globToRegex,
    matchesAny,

    validateEntry,
    validateMeta,
    validateOperation,

    readEntry,
    writeEntry,
    deleteEntry,
    readMeta,
    writeMeta,
    listEntries,

    makeSkeletonEntry,
    makeSkeletonMeta,
    detectFrameworks,
    listTrackedSourceFiles,
    generateSkeleton,

    computeStatus,
    isClean,
    formatStatusBar,
};
