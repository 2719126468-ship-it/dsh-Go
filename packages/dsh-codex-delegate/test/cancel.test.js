import test from "node:test";
import assert from "node:assert/strict";
import { CodexAppServer } from "../src/appserver.js";

function makeServer(request) {
  const server = Object.create(CodexAppServer.prototype);
  server.options = { sandboxMode: "danger-full-access", approvalPolicy: "on-request", handshakeTimeoutMs: 1000 };
  server.turns = new Map();
  server.ensure = async () => {};
  server.request = request;
  return server;
}

test("approval prompts are declined when no interactive approval UI exists", () => {
  const server = makeServer(async () => ({}));
  assert.deepEqual(server.answerServerRequest("ExecCommandApproval"), { decision: "decline" });
  assert.deepEqual(server.answerServerRequest("ApplyPatchApproval"), { decision: "denied" });
  assert.deepEqual(server.answerServerRequest("ToolRequestUserInput"), { answers: [] });
});

test("pre-aborted calls never create a thread or start a turn", async () => {
  const calls = [];
  const server = makeServer(async (method) => { calls.push(method); return { thread: { id: "T1" } }; });
  const controller = new AbortController();
  controller.abort();
  const result = await server.runTurnInner({ prompt: "do work", cwd: "/tmp", timeoutMs: 1000, signal: controller.signal });
  assert.equal(result.status, "aborted");
  assert.deepEqual(calls, []);
});

test("abort during thread/start does not start a turn", async () => {
  const controller = new AbortController();
  let finishThread;
  const calls = [];
  const server = makeServer((method) => {
    calls.push(method);
    if (method === "thread/start") return new Promise((resolve) => { finishThread = resolve; });
    return Promise.resolve({});
  });
  const pending = server.runTurnInner({ prompt: "do work", cwd: "/tmp", timeoutMs: 1000, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  finishThread({ thread: { id: "T1" } });
  const result = await pending;
  assert.equal(result.status, "aborted");
  assert.deepEqual(calls, ["thread/start"]);
});

test("abort while turn/start is pending sends interrupt after turn/start", async () => {
  const controller = new AbortController();
  let finishTurnStart;
  const calls = [];
  const server = makeServer((method) => {
    calls.push(method);
    if (method === "thread/start") return Promise.resolve({ thread: { id: "T1" } });
    if (method === "turn/start") return new Promise((resolve) => { finishTurnStart = resolve; });
    if (method === "turn/interrupt") return Promise.resolve({});
    throw new Error("unexpected method " + method);
  });
  const pending = server.runTurnInner({ prompt: "do work", cwd: "/tmp", timeoutMs: 1000, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["thread/start", "turn/start"]);
  controller.abort();
  finishTurnStart({});
  const result = await pending;
  assert.equal(result.status, "aborted");
  assert.deepEqual(calls, ["thread/start", "turn/start", "turn/interrupt"]);
});
