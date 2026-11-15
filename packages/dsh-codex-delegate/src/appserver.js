/**
 * The resident `codex app-server` transport.
 *
 * Owns the child process and the JSON-RPC 2.0 conversation with it: spawn,
 * handshake, request/notification routing by id and threadId, per-turn
 * assembly of agent-message deltas, idle shutdown, and process-group
 * teardown. Also carries the cold one-shot `codex exec` fallback.
 *
 * Split out of index.js in stage 1a (pure move, no logic change) so the
 * subagent provider added in stage 1b can share it.
 *
 * Imports NOTHING outside node builtins on purpose: the bundle is installed as
 * a `link:` package, so Node resolves its imports from the real workspace path,
 * where no node_modules exists — any @deepseek-ai/* import would fail with
 * ERR_MODULE_NOT_FOUND and the plugin would never activate.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();
const TERMUX_PREFIX = process.env.PREFIX || "/data/data/com.termux/files/usr";
const CLIENT_INFO = { name: "dsh-codex-delegate", title: "DSH Codex Delegate", version: "2.0.0" };

/** Cap on unframed stdout buffered while waiting for a newline. */
const MAX_BUFFER_CHARS = 4 * 1024 * 1024;

/** Render any thrown value as a short human-readable line. */
export function describe(error) {
  if (error == null) return "未知错误";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object") {
    if (typeof error.message === "string" && error.message) return error.message;
    try {
      const json = JSON.stringify(error);
      if (json && json !== "{}") return json;
    } catch { /* 循环引用之类 */ }
    return "（错误对象里没有可读信息）";
  }
  return String(error);
}

/**
 * The credential Codex needs, in precedence order:
 *   1. the variable itself, when DSH already exports it;
 *   2. DSH's credential store, which holds the same key under CODEX_API_API_KEY
 *      (the name DSH's own codex-api provider uses);
 *   3. Termux convention: the export line in ~/.bashrc / ~/.profile /
 *      ~/.bash_profile — a non-interactive shell never sourced them, so DSH's
 *      env may simply lack the key even though the user configured it.
 * ~/.codex/* stays untouched (the plugin's contract: Codex owns that state).
 * Returns undefined when nothing is available; Codex then reports its own
 * "Missing environment variable: SHAREDCHAT_API_KEY" error, which is accurate.
 */
