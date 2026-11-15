// Current DSH 0.2.2-rc.1 Host-wide Schedule API authorization regressions.
// DSH_PREFIX points at the isolated patched current package tree.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const prefix = process.env.DSH_PREFIX;
if (!prefix) throw Error('Set DSH_PREFIX to the isolated current DSH package tree');
const root = resolve(prefix, 'node_modules/@deepseek-ai');
const schedulePath = join(root, 'dsh-schedule/lib/index.js');
const toolPath = join(root, 'dsh-tool-schedule/lib/index.js');
const source = await readFile(schedulePath, 'utf8');
assert.match(source, /dshGoAuthorize\(actorSessionId, record, "create", signal\)/);
assert.match(source, /dshGoAuthorize\(actorSessionId, preview\.record, "update", signal\)/);
const { ScheduleService } = await import(pathToFileURL(schedulePath));
const { apply: applyTools } = await import(pathToFileURL(toolPath));

const approveLabel = '授权 / Authorize';
const makeSignal = () => new AbortController().signal;
const isAuthorizationError = error => error?.code === 'schedule-authorization-required';
const tick = () => new Promise(resolve => setImmediate(resolve));
const grant = request => ({ answers: [{ id: request.questions[0].id, selected: [approveLabel] }] });
const reviewed = request => JSON.parse(request.questions[0].question.split('\n\n').at(-1));
const createRequest = () => ({
  title: 'Synthetic task',
  prompt: 'Harmless synthetic instructions',
  timing: { kind: 'after', after_seconds: 86400 },
  target: { kind: 'session', sessionId: 'synthetic-session' },
});

function fixture({ provider = true, answer = grant, delegated = false } = {}) {
  const rows = new Map();
  const requests = [];
  const writes = [];
  const agent = {
    id: 'synthetic-session',
    options: { subagentDepth: 0 },
    session: { id: 'synthetic-session', header: { delegationDepth: delegated ? 1 : 0 } },
    ctx: { get: () => undefined },
  };
  let answerWith = answer;
  let inMutation = false;
  const questions = {
    async ask(request) {
      assert.equal(inMutation, false, 'authorization must never hold the mutation queue');
      assert.equal(request.agent, agent);
      requests.push(request);
      return answerWith(request);
    },
  };
  const table = {
    get: id => rows.get(id),
    entries: () => rows.entries(),
    async put(id, task) {
      rows.set(id, structuredClone(task));
      writes.push({ id, task: structuredClone(task) });
    },
    async delete(id) { rows.delete(id); },
  };
  const ctx = {
    get: name => name === 'userQuestions' && provider ? questions : undefined,
    agents: new Map([[agent.id, agent]]),
    sessionController: {
      async resolveAgent(id) {
        assert.equal(id, agent.id);
        return delegated ? { error: Error('delegated caller') } : { agent };
      },
    },
  };
  const service = Object.create(ScheduleService.prototype);
  Object.defineProperty(service, 'ctx', { value: ctx });
  Object.assign(service, {
    chain: Promise.resolve(),
    stopping: false,
    dshGoAuthorizationAbort: new AbortController(),
    getDomain: async () => ({ table: name => {
      assert.equal(name, 'tasks');
      return table;
    } }),
    resolveTarget: async target => target,
    validateTarget: async () => {},
    entry: task => task,
    queueNotification: () => {},
    emitChanged: () => {},
    runtime: { requestDrive() {} },
  });
  const serialize = service.serialize.bind(service);
  service.serialize = async work => {
    inMutation = true;
    try { return await serialize(work); }
    finally { inMutation = false; }
  };
  return {
    service, rows, requests, writes, agent, ctx,
    setAnswer(next) { answerWith = next; },
  };
}

test('create commits only the exact record explicitly reviewed by the root Agent', async () => {
  const f = fixture();
  const result = await f.service.create(createRequest(), f.agent.id, makeSignal());
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].purpose, 'schedule-authorization');
  assert.equal(reviewed(f.requests[0]).operation, 'create');
  assert.deepEqual(reviewed(f.requests[0]).task, result.record);
  assert.equal(f.writes.length, 1);
  assert.equal(f.requests[0].signal.aborted, true);
});

