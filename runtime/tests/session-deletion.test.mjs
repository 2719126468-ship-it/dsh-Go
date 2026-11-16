import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createDeletionSeam } from "../session-deletion/core.mjs";

const ID = "session-delete-test";

async function exists(path) {
  try { await access(path); return true; }
  catch { return false; }
}

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), "dsh-go-delete-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, "sessions");
  const dir = join(root, "project", "session");
  await mkdir(dir, { recursive: true });
  const log = join(dir, "session.jsonl");
  await writeFile(log, '{"type":"session"}\n');

  const storage = {
    root,
    ctx: {
      get(name) {
        if (name === "sessions") return { list: () => [], get: () => undefined };
        return undefined;
      },
      emit() {},
    },
    tracker: { writers: new Map(), claimWrite() {}, releaseClaim() {} },
    coldLogMemo: new Map(),
    migrationPreparations: new Map(),
    async list() { return []; },
    async findLog() { return { currentPath: log }; },
    async readGenerationHeader() {
      return { header: { id: ID, origin: "user", delegationDepth: 0 } };
    },
    async requireStoredLog() { return { events: [] }; },
  };
  const acquire = async () => ({ async release() {} });
  const parseGeneration = (name, codec) => name === "session.jsonl" && codec === "none" ? 0 : undefined;
  const notFound = () => Object.assign(new Error("not found"), { code: "not-found" });
  return { temp, root, dir, log, storage, seam: createDeletionSeam(storage, { acquire, parseGeneration, notFound }) };
}

const hooks = (overrides = {}) => ({
  prepare: async () => {},
  inspectTasks: async () => false,
  cleanup: async () => {},
  ...overrides,
});

test("related reminders are checked before disposing the idle agent", async (t) => {
  const f = await fixture(t);
  let prepared = 0;
  await assert.rejects(
    f.seam.delete(ID, hooks({
      prepare: async () => { prepared++; },
      inspectTasks: async () => true,
    })),
    (error) => error.code === "session-related",
  );
  assert.equal(prepared, 0);
  assert.equal(await exists(f.log), true);
  assert.equal(f.seam.deleted(ID), false);
});

test("session log directories outside the configured root are rejected", async (t) => {
  const f = await fixture(t);
  const outsideDir = join(f.temp, "outside", "session");
  await mkdir(outsideDir, { recursive: true });
  const outsideLog = join(outsideDir, "session.jsonl");
  await writeFile(outsideLog, '{"type":"session"}\n');
  f.storage.findLog = async () => ({ currentPath: outsideLog });

  await assert.rejects(
    f.seam.delete(ID, hooks()),
    (error) => error.code === "failed",
  );
  assert.equal(await exists(outsideLog), true);
  assert.equal(f.seam.deleted(ID), false);
});

test("successful deletion writes a tombstone and removes session log files", async (t) => {
  const f = await fixture(t);
  await f.seam.delete(ID, hooks());
  assert.equal(f.seam.deleted(ID), true);
  assert.equal(await exists(f.log), false);
});

test("a failed post-tombstone cleanup can be retried without reopening the session", async (t) => {
  const f = await fixture(t);
  let cleanupCalls = 0;
  let prepareCalls = 0;
  let inspectCalls = 0;
  const first = hooks({
    prepare: async () => { prepareCalls++; },
    inspectTasks: async () => { inspectCalls++; return false; },
    cleanup: async () => {
      cleanupCalls++;
      if (cleanupCalls === 1) throw new Error("simulated cleanup failure");
    },
  });
  await assert.rejects(f.seam.delete(ID, first), /simulated cleanup failure/);
  assert.equal(f.seam.deleted(ID), true);
  assert.equal(await exists(f.log), false);

  await f.seam.delete(ID, hooks({
    prepare: async () => { prepareCalls++; },
    inspectTasks: async () => { inspectCalls++; return false; },
    cleanup: async () => { cleanupCalls++; },
  }));
  assert.equal(cleanupCalls, 2);
  assert.equal(prepareCalls, 1);
  assert.equal(inspectCalls, 2);
  assert.equal(f.seam.deleted(ID), true);
});
