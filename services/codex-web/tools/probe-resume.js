/** 探针：app-server 重启后 thread/resume 到底能不能把旧会话接回来。 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const codexPath = join(HOME, ".local", "bin", "codex");

function launch() {
  const child = spawn(codexPath, ["app-server"], {
    cwd: HOME,
    env: { ...process.env, PATH: `${join(HOME, ".local", "bin")}:${process.env.PATH}` },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  let nextId = 1;
  const pending = new Map();
  const notifs = [];
  child.stdout.on("data", (c) => {
    buf += c.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && m.method === undefined) {
        const e = pending.get(m.id);
        if (e) { pending.delete(m.id); clearTimeout(e.timer); m.error ? e.reject(new Error(JSON.stringify(m.error))) : e.resolve(m.result); }
      } else if (m.id === undefined) {
        notifs.push(m.method);
      }
    }
  });
  child.stderr.on("data", (c) => process.stderr.write("[stderr] " + c));
  const request = (method, params, timeoutMs = 60000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + " timeout")); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return { child, request, notifs };
}

function kill(s) {
  try { process.kill(-s.child.pid, "SIGKILL"); } catch { try { s.child.kill("SIGKILL"); } catch {} }
}

async function main() {
  // --- 第一代 ---
  const a = launch();
  await a.request("initialize", { clientInfo: { name: "resume-probe", title: "resume-probe", version: "1" } });
  const started = await a.request("thread/start", { cwd: HOME, sandbox: "danger-full-access", approvalPolicy: "never" });
  const threadId = started.thread.id;
  console.log("旧会话 threadId =", threadId);
  const t = await a.request("turn/start", { threadId, input: [{ type: "text", text: "记住数字 512，只回 ok。" }] });
  const turnId = t.turn.id;
  await new Promise((res) => {
    const iv = setInterval(() => { if (a.notifs.includes("turn/completed")) { clearInterval(iv); res(); } }, 200);
    setTimeout(() => { clearInterval(iv); res(); }, 60000);
  });
  console.log("第一轮完成，杀掉第一代 app-server");
  kill(a);
  await new Promise((r) => setTimeout(r, 1500));

  // --- 第二代 ---
  const b = launch();
  await b.request("initialize", { clientInfo: { name: "resume-probe", title: "resume-probe", version: "1" } });

  for (const [label, params] of [
    ["thread/resume {threadId}", { threadId }],
    ["thread/resume {threadId,cwd,sandbox,approvalPolicy}", { threadId, cwd: HOME, sandbox: "danger-full-access", approvalPolicy: "never" }],
  ]) {
    try {
      const r = await b.request("thread/resume", params);
      console.log(`\n${label} => OK`);
      console.log("   返回:", JSON.stringify(r).slice(0, 400));
    } catch (e) {
      console.log(`\n${label} => 失败: ${e.message}`);
      continue;
    }
    try {
      const t2 = await b.request("turn/start", { threadId, input: [{ type: "text", text: "我让你记的数字是多少？只回数字。" }] });
      console.log("   随后 turn/start OK, turnId =", t2.turn.id);
      await new Promise((res) => {
        const iv = setInterval(() => { if (b.notifs.includes("turn/completed")) { clearInterval(iv); res(); } }, 200);
        setTimeout(() => { clearInterval(iv); res(); }, 90000);
      });
      console.log("   该轮已完成");
      break;
    } catch (e) {
      console.log("   随后 turn/start 失败:", e.message);
    }
  }

  kill(b);
  process.exit(0);
}
main().catch((e) => { console.error("FAILED", e); process.exit(1); });