test('rejection and unavailable confirmation fail closed without a durable write', async () => {
  const denied = fixture({ answer: () => ({ answers: [] }) });
  await assert.rejects(denied.service.create(createRequest(), denied.agent.id, makeSignal()), isAuthorizationError);
  assert.equal(denied.writes.length, 0);

  const unavailable = fixture({ provider: false });
  await assert.rejects(unavailable.service.create(createRequest(), unavailable.agent.id, makeSignal()), isAuthorizationError);
  assert.equal(unavailable.writes.length, 0);

  const delegated = fixture({ delegated: true });
  await assert.rejects(delegated.service.create(createRequest(), delegated.agent.id, makeSignal()), isAuthorizationError);
  assert.equal(delegated.writes.length, 0);
});

test('edit reviews the merged candidate and commits only if the reviewed revision is unchanged', async () => {
  const f = fixture();
  const original = await f.service.create(createRequest(), f.agent.id, makeSignal());
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  f.setAnswer(() => waiting);
  const edit = f.service.edit({
    id: original.record.id,
    action: 'update',
    patch: { prompt: 'Updated harmless instructions' },
    expectedUpdatedAt: original.updatedAt,
  }, f.agent.id, makeSignal());
  await tick();
  assert.equal(f.requests.length, 2);
  assert.equal(f.writes.length, 1);
  const detail = reviewed(f.requests[1]);
  assert.equal(detail.operation, 'update');
  assert.equal(detail.task.title, original.record.title);
  assert.equal(detail.task.prompt, 'Updated harmless instructions');
  release(grant(f.requests[1]));
  const result = await edit;
  assert.equal(result.record.prompt, 'Updated harmless instructions');
  assert.equal(f.writes.length, 2);
});

test('a concurrent edit after review returns conflict and does not commit the stale candidate', async () => {
  const f = fixture();
  const original = await f.service.create(createRequest(), f.agent.id, makeSignal());
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  f.setAnswer(() => waiting);
  const edit = f.service.edit({
    id: original.record.id,
    action: 'update',
    patch: { prompt: 'Reviewed instructions' },
  }, f.agent.id, makeSignal());
  await tick();
  const current = f.rows.get(original.record.id);
  current.updatedAt = new Date(Date.now() + 1000).toISOString();
  f.rows.set(original.record.id, current);
  release(grant(f.requests[1]));
  const result = await edit;
  assert.equal(result.code, 'schedule_conflict');
  assert.equal(f.writes.length, 1);
});

test('service shutdown aborts a pending authorization and prevents late commit', async () => {
  const f = fixture();
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  f.setAnswer(() => waiting);
  const creation = f.service.create(createRequest(), f.agent.id, makeSignal());
  await tick();
  f.service.stopping = true;
  f.service.dshGoAuthorizationAbort.abort();
  await assert.rejects(creation, isAuthorizationError);
  release(grant(f.requests[0]));
  await tick();
  assert.equal(f.writes.length, 0);
});

test('the model-facing tool maps the host refusal to its declared authorization_required result', async () => {
  const f = fixture({ provider: false });
  const definitions = new Map();
  const toolContext = {
    schedule: f.service,
    tools: {
      register(definition) { definitions.set(definition.name, definition); },
      get() { return undefined; },
    },
    systemPrompt: { section() {}, getSectionOrder() { return 1; } },
    inject(_dependencies, callback) { callback(this); },
  };
  applyTools(toolContext);
  const result = await definitions.get('schedule_create').execute({
    title: 'Synthetic task',
    prompt: 'Harmless synthetic instructions',
    rrule: 'DTSTART:20991230T230000Z\nRRULE:FREQ=DAILY;COUNT=1',
    target: 'this_session',
  }, { agent: f.agent, signal: makeSignal() });
  assert.equal(result.code, 'authorization_required');
  assert.equal(f.writes.length, 0);
});
