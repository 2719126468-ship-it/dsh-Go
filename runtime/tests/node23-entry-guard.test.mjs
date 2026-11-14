// Semantics of the entry guard that runtime/patches/node23-import-meta-main.diff installs.
// Node 23 answers import.meta.main with undefined, so only the ?? side decides there; Node 24
// answers with a boolean and ?? never evaluates the guard. The helper is written out here and
// asserted to appear verbatim in the shipped diff, so the two cannot drift apart. The guard is
// compared from the entry module itself, as it is in bin.js and runner.js.
//   node --test runtime/tests/node23-entry-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const diff = readFileSync(new URL('../patches/node23-import-meta-main.diff', import.meta.url), 'utf8');
const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
const removed = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1));

const GUARD = [
    'function dshGoIsMainEntry() {',
    '\ttry {',
    '\t\tconst entry = process.argv[1];',
    '\t\treturn entry !== undefined && import.meta.url === pathToFileURL(entry).href;',
    '\t} catch {',
    '\t\treturn false;',
    '\t}',
    '}',
];

test('the shipped diff installs this guard in both entry points and drops nothing else', () => {
    assert.deepEqual(removed, ['if (import.meta.main) await runCli();', 'if (import.meta.main) {'],
                     'only the two guards are replaced');
    assert.equal(added.filter((l) => l.startsWith('import { pathToFileURL } from')).length, 2,
                 'one node:url import per patched file');
    for (const line of GUARD) {
        assert.equal(added.filter((l) => l === line).length, 2, line);
    }
    assert.equal(added.filter((l) => l.includes('if (import.meta.main ?? dshGoIsMainEntry())')).length, 2,
                 'bin.js and runner.js guards both rewritten');
});

const directory = mkdtempSync(join(tmpdir(), 'node23-guard-'));
test.after(() => rmSync(directory, { recursive: true, force: true }));

// The shape the patch produces: the guard lives in the entry module, next to the CLI call.
// [1] is the real Node 24 answer, [2] the Node 23 answer for the same script.
writeFileSync(join(directory, 'guard-entry.mjs'), [
    '#!/usr/bin/env node',
    'import { pathToFileURL } from "node:url";',
    ...GUARD,
    'const answers = [];',
    'if (import.meta.main ?? dshGoIsMainEntry()) answers.push("node24");',
    'if (undefined ?? dshGoIsMainEntry()) answers.push("node23");',
    'console.log(JSON.stringify({ answers, argv1IsEntry: process.argv[1] !== undefined }));',
    'export { dshGoIsMainEntry };',
    '',
].join('\n'));
// The same guard in a module that is only imported: it must answer false on Node 23.
const LIB = join(directory, 'guard-lib.mjs');
writeFileSync(LIB, [
    'import { pathToFileURL } from "node:url";',
    ...GUARD,
    'export { dshGoIsMainEntry };',
    '',
].join('\n'));

test('as the entry script the CLI body runs on Node 24 and on Node 23', () => {
    const entry = join(directory, 'guard-entry.mjs');
    const run = spawnSync(process.execPath, [entry], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const got = JSON.parse(run.stdout.trim());
    assert.deepEqual(got.answers, ['node24', 'node23'],
                     'without the guard Node 23 answers neither');
});

test('imported rather than run, the guard stays off, so no CLI boots', async () => {
    // This test file, not LIB, is process.argv[1]: the imported module is not the entry script.
    const { dshGoIsMainEntry } = await import(new URL('file://' + LIB).href);
    assert.equal(dshGoIsMainEntry(), false, 'Node 23 with an imported module must not boot the CLI');
});