export function resolveApiKey() {
  const fromEnv = process.env.SHAREDCHAT_API_KEY;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  const dshHome = process.env.DSH_HOME || join(HOME, ".dsh");
  try {
    const store = readFileSync(join(dshHome, ".credentials.yaml"), "utf8");
    const hit = /^\s*CODEX_API_API_KEY\s*:\s*(.+?)\s*$/m.exec(store);
    if (hit) return hit[1].replace(/^["']|["']$/g, "");
  } catch {
    // No store: fall through to the rc files.
  }
  for (const rc of [".bashrc", ".profile", ".bash_profile"]) {
    try {
      const text = readFileSync(join(HOME, rc), "utf8");
      const hit = /^\s*export\s+SHAREDCHAT_API_KEY\s*=\s*(.+?)\s*$/m.exec(text);
      if (hit) {
        const value = hit[1].trim().replace(/^["']|["']$/g, "");
        if (value) return value;
      }
    } catch {
      // No such file: try the next one.
    }
  }
  return undefined;
}

/**
 * Child environment. DSH may run with a deliberately small PATH, but the codex
 * wrapper shells out to `proot`, so Termux's own bin directories are prepended
 * explicitly rather than trusted to inheritance.
 */
function buildEnv() {
  const env = { ...process.env };
  const apiKey = resolveApiKey();
  const parts = [join(HOME, ".local", "bin"), join(TERMUX_PREFIX, "bin")];
  if (env.PATH) parts.push(env.PATH);
  env.PATH = parts.join(":");
  if (!env.HOME) env.HOME = HOME;
  if (!env.PREFIX) env.PREFIX = TERMUX_PREFIX;
  if (apiKey) env.SHAREDCHAT_API_KEY = apiKey;
  return env;
}

/**
 * Stop the whole tree, then run `done` after the hard kill has been issued.
 *
 * `detached: true` made the child a process-group leader, and the codex wrapper
 * execs proot, so the group is the only correct unit to signal. The SIGKILL is
 * deliberately neither unref'd nor deferred past `done`: an escalation that node
 * can drop on exit leaks a traced proot/codex tree behind the plugin.
 */
function terminate(child, graceMs, done) {
  const pid = child.pid;
  const signalGroup = (sig) => {
    if (!pid) return;
    try {
      process.kill(-pid, sig);
    } catch {
      try { child.kill(sig); } catch { /* already gone */ }
    }
  };
  signalGroup("SIGTERM");
  setTimeout(() => {
    signalGroup("SIGKILL");
    done();
  }, graceMs);
}

/**
 * One resident `codex app-server`, shared by every call.
 *
 * Requests are correlated by JSON-RPC id; notifications are routed by the
 * `threadId` they carry, so several threads can be in flight at once.
 */
export class CodexAppServer {
  constructor(options) {
    this.options = options;
    this.child = null;
    this.ready = null;
    this.nextId = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.buffer = "";
    this.stderr = "";
    this.idleTimer = null;
    this.disposed = false;
    /**
     * Turns in flight, counted across BOTH entry points — the `codex_delegate`
     * tool and the subagent provider — because both go through `runTurn()`.
     * This is the single source of truth for "may the child be closed".
     */
    this.activeTurns = 0;
    /**
     * A close request that arrived while turns were still in flight. It is
     * drained as soon as the last one finishes, never dropped silently.
     */
    this.pendingKill = null;
  }

  /** Cancel a pending idle shutdown; a call is starting. */
  clearIdle() {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /**
   * Arm the idle shutdown.
   *
   * The timer only schedules the *question* ("should we close?"); `maybeKill`
   * answers it. Keeping those separate is what stops a timer that fires
   * mid-turn from SIGKILLing the very turn it was waiting on — which is exactly
   * what a short `idleTimeoutMs` used to do.
   */
  armIdle() {
    this.clearIdle();
    if (!this.child || this.disposed || this.activeTurns > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.maybeKill("空闲超时");
    }, this.options.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  /**
   * Ask to close the child, honouring in-flight turns.
   *
   * @returns `true` when the child was closed now, `false` when the request was
   * deferred until the last turn drains. A deferred request is never dropped
   * silently — `drainPendingKill()` runs it on the way out of `runTurn()`.
   */
  maybeKill(reason) {
    if (this.activeTurns > 0) {
      this.pendingKill = reason;
      return false;
    }
    this.kill(reason);
    return true;
  }

  /** Run a deferred close request once nothing is in flight. */
  drainPendingKill() {
    if (this.pendingKill === null || this.activeTurns > 0) return;
    const reason = this.pendingKill;
    this.pendingKill = null;
    this.kill(reason);
  }

  /** Resolve once the child is spawned and the handshake has completed. */
  ensure() {
    if (this.disposed) return Promise.reject(new Error("codex app-server 已关闭"));
    if (this.ready) return this.ready;
    this.ready = this.start().catch((error) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  async start() {
    let child;
    try {
      child = spawn(this.options.codexPath, ["app-server"], {
        cwd: HOME,
        env: buildEnv(),
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new Error(`无法启动 codex app-server：${describe(error)}`);
    }

    this.child = child;
    this.buffer = "";
    this.stderr = "";

    child.stdout.on("data", (chunk) => {
      if (this.child !== child) return;
      this.consume(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (this.child !== child) return;
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-this.options.stderrTailChars);
    });
    child.on("error", (error) => {
      // A stale generation must not disturb the child that replaced it.
      if (this.child !== child) return;
      this.failAll(`codex app-server 进程错误：${describe(error)}`);
    });
    child.on("close", (code, signal) => {
      // Same guard. kill() nulls this.child before terminating, so a close
      // arriving for an already-replaced child must not clear the CURRENT one —
      // doing so silently detaches the new child and every later request fails.
      if (this.child !== child) return;
      const detail = this.stderr.trim();
      this.child = null;
      this.ready = null;
      this.failAll(
        `codex app-server 已退出（退出码 ${code ?? "null"}${signal ? `，信号 ${signal}` : ""}）。`
        + (detail ? `\n--- stderr ---\n${detail}` : ""),
      );
    });

    await this.request("initialize", { clientInfo: CLIENT_INFO }, this.options.handshakeTimeoutMs);
    this.armIdle();
  }

  /** Split the newline-delimited stream into JSON-RPC messages. */
  consume(chunk) {
    this.buffer += chunk.toString("utf8");
    // The child occasionally logs plain text without newlines; without a cap
    // one huge frameless blob would grow the buffer without bound (OOM).
    // Drop the oldest bytes — at worst one frame is corrupted, never OOM.
    if (this.buffer.length > MAX_BUFFER_CHARS) {
      this.buffer = this.buffer.slice(-MAX_BUFFER_CHARS);
    }
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // Not a protocol frame; the child also logs plain text.
      }
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    // A response to one of our requests.
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new Error(`${entry.method} 失败：${message.error.message || JSON.stringify(message.error)}`));
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    // A server->client request (approvals and the like). Answer it, because an
    // unanswered one parks the turn until the caller's timeout fires.
    if (message.method !== undefined && message.id !== undefined) {
      const result = this.answerServerRequest(message.method);
      try {
        this.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
      } catch { /* child already gone */ }
      return;
    }

    // A notification.
    const params = message.params || {};
    const threadId = params.threadId;
    const turn = threadId ? this.turns.get(threadId) : undefined;

    if (message.method === "item/agentMessage/delta") {
      if (turn) turn.appendDelta(params.itemId, params.delta);
      return;
    }
    if (message.method === "item/completed") {
      const item = params.item;
      if (turn && item && item.type === "agentMessage") turn.setFinalText(item.id, item.text || "");
      return;
    }
    if (message.method === "turn/completed") {
      if (!turn) return;
      this.turns.delete(threadId);
      clearTimeout(turn.timer);
      turn.settle(params.turn || {});
      return;
    }
    if (message.method === "error") {
      // Shape: { error: TurnError, threadId, turnId, willRetry }.
      // `willRetry: true` means the app-server is retrying upstream on its own
      // — this is NOT a failure, so the turn keeps waiting for turn/completed
      // (mirrors how codex-web renders it as a transient "retry" event).
      // Without that flag the error is terminal: settle immediately with the
      // real message, otherwise a dead upstream (e.g. HTTP 403
      // codex_access_restricted) is swallowed and the caller only ever sees a
      // timeout, losing the actual reason.
      // Threads without a matching threadId are ignored: with several turns in
      // flight there is no safe way to attribute the error.
      if (!turn) return;
      if (params.willRetry === true) return;
      this.turns.delete(threadId);
      clearTimeout(turn.timer);
      turn.settle({ status: "failed", error: { message: describe(params.error) } });
      return;
    }
  }

  /**
   * Deny-by-default answer for an unexpected server->client request.
   * `approvalPolicy: "never"` means these should not arrive at all; answering
   * `decline` keeps a stray one from hanging the turn.
   */
  answerServerRequest(method) {
    if (/RequestApproval|ApplyPatchApproval/.test(method)) {
      return { decision: method === "ApplyPatchApproval" ? "denied" : "decline" };
    }
    if (method === "ToolRequestUserInput") return { answers: [] };
    return {};
  }

  request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = this.child;
      if (!child || !child.stdin || child.stdin.destroyed) {
        reject(new Error("codex app-server 不可用"));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server 在 ${Math.round(timeoutMs / 1000)} 秒内没有回应 ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * Run one prompt on a fresh thread and resolve with the assembled reply.
   *
   * The call is registered as in-flight before the handshake so the idle
   * shutdown cannot fire during spawn, mid-turn, or between the two.
   * @returns {Promise<{ok: boolean, timedOut: boolean, output: string}>}
   */
  async runTurn({ prompt, cwd, timeoutMs, signal }) {
    this.activeTurns += 1;
    this.clearIdle();
    try {
      return await this.runTurnInner({ prompt, cwd, timeoutMs, signal });
    } finally {
      this.activeTurns -= 1;
      this.armIdle();
      this.drainPendingKill();
    }
  }

  async runTurnInner({ prompt, cwd, timeoutMs, signal }) {
    if (signal?.aborted) return { ok: false, timedOut: false, status: "aborted", output: "(call cancelled)" };
    await this.ensure();
    if (signal?.aborted) return { ok: false, timedOut: false, status: "aborted", output: "(call cancelled)" };

    // Thread setup is charged to the handshake budget, not to the turn budget.
    // Charging it to the turn made the first call after an idle shutdown — which
    // also pays the cold spawn — exceed `timeoutMs` on its own.
    const started = await this.request("thread/start", {
      cwd,
      sandbox: this.options.sandboxMode,
      approvalPolicy: this.options.approvalPolicy,
    }, this.options.handshakeTimeoutMs);

    const threadId = started?.thread?.id;
    if (!threadId) throw new Error("thread/start 未返回 thread id");
    if (signal?.aborted) return { ok: false, timedOut: false, status: "aborted", output: "(call cancelled)" };

    const deadline = Date.now() + timeoutMs;
    const remaining = () => Math.max(1000, deadline - Date.now());

    const turn = makeTurn();
    turn.timer = setTimeout(() => turn.settle({ status: "timeout" }), remaining());
    turn.timer.unref?.();
    this.turns.set(threadId, turn);

    let aborted = false;
    let turnStartSent = false;
    let interruptSent = false;
    const interruptStartedTurn = () => {
      if (!turnStartSent || interruptSent) return;
      interruptSent = true;
      this.request("turn/interrupt", { threadId }, 5000).catch(() => {});
    };
    const onAbort = () => {
      aborted = true;
      interruptStartedTurn();
      turn.settle({ status: "aborted" });
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      if (aborted || signal?.aborted) {
        turn.settle({ status: "aborted" });
        return { ok: false, timedOut: false, status: "aborted", output: "(call cancelled)" };
      }
      // Mark before writing the request: an abort during the start handshake must
      // enqueue its interrupt after turn/start, never before it.
      turnStartSent = true;
      await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
      }, remaining());
      if (aborted) interruptStartedTurn();

      const finished = await turn.promise;
      const text = turn.text();
      clearTimeout(turn.timer);

      if (finished.status === "timeout") {
        // Stop the server-side work so a hung turn cannot keep burning tokens.
        this.request("turn/interrupt", { threadId }, 5000).catch(() => {});
        return {
          ok: false, timedOut: true, status: "timeout",
          reason: `turn exceeded ${Math.round(timeoutMs / 1000)}s and was interrupted`,
          output: text,
        };
      }
      if (finished.status === "aborted" || aborted) {
        return { ok: false, timedOut: false, status: "aborted", output: `${text}\n(call cancelled)`.trim() };
      }
      if (finished.status === "disconnected") {
        return { ok: false, timedOut: false, status: "disconnected", reason: finished.message, output: finished.message };
      }
      if (finished.status === "completed") {
        return { ok: true, timedOut: false, status: "completed", output: text };
      }
      // `reason` is computed once and used twice on purpose: the output line is
      // for a human reading the tool result, the field is what the orchestrator
      // consumes (the provider puts it in `SubagentResult.diagnostic`). One
      // source, two renderings — never two copies that can drift.
      const reason = finished.error?.message || `turn ${finished.status}`;
      return {
        ok: false, timedOut: false, status: finished.status, reason,
        output: [text.trim(), `❌ Codex turn ${finished.status}：${reason}`].filter(Boolean).join("\n\n"),
      };
    } finally {
      clearTimeout(turn.timer);
      this.turns.delete(threadId);
      if (signal) signal.removeEventListener?.("abort", onAbort);
    }
  }

  failAll(message) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    this.pending.clear();
    for (const [, turn] of this.turns) {
      clearTimeout(turn.timer);
      turn.settle({ status: "disconnected", message });
    }
  }

  /**
   * Close the child now, unconditionally.
   *
   * This is the FORCED path, and the only one. `dispose()` uses it because
   * plugin unload must be final even with turns in flight; `maybeKill()` only
   * reaches it once `activeTurns` has drained. A caller that merely *wants* the
   * child closed — the idle timer, the subagent provider — must go through
   * `maybeKill()` instead, so an in-flight turn is never killed silently.
   */
  kill(reason) {
    this.pendingKill = null;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.ready = null;
    const child = this.child;
    if (!child) {
      this.failAll(`codex app-server 已关闭（${reason}）`);
      return;
    }
    this.child = null;
    terminate(child, this.options.killGraceMs, () => {});
    this.failAll(`codex app-server 已关闭（${reason}）`);
  }

  dispose() {
    this.disposed = true;
    this.kill("插件卸载");
  }
}

/**
 * One turn's output: agent-message deltas in arrival order per item, with the
 * authoritative text from `item/completed` preferred when it has arrived.
 */
function makeTurn() {
  const order = [];
  const deltas = new Map();
  const finals = new Map();
  const turn = {
    settled: false,
    timer: null,
    resolve: null,
    promise: null,
    appendDelta(itemId, delta) {
      if (typeof delta !== "string") return;
      if (!deltas.has(itemId) && !finals.has(itemId)) order.push(itemId);
      deltas.set(itemId, (deltas.get(itemId) || "") + delta);
    },
    setFinalText(itemId, text) {
      if (!deltas.has(itemId) && !finals.has(itemId)) order.push(itemId);
      finals.set(itemId, text);
    },
    text() {
      return order
        .map((id) => (finals.has(id) ? finals.get(id) : (deltas.get(id) || "")))
        .join("");
    },
    settle(value) {
      if (turn.settled) return;
      turn.settled = true;
      turn.resolve(value);
    },
  };
  turn.promise = new Promise((resolve) => { turn.resolve = resolve; });
  return turn;
}

/** Fallback: the cold one-shot path, used only when the app-server is unusable. */
export function runOneShot({ codexPath, prompt, cwd, timeoutMs, killGraceMs, signal, maxOutputChars }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(codexPath, ["exec", "--skip-git-repo-check", "--sandbox", "danger-full-access", prompt], {
        cwd,
        env: buildEnv(),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, timedOut: false, output: `无法启动 Codex：${describe(error)}` });
      return;
    }

    // Bounded accumulation: a runaway child can print hundreds of MB, and an
    // unbounded `output += chunk` keeps all of it in the DSH process until the
    // turn ends. stdout keeps the HEAD (the reply starts with the answer);
    // stderr keeps the TAIL (diagnostics end with the fatal line).
    const cap = Number.isFinite(maxOutputChars) && maxOutputChars >= 1000 ? maxOutputChars : 100000;
    const stderrCap = Math.min(cap, 16384);
    let out = "";
    let err = "";
    let droppedOut = 0;
    let droppedErr = 0;
    const collect = (isErr, chunk) => {
      const s = chunk.toString("utf8");
      if (isErr) {
        err += s;
        if (err.length > stderrCap) { droppedErr += err.length - stderrCap; err = err.slice(-stderrCap); }
      } else {
        out += s;
        if (out.length > cap) { droppedOut += out.length - cap; out = out.slice(0, cap); }
      }
    };
    child.stdout.on("data", (chunk) => collect(false, chunk));
    child.stderr.on("data", (chunk) => collect(true, chunk));

    const text = () => {
      const parts = [];
      if (out) parts.push(out);
      if (err) parts.push(err);
      let joined = parts.join("\n");
      if (droppedOut || droppedErr) {
        const bits = [];
        if (droppedOut) bits.push(`stdout ${droppedOut} 字符（已保留头部 ${cap}）`);
        if (droppedErr) bits.push(`stderr ${droppedErr} 字符（已保留尾部 ${stderrCap}）`);
        joined += `\n…（输出过大，丢弃 ${bits.join("，")}）`;
      }
      return joined;
    };

    let timedOut = false;
    let settled = false;

    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child, killGraceMs, () => {
        settle({ ok: false, timedOut: true, output: text() });
      });
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (error) => {
      settle({ ok: false, timedOut: false, output: `${text()}\n无法启动 Codex：${describe(error)}`.trim() });
    });
    child.on("close", (code, sig) => {
      settle({ ok: code === 0 && !timedOut, timedOut, output: text(), exitCode: code, signal: sig });
    });

    if (signal) {
      const onAbort = () => {
        const t = `${text()}\n(call cancelled)`.trim();
        terminate(child, 0, () => settle({ ok: false, timedOut: false, output: t }));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
