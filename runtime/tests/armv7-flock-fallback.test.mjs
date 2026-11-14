// Unit tests for the flock fallback that runtime/patches/node-addon-system-armv7-flock.diff
// installs beside @deepseek-ai/node-addon-system/lib/flock.js for the 32-bit ARM runtime.
//   node --test runtime/tests/armv7-flock-fallback.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSystemErrorName } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const { tryLockFile, tryLock, holderOf, isAlive, lockPathFor, EAGAIN_ERRNO, STALE_AFTER_MS } =
    await import(new URL('../flock-fallback/dsh-go-flock.cjs', import.meta.url).href);

const directory = mkdtempSync(join(tmpdir(), 'armv7-flock-'));
test.after(() => rmSync(directory, { recursive: true, force: true }));

let counter = 0;
function target() {
    const path = join(directory, 'session-' + counter + '.lock');
    counter += 1;
    writeFileSync(path, '');
    return path;
}

/** A child spawnSync already reaped: the kernel has forgotten it, so the holder is dead. */
function deadPid() {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const run = spawnSync(process.execPath, ['-e', 'void 0'], { stdio: 'ignore' });
        if (run.pid !== undefined && !isAlive(run.pid))
            return run.pid;
    }
    assert.fail('no reapable child pid on this host');
}

test('the lock file sits beside the target and records our pid', () => {
    const path = target();
    assert.equal(tryLockFile(path), 0);
    assert.equal(lockPathFor(path), path + '.dsh-go-flock');
    assert.equal(readFileSync(lockPathFor(path), 'utf8').trim(), String(process.pid));
    assert.equal(holderOf(lockPathFor(path)).pid, process.pid);
});

test('the same pid re-acquires, so one process cannot deadlock on its own claim', () => {
    const path = target();
    assert.equal(tryLockFile(path), 0);
    assert.equal(tryLockFile(path), 0, 'a second acquire by this pid must succeed');
});

test('a live holder under another pid is contention, reported with EAGAIN errno', () => {
    const path = target();
    assert.ok(isAlive(process.ppid), 'the parent pid must be alive for this fixture');
    writeFileSync(lockPathFor(path), process.ppid + '\n');
    const errno = tryLockFile(path);
    assert.equal(errno, EAGAIN_ERRNO);
    // SessionWriteLease.acquire branches on the name, not the number.
    assert.equal(getSystemErrorName(-errno), 'EAGAIN');
    assert.equal(readFileSync(lockPathFor(path), 'utf8').trim(), String(process.ppid),
                 'contention must not touch a lock another process holds');
});

test('a dead holder keeps the lock only until STALE_AFTER_MS', () => {
    const path = target();
    const lock = lockPathFor(path);
    writeFileSync(lock, deadPid() + '\n');
    assert.equal(tryLockFile(path), EAGAIN_ERRNO, 'a fresh lock file is not stale yet');
    const aged = (Date.now() - STALE_AFTER_MS - 1000) / 1000;
    utimesSync(lock, aged, aged);
    assert.equal(tryLockFile(path), 0, 'a dead holder must not block writes forever');
    assert.equal(readFileSync(lock, 'utf8').trim(), String(process.pid));
});

test('untrustworthy lock content is reclaimed at once', () => {
    const path = target();
    const lock = lockPathFor(path);
    writeFileSync(lock, 'not-a-pid\n');
    assert.equal(tryLockFile(path), 0);
    writeFileSync(lock, '-7\n');
    assert.equal(tryLockFile(path), 0);
    assert.equal(readFileSync(lock, 'utf8').trim(), String(process.pid));
});

test('tryLock names the lock through the descriptor, the way flock does', () => {
    const path = target();
    const fd = openSync(path, 'w');
    try {
        let errno = -1;
        tryLock(fd, (code) => { errno = code; });
        assert.equal(errno, 0);
        const owned = realpathSync(join('/proc/self/fd', String(fd)));
        assert.equal(owned, realpathSync(path));
        assert.equal(readFileSync(lockPathFor(owned), 'utf8').trim(), String(process.pid));
        // Closing the descriptor releases a real flock; the file lock must survive no longer
        // than that would, so a second acquire by the same pid still succeeds here.
        closeSync(fd);
        assert.equal(tryLockFile(path), 0);
    } finally {
        if (fd !== undefined) { /* closed above */ }
    }
});

test('tryLock resolves an errno instead of rejecting, matching the addon contract', () => {
    const calls = [];
    tryLock(1 << 20, (code) => calls.push(code));
    assert.equal(calls.length, 1, 'resolve runs exactly once');
    assert.equal(typeof calls[0], 'number');
    assert.ok(calls[0] > 0, 'an unusable descriptor reports a positive errno');
});

test('the shipped patch catches only addon resolution', () => {
    const diff = readFileSync(new URL('../patches/node-addon-system-armv7-flock.diff', import.meta.url), 'utf8');
    const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
    assert.equal(added.filter((l) => l.includes("require('./dsh-go-flock.cjs')")).length, 1);
    assert.equal(added.filter((l) => l.includes('require(join(dirname(manifest)')).length, 0,
                 'the addon load stays outside the catch: a broken binding must still throw');
    assert.equal(added.filter((l) => l.includes('require.resolve(')).length, 1,
                 'only resolution is wrapped');
});

test('the shipped patch reaches the fallback only when the addon cannot load', () => {
    const diff = readFileSync(resolve(HERE, '..', 'patches', 'node-addon-system-armv7-flock.diff'), 'utf8');
    assert.match(diff, /^\+    try {$/m, 'the addon path stays inside try');
    assert.match(diff, /^\+        binding = require\('\.\/dsh-go-flock\.cjs'\);$/m);
    assert.equal(diff.includes('-    const manifest = require.resolve('), true,
                 'only the two addon lines move');
    // The companion is the file patch-dsh installs beside flock.js.
    readFileSync(resolve(HERE, '..', 'flock-fallback', 'dsh-go-flock.cjs'), 'utf8');
});
