/**
 * Scratch probe: run one real turn against `codex app-server` and dump every
 * raw JSON-RPC frame, so the wire shapes are observed rather than guessed.
 * Not part of the server. Run:  node tools/probe.js
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const codexPath = process.env.CODEX_BIN || join(HOME, ".local", "bin", "codex");
const PROMPT = process.env.PROBE_PROMPT || "你好，请只回复一句话：你好，我是 Codex。";
const SECOND = process.env.PROBE_SECOND || "";

const child = spawn(codexPath, ["app-server"], {
  cwd: HOME,
  env: { ...process.env, PATH: `${join(HOME, ".local", "bin")}:${process.env.PATH}` },
  detached: true,
  stdio: ["pipe", "pipe", "pipe"],
});

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
let buf = "";
const pending = new Map();

child.stderr.on("data", (c) => process.stderr.write(`[stderr] ${c}`));
child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { console.log(`${stamp()} [nonjson] ${line.slice(0, 200)}`); continue; }
    describe(m);
  }
});

function describe(m) {
  if (m.id !== undefined && m.method === undefined) {
    const e = pending.get(m.id);
    if (e) { pending.delete(m.id); clearTimeout(e.timer); m.error ? e.reject(new Error(JSON.stringify(m.error))) : e.resolve(m.result); }
    console.log(`${stamp()} <<RESULT id=${m.id} ${JSON.stringify(m.result).slice(0, 300)}`);
    return;
  }
  if (m.id !== undefined && m.method !== undefined) {
    console.log(`${stamp()} <<SERVER-REQUEST ${m.method} id=${m.id} ${JSON.stringify(m.params).slice(0, 300)}`);
    return;
  }
  globalThis.__onNotif?.(m);
  const p = m.params || {};
  const bits = [];
  for (const k of ["threadId", "turnId", "itemId", "delta", "status", "type", "command", "exitCode", "reason"]) {
    if (p[k] !== undefined) bits.push(`${k}=${JSON.stringify(p[k]).slice(0, 160)}`);
  }
  if (p.item) bits.push(`item=${JSON.stringify(p.item).slice(0, 500)}`);
  if (p.turn) bits.push(`turn=${JSON.stringify(p.turn).slice(0, 300)}`);
  console.log(`${stamp()} <<NOTIF ${m.method} ${bits.join(" ")}`);
}

let nextId = 1;
function request(method, params, timeoutMs = 120000) {
  const id = nextId++;
  console.log(`${stamp()} >>${method} ${JSON.stringify(params).slice(0, 200)}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

// turn/start is non-blocking: it returns a turn id immediately and the work
// arrives as notifications. So wait for that turn's `turn/completed`.
const turnDone = new Map();
globalThis.__onNotif = (m) => {
  if (m.method === "turn/completed") {
    const e = turnDone.get((m.params || {}).threadId);
    if (e) { turnDone.delete((m.params || {}).threadId); clearTimeout(e.timer); e.resolve(m.params.turn); }
  }
  if (m.method === "error") {
    console.log(`${stamp()} !! error notification ${JSON.stringify(m.params).slice(0, 400)}`);
  }
};

async function runTurn(threadId, text, label) {
  console.log(`${stamp()} ===== ${label} start =====`);
  const r = await request("turn/start", { threadId, input: [{ type: "text", text }] }, 60000);
  const turnId = r?.turn?.id;
  console.log(`${stamp()} turn/start returned turnId=${turnId}`);
  const turn = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { turnDone.delete(threadId); reject(new Error(`${label} never completed`)); }, 240000);
    turnDone.set(threadId, { resolve, reject, timer });
  });
  console.log(`${stamp()} ${label} COMPLETED status=${turn.status} err=${JSON.stringify(turn.error)}`);
  console.log(`${stamp()} ===== ${label} end =====`);
}

async function main() {
  console.log(`${stamp()} spawning ${codexPath}`);
  const init = await request("initialize", { clientInfo: { name: "codex-web-probe", title: "Codex Web Probe", version: "0.1.0" } });
  console.log(`${stamp()} initialized: ${JSON.stringify(init).slice(0, 300)}`);
  const started = await request("thread/start", { cwd: HOME, sandbox: "danger-full-access", approvalPolicy: "never" });
  const threadId = started?.thread?.id;
  console.log(`${stamp()} threadId=${threadId}`);
  await runTurn(threadId, PROMPT, "TURN-1");
  if (SECOND) await runTurn(threadId, SECOND, "TURN-2");
  console.log(`${stamp()} probe done`);
  child.kill("SIGTERM");
  setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} process.exit(0); }, 800);
}

main().catch((e) => { console.error("PROBE FAILED:", e); try { process.kill(-child.pid, "SIGKILL"); } catch {} process.exit(1); });
