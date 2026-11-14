// dsh-go: file-lock fallback for @deepseek-ai/node-addon-system's native flock binding.
// npm publishes that addon for linux-x64, linux-arm64, darwin and android-arm64 only, so the
// 32-bit ARM runtime (linux-arm) cannot resolve one and SessionWriteLease.acquire would fail on
// every session write. runtime/patches/node-addon-system-armv7-flock.diff installs this file
// beside flock.js and reaches it only when require.resolve throws, so arm64/x86_64 keep the
// native binding and behave exactly as before. One engine per install, owned by DshProcess, is
// why an O_EXCL lock file is enough here: same success, same EAGAIN-on-contention contract, and
// the stale-lock takeover below replaces the release a real flock gets on descriptor closing.
// CommonJS because flock.js reaches it through its own createRequire.
'use strict';
const fs = require('node:fs');

/** EAGAIN's errno on every Linux target; flock.js maps it back to the code name callers branch on. */
const EAGAIN_ERRNO = 11;
/** A lock file no younger than this whose holder is gone counts as stale. */
const STALE_AFTER_MS = 30000;

const ERRNO = {EPERM: 1, ENOENT: 2, EACCES: 13, EROFS: 30};

/** The lock file guarding one target: beside it, never in front of it. */
function lockPathFor(target) {
    return target + '.dsh-go-flock';
}

/**
 * Read the holder recorded in a lock file.
 * @returns {{pid?: number, ageMs?: number}}; {} for a missing file or an untrustworthy pid.
 */
function holderOf(path) {
    try {
        const pid = Number.parseInt(fs.readFileSync(path, 'utf8').trim(), 10);
        if (!Number.isInteger(pid) || pid <= 0)
            return {};
        return {pid, ageMs: Date.now() - fs.statSync(path).mtimeMs};
    }
    catch {
        return {};
    }
}

/** Signal 0 only asks about existence, so EPERM still means the process is alive. */
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code !== 'ESRCH';
    }
}

/**
 * Take the file lock guarding [target].
 * @param target - absolute path of the file a real flock would be held on.
 * @returns 0 when the lock is ours, EAGAIN while another live process holds it.
 * @throws when the lock file can be neither created nor inspected: a real filesystem failure.
 */
function tryLockFile(target) {
    const path = lockPathFor(target);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        let handle;
        try {
            handle = fs.openSync(path, 'wx', 0o600);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            const held = holderOf(path);
            // Re-acquiring for our own pid succeeds on purpose: within one process the
            // in-process write claim already excludes every other writer, as flock.js's lease
            // notes for the browser worker's stub.
            if (held.pid === process.pid)
                return 0;
            const reclaimable = held.pid === undefined
                ? true // unreadable or bogus content: nobody claims it
                : held.ageMs >= STALE_AFTER_MS && !isAlive(held.pid);
            if (!reclaimable)
                return EAGAIN_ERRNO;
            try {
                fs.unlinkSync(path);
            }
            catch {
                /* a competing stealer won the race; the O_EXCL open retries */
            }
            continue;
        }
        try {
            fs.writeFileSync(handle, process.pid + '\n');
        }
        finally {
            fs.closeSync(handle);
        }
        return 0;
    }
    // Three losses against a stealer is a pathological race, not contention: surface it.
    return EAGAIN_ERRNO;
}

/**
 * The native binding's contract: lock the file an open descriptor refers to.
 * @param fd - descriptor owned by the caller; never opened, duplicated or closed here.
 * @param resolve - receives 0 or an errno, exactly like the addon's callback; never rejects.
 */
function tryLock(fd, resolve) {
    try {
        // /proc/self/fd names the open file description, so the same inode and device the
        // caller verifies after locking are the ones this lock guards.
        resolve(tryLockFile(fs.realpathSync('/proc/self/fd/' + fd)));
    }
    catch (error) {
        resolve(ERRNO[error.code] !== undefined ? ERRNO[error.code] : EAGAIN_ERRNO);
    }
}

module.exports = {tryLock, tryLockFile, holderOf, isAlive, lockPathFor, EAGAIN_ERRNO, STALE_AFTER_MS};
