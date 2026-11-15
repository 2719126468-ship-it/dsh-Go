/**
 * Codex app-server 客户端（codex-web 自用版）。
 *
 * 负责：拉起常驻的 `codex app-server` 子进程、跟它说 JSON-RPC 2.0、
 * 把一个 thread 的第 N 轮对话跑起来、把 app-server 的流式通知翻译成
 * 本项目自己的事件（delta / tool / tool_result / usage / done / error），
 * 以及空闲回收和整棵进程树的清理。
 *
 * 这一份是从 packages/dsh-codex-delegate/src/appserver.js 复制后独立演进的：
 * 不 import 任何 DSH 路径，没有任何 DSH 概念（diagnostic / SubagentResult…）。
 *
 * 实测协议要点（codex-cli 0.159.2，见 tools/probe.js）：
 *   - `initialize` 握手很快（<1s）；`thread/start` 约 3s。
 *   - **`turn/start` 是非阻塞的**：它立刻返回 `{turn:{id,status:"inProgress"}}`，
 *     真正的产出全部走通知（item/started、item/agentMessage/delta、
 *     item/completed、turn/completed）。所以必须在发出请求**之前**就把这一轮
 *     登记好，否则会漏掉最早的通知。
 *   - 一个 thread 同时只能跑一轮；并发 turn/start 会挤在同一轮上。
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();
const TERMUX_PREFIX = process.env.PREFIX || "/data/data/com.termux/files/usr";

/**
 * 把任意东西渲染成一行人类可读文字。
 *
 * 注意别偷懒写成 String(x)：JSON-RPC 过来的错误是**普通对象**
 * （TurnError: {message, codexErrorInfo, …}），String() 出来就是
 * `[object Object]` —— 这正是手机上那两张 "卡片" 的由来。
 */
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

/** CodexErrorInfo 可能是字符串枚举，也可能是 {httpConnectionFailed:{httpStatusCode}} 这种。 */
function errorCode(info) {
  if (!info) return null;
  if (typeof info === "string") return info;
  if (typeof info === "object") {
    const key = Object.keys(info)[0];
    if (!key) return null;
    const detail = info[key];
    const status = detail && typeof detail === "object" ? detail.httpStatusCode : null;
    return status ? `${key}(${status})` : key;
  }
  return null;
}

/**
 * 这个 threadId 在当前的 app-server 里不存在，而且也没能 resume 回来。
 * 典型场景：app-server 被空闲回收后重启，旧的会话已经接不上了。
 * 上层收到它应该另起一个新会话，而不是把错误直接甩给用户。
 */
export class ThreadGoneError extends Error {
  constructor(threadId, cause) {
    super(`会话 ${threadId} 已经不在了（${cause}）`);
    this.name = "ThreadGoneError";
    this.threadId = threadId;
    this.cause = cause;
  }
}

/**
 * Codex 需要的凭据 SHAREDCHAT_API_KEY（~/.codex/config.toml 里
 * [model_providers.sharedchat].env_key 指的就是它）。
 *
 * 解析顺序：
 *   1. 进程环境里已经有（start.sh 会尝试注入）；
 *   2. Termux 惯例：key 写在 ~/.bashrc 的 export 行里，非交互 shell 拿不到，
 *      所以这里兜底把它抠出来。只读，不改任何文件。
 *   3. ~/.codex/auth.json（万一改用官方登录态）。
 *
 * 都拿不到就返回 undefined，让 Codex 自己报 "Missing environment variable"。
 */
export function resolveApiKey() {
  const fromEnv = process.env.SHAREDCHAT_API_KEY;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();

  const rcFiles = [".bashrc", ".profile", ".bash_profile"];
  for (const rc of rcFiles) {
    try {
      const text = readFileSync(join(HOME, rc), "utf8");
      const hit = /^\s*export\s+SHAREDCHAT_API_KEY\s*=\s*(.+?)\s*$/m.exec(text);
      if (hit) {
        const value = hit[1].trim().replace(/^["']|["']$/g, "");
        if (value) return value;
      }
    } catch {
      // 没有这个文件就试下一个。
    }
  }

  try {
    const auth = JSON.parse(readFileSync(join(HOME, ".codex", "auth.json"), "utf8"));
    if (typeof auth?.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.trim()) {
      return auth.OPENAI_API_KEY.trim();
    }
  } catch {
    // 没有 auth.json（本机就是没有），交给 Codex 报错。
  }
  return undefined;
}

/**
 * 子进程环境。codex wrapper 会 exec proot，所以 Termux 自己的 bin 目录必须
 * 显式前置，不能指望继承来的 PATH。
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
 * 干掉整棵进程树。spawn 时用了 detached:true，子进程是进程组组长，
 * 而 codex wrapper 会 exec proot，所以只能整组发信号。
 */
function terminate(child, graceMs, done) {
  const pid = child.pid;
  const signalGroup = (sig) => {
    if (!pid) return;
    try {
      process.kill(-pid, sig);
    } catch {
      try { child.kill(sig); } catch { /* 已经没了 */ }
    }
  };
  signalGroup("SIGTERM");
  setTimeout(() => {
    signalGroup("SIGKILL");
    done();
  }, graceMs).unref?.();
}

// ---------------------------------------------------------------------------
// 工具调用的可视化映射
// ---------------------------------------------------------------------------

/** app-server 的 ThreadItem.type → 我们给前端看的名字。 */
const TOOL_NAMES = {
  commandExecution: "shell",
  commandExecutionApproval: "shell",
  fileChange: "apply_patch",
  webSearch: "web_search",
  imageView: "view_image",
  imageGeneration: "image_generation",
  // 多 agent（Codex 0.16x 的 collab）：主线程派活给子 agent，也渲染成卡片
  collabAgentToolCall: "collab",
  subAgentActivity: "subagent",
  functionCallOutput: "shell",
};

/** 这些 item 类型要渲染成一张可折叠的工具卡片。 */
export function isToolItem(item) {
  if (!item || typeof item !== "object") return false;
  if (item.type === "mcpToolCall") return true;
  if (item.type === "dynamicToolCall") return true;
  if (item.type === "sleep") return true;          // 等待，也值得显示一行
  if (item.type === "contextCompaction") return true; // 上下文压缩
  return Object.prototype.hasOwnProperty.call(TOOL_NAMES, item.type);
}

/**
 * Codex 实际执行的是 `<shell> -lc '...'`，直接显示整行又长又吵。
 * 这里把外壳剥掉，只留用户真正想看的命令本身。
 */
export function prettyCommand(command) {
  const raw = String(command || "").trim();
  const m = /^(?:\S*\/)?(?:bash|sh|zsh|dash|fish)\s+-[a-z]*c\s+(['"])([\s\S]*)\1$/.exec(raw);
  return m ? m[2] : raw;
}

/** 工具卡片的一句话摘要："正在跑：<命令>" / "正在改：<文件>"。 */
export function toolLabel(item) {
  switch (item.type) {
    case "commandExecution": {
      const cmd = prettyCommand(item.command).split("\n")[0];
      return `正在跑：${cmd.length > 120 ? cmd.slice(0, 120) + "…" : cmd}`;
    }
    case "fileChange": {
      const paths = (item.changes || [])
        .map((c) => c?.path || c?.file || "")
        .filter(Boolean);
      return paths.length ? `正在改：${paths.join("、")}` : "正在改文件";
    }
    case "mcpToolCall":
      return `正在调用：${item.server ? item.server + "/" : ""}${item.tool || "mcp"}`;
    case "dynamicToolCall":
      return `正在调用：${item.tool || "tool"}`;
    case "webSearch":
      return `正在搜索：${item.query || ""}`;
    case "imageView":
      return `正在看图：${item.path || ""}`;
    case "imageGeneration":
      return "正在生成图片";
    case "collabAgentToolCall": {
      const n = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.length : 0;
      const tool = item.tool || "spawn";
      return n ? `正在派发 ${n} 个子任务（${tool}）` : `正在调用 ${tool}`;
    }
    case "subAgentActivity": {
      const who = item.agentPath || item.agentThreadId || "子 agent";
      return `子 agent ${who} 在跑`;
    }
    case "sleep":
      return `等待 ${Math.round((item.durationMs || 0) / 1000)} 秒`;
    case "contextCompaction":
      return "正在压缩上下文";
    case "functionCallOutput":
      return `正在执行：${item.name || "tool"}`;
    default:
      return `正在执行：${item.type}`;
  }
}

/** 把工具 item 翻译成 {id, name, input}。 */
export function toolInput(item) {
  const name = item.type === "mcpToolCall"
    ? `${item.server ? item.server + "/" : ""}${item.tool || "mcp"}`
    : item.type === "dynamicToolCall"
      ? (item.tool || "tool")
      : (TOOL_NAMES[item.type] || item.type);

  let input;
  switch (item.type) {
    case "commandExecution":
      input = { command: prettyCommand(item.command), raw: item.command, cwd: item.cwd };
      break;
    case "fileChange":
      input = { changes: (item.changes || []).map((c) => c?.path || c).filter(Boolean) };
      break;
    case "mcpToolCall":
    case "dynamicToolCall":
      input = item.arguments ?? {};
      break;
    case "webSearch":
      input = { query: item.query };
      break;
    case "imageView":
      input = { path: item.path };
      break;
    case "collabAgentToolCall":
      input = { tool: item.tool, prompt: item.prompt, model: item.model, receivers: item.receiverThreadIds };
      break;
    case "subAgentActivity":
      input = { path: item.agentPath, model: item.model };
      break;
    case "sleep":
      input = { durationMs: item.durationMs };
      break;
    case "functionCallOutput":
      input = { tool: item.name, namespace: item.namespace };
      break;
    default:
      input = {};
  }
  return { id: item.id, name, input };
}

/** 工具跑完后的输出文本（卡片展开时看的内容）。 */
export function toolOutput(item) {
  const parts = [];
  switch (item.type) {
    case "commandExecution": {
      const out = item.aggregatedOutput;
      if (out) parts.push(String(out));
      if (item.exitCode !== undefined && item.exitCode !== null && item.exitCode !== 0) {
        parts.push(`exit code: ${item.exitCode}`);
      }
      // durationMs 给前端的卡片 meta 用（"0.8s"），这里不放正文。
      if (!out && (item.exitCode === 0 || item.exitCode === null)) parts.push("(无输出)");
      break;
    }
    case "fileChange":
      parts.push((item.changes || [])
        .map((c) => `${c?.path || c}: ${c?.status || c?.kind || "changed"}`)
        .join("\n") || "已应用改动");
      break;
    case "mcpToolCall":
      if (item.error) parts.push(String(item.error.message || JSON.stringify(item.error)));
      if (item.result !== undefined) parts.push(typeof item.result === "string" ? item.result : JSON.stringify(item.result, null, 2));
      break;
    case "dynamicToolCall":
      parts.push(item.contentItems ? JSON.stringify(item.contentItems, null, 2) : (item.success ? "ok" : "failed"));
      break;
    case "webSearch":
      parts.push((item.results || []).map((r) => r?.title || r?.url || JSON.stringify(r)).join("\n") || "无结果");
      break;
    case "imageView":
      parts.push(`已查看 ${item.path || ""}`);
      break;
    case "imageGeneration":
      parts.push(item.failure || item.savedPath || "已生成");
      break;
    case "collabAgentToolCall": {
      const st = item.agentsStates && typeof item.agentsStates === "object" ? item.agentsStates : {};
      const rows = Object.entries(st).map(([id, s]) => `${id}: ${typeof s === "string" ? s : (s && s.status) || JSON.stringify(s)}`);
      if (item.prompt) parts.push(`prompt: ${String(item.prompt).slice(0, 500)}`);
      parts.push(rows.length ? rows.join("\n") : (item.tool || "已派发"));
      break;
    }
    case "subAgentActivity":
      parts.push(`${item.agentPath || item.agentThreadId || "subagent"}: ${item.kind || ""}`.trim());
      break;
    case "sleep":
      parts.push(`等待 ${Math.round((item.durationMs || 0) / 1000)} 秒结束`);
      break;
    case "contextCompaction":
      parts.push("上下文已压缩（早期消息被摘要）");
      break;
    case "functionCallOutput":
      parts.push(typeof item.output === "string" ? item.output : JSON.stringify(item.output, null, 2));
      break;
    default:
      parts.push(JSON.stringify(item, null, 2));
  }
  const text = parts.filter(Boolean).join("\n").trim();
  return text.length > 20000 ? text.slice(0, 20000) + "\n…(截断)" : text;
}

// ---------------------------------------------------------------------------
// 一轮对话
// ---------------------------------------------------------------------------

function makeTurn() {
  const turn = {
    turnId: null,
    settled: false,
    onEvent: () => {},
    resolve: null,
    promise: null,
    timer: null,
    settle(value) {
      if (turn.settled) return;
      turn.settled = true;
      turn.resolve(value);
    },
  };
  // 必须在发出 turn/start 之前就建好：这一轮的产出全是通知，promise 是唯一的收口。
  turn.promise = new Promise((resolve) => { turn.resolve = resolve; });
  return turn;
}

// ---------------------------------------------------------------------------
// 常驻 app-server
// ---------------------------------------------------------------------------

/**
 * 挑一个 codex 可执行文件。
 *
 * 上游站点（sharedchat）会按客户端版本放行：旧版本直接回
 * 403 codex_access_restricted（"请使用最新版的 codex 客户端"）。所以这里不是
 * 死用 ~/.local/bin/codex，而是先看有没有并列安装的新版本目录
 * （~/.local/codex-<semver>/bin/codex，本项目的升级方式就是解一个 tarball 进去，
 * 不动系统里那份），有就取版本号最大的那个。
 *
 * 优先级：显式 CODEX_BIN > ~/.local/codex-<最高版本> > ~/.local/bin/codex。
 */
export function resolveCodexPath() {
  const explicit = process.env.CODEX_BIN;
  if (explicit) return explicit;
  const base = join(HOME, ".local");
  let best = null;
  try {
    for (const name of readdirSync(base)) {
      // 目录名接受 codex-0.167 与 codex-0.167.0 两种写法，缺的段按 0 补。
      const m = /^codex-(\d+)\.(\d+)(?:\.(\d+))?$/.exec(name);
      if (!m) continue;
      const bin = join(base, name, "bin", "codex");
      if (!existsSync(bin)) continue;
      const ver = [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
      if (!best || ver[0] > best.ver[0]
        || (ver[0] === best.ver[0] && ver[1] > best.ver[1])
        || (ver[0] === best.ver[0] && ver[1] === best.ver[1] && ver[2] > best.ver[2])) {
        best = { bin, ver };
      }
    }
  } catch { /* ~/.local 不存在就用兜底 */ }
  return best ? best.bin : join(base, "bin", "codex");
}

export class CodexAppServer {
  constructor(options = {}) {
    this.codexPath = options.codexPath || resolveCodexPath();
    this.cwd = options.cwd || HOME;
    this.sandboxMode = options.sandboxMode || "danger-full-access";
    this.approvalPolicy = options.approvalPolicy || "never";
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60 * 1000;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 120000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 30 * 60 * 1000;
    this.killGraceMs = options.killGraceMs ?? 2000;
    this.stderrTailChars = options.stderrTailChars ?? 8000;
    /** (state: "starting"|"ready"|"stopped", detail?) => void */
    this.onStatus = options.onStatus || (() => {});
    this.clientInfo = options.clientInfo || { name: "codex-web", title: "Codex Web", version: "0.1.0" };

    this.child = null;
    this.ready = null;
    this.nextId = 1;
    this.pending = new Map();
    /** threadId -> 正在跑的那一轮 */
    this.turns = new Map();
    /**
     * 当前这个 app-server 进程真正认识的 threadId。
     * 子进程一换（冷启动 / 空闲回收后重启），这里必须清空 —— 否则会拿着
     * 一个上一代进程的 id 去 turn/start，换回 "thread not found"。
     */
    this.liveThreads = new Set();
    /** 等待用户决定的审批请求：jsonrpc id -> entry */
    this.approvals = new Map();
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 5 * 60 * 1000;
    this.buffer = "";
    this.stderr = "";
    this.idleTimer = null;
    this.disposed = false;
    this.spawnedAt = null;
  }

  /** app-server 进程是否已经握手完成、可以接活。 */
  isReady() {
    return Boolean(this.child && this.ready);
  }

  /** 当前是否常驻着子进程（未必已握手完成）。 */
  isRunning() {
    return Boolean(this.child);
  }

  clearIdle() {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** 挂上空闲回收计时器：到点且真的没活干，才关子进程。 */
  armIdle() {
    this.clearIdle();
    if (!this.child || this.disposed || this.turns.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.turns.size > 0) return; // 期间又来活了
      this.kill(`空闲超过 ${Math.round(this.idleTimeoutMs / 60000)} 分钟`);
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  /** 确保子进程在跑且握过手。第一次调用会冷启动。 */
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
    this.onStatus("starting");
    let child;
    try {
      child = spawn(this.codexPath, ["app-server"], {
        cwd: this.cwd,
        env: buildEnv(),
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new Error(`无法启动 codex app-server：${describe(error)}`);
    }

    this.child = child;
    this.spawnedAt = Date.now();
    this.buffer = "";
    this.stderr = "";

    child.stdout.on("data", (chunk) => {
      if (this.child !== child) return;
      this.consume(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (this.child !== child) return;
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-this.stderrTailChars);
    });
    child.on("error", (error) => {
      if (this.child !== child) return;
      this.failAll(`codex app-server 进程错误：${describe(error)}`);
    });
    child.on("close", (code, signal) => {
      // kill() 会先把 this.child 置空，因此这里只处理"当前这一代"子进程的退出。
      if (this.child !== child) return;
      const detail = this.stderr.trim();
      this.child = null;
      this.ready = null;
      this.onStatus("stopped", detail);
      this.failAll(
        `codex app-server 已退出（退出码 ${code ?? "null"}${signal ? `，信号 ${signal}` : ""}）。`
        + (detail ? `\n--- stderr ---\n${detail}` : ""),
      );
    });

    await this.request("initialize", { clientInfo: this.clientInfo }, this.handshakeTimeoutMs);
    this.onStatus("ready");
    this.armIdle();
  }

  /** 把换行分隔的 stdout 切成一条条 JSON-RPC 消息。 */
  consume(chunk) {
    this.buffer += chunk.toString("utf8");
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // 子进程偶尔混进来的纯文本日志
      }
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    // 1) 我们发出去的请求的响应
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

    // 2) app-server 反向请求（审批之类）。approvalPolicy=never 时不该出现，
    //    但真来一个也不能让它把这一轮挂死。
    //
    //    Codex App 的做法是**弹卡片让用户点**（Approve / Reject / Edit），
    //    所以这里不再一律自动拒：把请求转成一个 approval 事件交给前端，
    //    等前端回 /api/approval；超时（默认 5 分钟）才按原策略拒绝。
    if (message.method !== undefined && message.id !== undefined) {
      const mid = message.method;
      const params = message.params || {};
      if (/RequestApproval|ApplyPatchApproval|ExecCommandApproval|PermissionsRequestApproval/.test(mid)) {
        this.handleApproval(message.id, mid, params);
        return;
      }
      const result = this.answerServerRequest(mid);
      try {
        this.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
      } catch { /* 子进程已经没了 */ }
      return;
    }

    // 3) 通知
    const params = message.params || {};
    const threadId = params.threadId;
    const turn = threadId ? this.turns.get(threadId) : undefined;
    // turn/completed 也要认没有 threadId 的情况（实测都带，但别赌）。
    const method = message.method;

    if (method === "item/agentMessage/delta") {
      if (turn && typeof params.delta === "string") {
        turn.onEvent({ type: "delta", text: params.delta });
      }
      return;
    }

    // 推理摘要（ChatGPT 里那段 "Thinking…" 灰字，以及展开后的推理过程）。
    // summaryTextDelta 是给人看的摘要；textDelta 是原始思维链，单独给一个类型，
    // 前端默认只显示摘要，展开时再显示原始内容。
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      if (turn && typeof params.delta === "string") {
        turn.onEvent({
          type: method.endsWith("summaryTextDelta") ? "reasoning_summary" : "reasoning_text",
          id: params.itemId,
          text: params.delta,
        });
      }
      return;
    }

    // 计划（turn/plan/updated 是权威全量，item/plan/delta 是流式增量）
    if (method === "turn/plan/updated") {
      if (turn && Array.isArray(params.plan)) {
        turn.onEvent({ type: "plan", items: params.plan, explanation: params.explanation ?? null });
      }
      return;
    }
    if (method === "item/plan/delta") {
      if (turn && typeof params.delta === "string") {
        turn.onEvent({ type: "plan_delta", id: params.itemId, text: params.delta });
      }
      return;
    }

    // 本轮聚合 diff（比 git diff 更准：它只含这一轮 Codex 自己改的东西）
    if (method === "turn/diff/updated") {
      if (turn && typeof params.diff === "string") {
        turn.onEvent({ type: "turn_diff", diff: params.diff });
      }
      return;
    }

    // MCP 工具的进度消息，当实时输出用
    if (method === "item/mcpToolCall/progress") {
      if (turn && typeof params.message === "string") {
        turn.onEvent({ type: "tool_delta", id: params.itemId, text: params.message + "\n" });
      }
      return;
    }
    if (method === "item/fileChange/outputDelta") {
      if (turn && typeof params.delta === "string") {
        turn.onEvent({ type: "tool_delta", id: params.itemId, text: params.delta });
      }
      return;
    }

    if (method === "item/started" || method === "item/completed") {
      const item = params.item;
      if (!turn || !item) return;
      if (item.type === "reasoning") {
        if (method === "item/completed") {
          turn.onEvent({
            type: "reasoning_done",
            id: item.id,
            summary: Array.isArray(item.summary) ? item.summary.join("\n\n") : "",
          });
        }
        return;
      }
      if (item.type === "plan") {
        if (method === "item/completed" && typeof item.text === "string") {
          turn.onEvent({ type: "plan_text", id: item.id, text: item.text });
        }
        return;
      }
      if (item.type === "agentMessage") {
        if (method === "item/completed" && typeof item.text === "string") {
          // 权威全文；前端用它做一次校正（防止 delta 有丢包）。
          turn.onEvent({ type: "message_final", text: item.text });
        }
        return;
      }
      if (isToolItem(item)) {
        if (method === "item/started") {
          const { id, name, input } = toolInput(item);
          turn.onEvent({ type: "tool", id, name, input, label: toolLabel(item) });
        } else {
          turn.onEvent({
            type: "tool_result",
            id: item.id,
            output: toolOutput(item),
            status: item.status,
            durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
            exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
          });
        }
      }
      return;
    }

    // 命令跑动过程中的实时输出（第 2 步的卡片可以直接吃这个）
    if (method === "item/commandExecution/outputDelta") {
      if (turn && typeof params.delta === "string") {
        turn.onEvent({ type: "tool_delta", id: params.itemId, text: params.delta });
      }
      return;
    }

    // 上下文窗口用量（ChatGPT 右下角那个进度条的数据源）。
    // 实测它在 turn/completed 之前到，所以这一轮还挂着，能直接抛给前端。
    if (method === "thread/tokenUsage/updated") {
      const usage = params.tokenUsage;
      if (turn && usage) {
        const last = usage.last || {};
        turn.onEvent({
          type: "usage",
          used: usage.total?.totalTokens ?? null,
          last: last.totalTokens ?? null,
          window: usage.modelContextWindow ?? null,
          // 本轮四项明细：Codex 的回合页脚就是这四格
          input: last.inputTokens ?? null,
          cached: last.cachedInputTokens ?? null,
          output: last.outputTokens ?? null,
          reasoning: last.reasoningOutputTokens ?? null,
        });
      }
      return;
    }

    if (method === "turn/completed") {
      if (!turn) return;
      this.turns.delete(threadId);
      clearTimeout(turn.timer);
      turn.settle(params.turn || {});
      this.armIdle();
      return;
    }

    if (method === "error") {
      // 形状：{error: TurnError, threadId, turnId, willRetry}
      // willRetry=true 表示 app-server 自己会重试 —— 这不是"失败"，别拿红框吓用户。
      //
      // 关键细节：TurnError.message 往往只是 "Reconnecting... 1/5"，真正的原因
      // （"unexpected status 403 Forbidden: 您当前没有可用的 Codex 订阅额度或余额"）
      // 在 additionalDetails 里。只报 message 的话，用户永远看不到上游到底说了什么，
      // 排查就变成了猜。
      const info = params.error;
      const willRetry = params.willRetry === true;
      const code = errorCode(info && typeof info === "object" ? info.codexErrorInfo : null);
      const base = describe(info);
      const extra = info && typeof info === "object" && typeof info.additionalDetails === "string"
        ? info.additionalDetails.trim() : "";
      const message = extra && !base.includes(extra) ? `${base}｜${extra}` : base;
      if (turn) {
        turn.onEvent({
          type: willRetry ? "retry" : "error",
          message,
          code,
          willRetry,
        });
      }
      return;
    }
  }

  /**
   * 审批请求：登记成 pending，把卡片推给前端，等 /api/approval 回话。
   *
   * 请求体形状（实测 codex-cli 0.167）：
   *   ExecCommandApproval         { threadId, turnId, callId?, command, cwd, reason?, ... }
   *   ApplyPatchApproval          { threadId, turnId, callId?, changes, reason? }
   *   PermissionsRequestApproval  { threadId, permissions }
   * 响应：
   *   ExecCommandApproval   { decision: "approved" | "approved_for_session" | "denied" | "abort" }
   *   ApplyPatchApproval    { decision: "approved" | "approved_for_session" | "denied" | "abort" }
   */
  handleApproval(id, method, params) {
    const threadId = params.threadId || "";
    const turn = threadId ? this.turns.get(threadId) : undefined;
    const entry = {
      id,
      method,
      threadId,
      params,
      timer: null,
      resolved: false,
    };
    const decisionFor = (choice) => {
      if (choice === "approve") {
        return method === "PermissionsRequestApproval"
          ? { permissions: params.permissions || params.requestedPermissions || [] }
          : { decision: "approved" };
      }
      if (choice === "session") {
        return { decision: "approved_for_session" };
      }
      if (choice === "abort") {
        return method === "PermissionsRequestApproval" ? { permissions: [] } : { decision: "abort" };
      }
      // 默认拒绝
      return method === "PermissionsRequestApproval" ? { permissions: [] } : { decision: "denied" };
    };
    entry.resolve = (choice) => {
      if (entry.resolved) return false;
      entry.resolved = true;
      clearTimeout(entry.timer);
      this.approvals.delete(id);
      try {
        this.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, result: decisionFor(choice) }) + "\n");
      } catch { /* 子进程已经没了 */ }
      if (turn) turn.onEvent({ type: "approval_resolved", id, choice });
      return true;
    };
    if (!this.approvals) this.approvals = new Map();
    this.approvals.set(id, entry);
    // 超时兜底：没人理就当拒绝，别把这一轮挂死。
    // 超时只发**一条** approval_resolved（带 timeout:true）—— entry.resolve 自己
    // 也会发一条，两条会撞在一起，前端日志里就出现重复的"已超时"。
    entry.timer = setTimeout(() => {
      if (entry.resolved) return;
      entry.resolved = true;
      clearTimeout(entry.timer);
      this.approvals.delete(id);
      try {
        this.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, result: decisionFor("deny") }) + "\n");
      } catch { /* 子进程已经没了 */ }
      if (turn) turn.onEvent({ type: "approval_resolved", id, choice: "deny", timeout: true });
    }, this.approvalTimeoutMs ?? 5 * 60 * 1000);
    entry.timer.unref?.();
    if (turn) {
      turn.onEvent({
        type: "approval",
        id,
        method,
        threadId,
        // 前端只需要这几样：要跑什么 / 改哪些文件 / 原因
        command: typeof params.command === "string" ? params.command : undefined,
        cwd: params.cwd || undefined,
        reason: params.reason || params.justification || undefined,
        changes: Array.isArray(params.changes)
          ? params.changes.map((c) => (typeof c === "string" ? c : (c && (c.path || c.file)) || ""))
          : undefined,
        permissions: params.permissions || params.requestedPermissions || undefined,
      });
    }
  }

  /** 前端点完卡片后由服务端调这里。 */
  resolveApproval(id, choice) {
    const entry = this.approvals?.get(id);
    if (!entry) return false;
    return entry.resolve(choice);
  }

  /** 反向请求一律"拒绝/空答"，避免无人应答把这一轮挂住。 */
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
   * 开一个新会话。
   * @returns {Promise<string>} threadId
   */
  async startThread({ cwd, sandboxMode, model, effort, serviceTier, approvalPolicy } = {}) {
    this.clearIdle();
    try {
      await this.ensure();
      const started = await this.request("thread/start", {
        cwd: cwd || this.cwd,
        sandbox: sandboxMode || this.sandboxMode,
        approvalPolicy: approvalPolicy || this.approvalPolicy,
        ...(model ? { model } : {}),
        ...(serviceTier ? { serviceTier } : {}),
        ...(effort ? { config: { model_reasoning_effort: effort } } : {}),
      }, this.handshakeTimeoutMs);
      const threadId = started?.thread?.id;
      if (!threadId) throw new Error("thread/start 未返回 thread id");
      this.liveThreads.add(threadId);
      return threadId;
    } finally {
      this.armIdle();
    }
  }

  /**
   * 在一个已有 thread 上跑一轮，事件边走边抛给 onEvent。
   *
   * `cwd` / `sandboxPolicy` 是"只作用于这一轮及其之后"的覆盖（协议原话：
   * Override the working directory / sandbox policy for this turn and subsequent
   * turns），所以换目录换权限都不需要重开会话。
   *
   * @param {{threadId: string, prompt: string, onEvent?: (e:object)=>void,
   *          timeoutMs?: number, cwd?: string, sandboxPolicy?: object}} args
   * @returns {Promise<{status: string, error?: any, text?: string}>}
   */
  async runTurn({ threadId, prompt, images, onEvent = () => {}, timeoutMs, cwd, sandboxPolicy, model, effort, serviceTier, approvalPolicy }) {
    if (this.disposed) throw new Error("codex app-server 已关闭");
    if (this.turns.has(threadId)) throw new Error("这个会话还有一轮在跑，先等它结束或点中断");

    this.clearIdle();
    await this.ensure();
    // 会话可能是上一个 app-server 进程建的（被空闲回收过），先接回来。
    await this.reviveThread(threadId);

    const budget = timeoutMs ?? this.turnTimeoutMs;
    const turn = makeTurn();
    turn.onEvent = onEvent;

    // 必须先登记再发请求：turn/start 立刻返回，通知可能比响应还早。
    this.turns.set(threadId, turn);
    let turnWrap;
    try {
      // 附件：app-server 的 UserInput 支持 {type:"localImage",path} —— 它自己读文件，
      // 所以这里只传绝对路径，不用把图片塞进 JSON。
      const attachments = Array.isArray(images)
        ? images
            .filter((p) => typeof p === "string" && p.trim())
            .slice(0, 8)
            .map((path) => ({ type: "localImage", path: path.trim() }))
        : [];
      turnWrap = await this.request("turn/start", {
        threadId,
        input: [...attachments, { type: "text", text: prompt }],
        ...(cwd ? { cwd } : {}),
        ...(sandboxPolicy ? { sandboxPolicy } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(serviceTier ? { serviceTier } : {}),
        ...(approvalPolicy ? { approvalPolicy } : {}),
      }, this.handshakeTimeoutMs);
      turn.turnId = turnWrap?.turn?.id ?? null;
    } catch (error) {
      this.turns.delete(threadId);
      this.armIdle();
      throw error;
    }

    turn.timer = setTimeout(() => {
      // 超时：让服务端也停下，别继续烧 token。
      this.request("turn/interrupt", { threadId, turnId: turn.turnId ?? undefined }, 5000).catch(() => {});
      this.turns.delete(threadId);
      turn.settle({ status: "timeout", error: { message: `超过 ${Math.round(budget / 1000)} 秒未完成` } });
    }, budget);
    turn.timer.unref?.();

    let finished;
    try {
      finished = await turn.promise;
    } finally {
      clearTimeout(turn.timer);
      this.turns.delete(threadId);
      this.armIdle();
    }

    return {
      status: finished?.status || "unknown",
      error: finished?.error || null,
      text: collectItemText(finished?.items),
    };
  }

  /**
   * 让当前 app-server 认识这个 threadId。
   *
   * 进程没换过就是空操作；换过了（冷启动 / 空闲回收）就先 `thread/resume`
   * 把磁盘上的会话接回来 —— 这样上下文能保住。接不回来才抛 ThreadGoneError。
   */
  async reviveThread(threadId) {
    if (this.liveThreads.has(threadId)) return;
    try {
      await this.request("thread/resume", {
        threadId,
        cwd: this.cwd,
        sandbox: this.sandboxMode,
        approvalPolicy: this.approvalPolicy,
      }, this.handshakeTimeoutMs);
      this.liveThreads.add(threadId);
    } catch (error) {
      throw new ThreadGoneError(threadId, describe(error));
    }
  }

  /**
   * 列出这台机器上落盘的全部 Codex 会话（不只是本服务建的 —— 命令行里开过的
   * 会话也能在这儿接着聊）。按最近更新倒序。
   */
  async listThreads({ limit = 50 } = {}) {
    this.clearIdle();
    try {
      await this.ensure();
      const res = await this.request("thread/list", {
        limit,
        sortKey: "updated_at",
        sortDirection: "desc",
      }, this.handshakeTimeoutMs);
      return Array.isArray(res?.data) ? res.data : [];
    } finally {
      this.armIdle();
    }
  }

  /**
   * 拉模型目录（model/list）。Codex 0.16x 起模型列表由 app-server 提供，
   * 前端那个「模型选择器」的数据源就是它 —— 不要在前端写死模型名。
   */
  async listModels({ includeHidden = false, limit = 100 } = {}) {
    this.clearIdle();
    try {
      await this.ensure();
      const out = [];
      let cursor = null;
      for (let page = 0; page < 5; page++) {
        const res = await this.request("model/list", {
          includeHidden,
          limit,
          ...(cursor ? { cursor } : {}),
        }, this.handshakeTimeoutMs);
        if (Array.isArray(res?.data)) out.push(...res.data);
        cursor = res?.nextCursor || null;
        if (!cursor) break;
      }
      return out;
    } finally {
      this.armIdle();
    }
  }

  /** 读一个会话的历史轮次（含每个 item 的完整内容，用于回填界面）。 */
  async listTurns({ threadId, limit = 200 } = {}) {
    this.clearIdle();
    try {
      await this.ensure();
      const res = await this.request("thread/turns/list", {
        threadId,
        itemsView: "full",
        limit,
        sortDirection: "asc",
      }, this.handshakeTimeoutMs);
      return Array.isArray(res?.data) ? res.data : [];
    } finally {
      this.armIdle();
    }
  }

  /**
   * 往一个正在跑的轮次追加输入（Codex 的 steer）。
   *
   * 协议是 `turn/steer { threadId, input } `，只在有 active turn 时可用 ——
   * 这正是"输入框在一轮跑着的时候仍然能发"的实现方式。
   */
  async steer({ threadId, prompt, images }) {
    const turn = this.turns.get(threadId);
    if (!turn) throw new Error("这个会话当前没有在跑的轮次");
    this.clearIdle();
    const attachments = Array.isArray(images)
      ? images.filter((p) => typeof p === "string" && p.trim()).slice(0, 8)
        .map((path) => ({ type: "localImage", path: path.trim() }))
      : [];
    const input = [...attachments, { type: "text", text: prompt }];
    try {
      await this.request("turn/steer", {
        threadId,
        input,
        ...(turn.turnId ? { expectedTurnId: turn.turnId } : {}),
      }, this.handshakeTimeoutMs);
      return true;
    } finally {
      this.armIdle();
    }
  }

  /** 给会话改名（ChatGPT 侧栏的重命名就是这条）。 */
  async renameThread(threadId, name) {
    this.clearIdle();
    try {
      await this.ensure();
      await this.request("thread/name/set", { threadId, name }, this.handshakeTimeoutMs);
      return true;
    } finally {
      this.armIdle();
    }
  }

  /** 删除会话（落盘文件一起删，不可恢复 —— 调用方要二次确认）。 */
  async deleteThread(threadId) {
    this.clearIdle();
    try {
      await this.ensure();
      await this.request("thread/delete", { threadId }, this.handshakeTimeoutMs);
      return true;
    } finally {
      this.armIdle();
    }
  }

  /** 中断一个正在进行中的会话。 */
  async interrupt(threadId) {
    const turn = this.turns.get(threadId);
    const params = { threadId };
    if (turn?.turnId) params.turnId = turn.turnId;
    try {
      await this.request("turn/interrupt", params, 10000);
      return true;
    } catch {
      return false;
    }
  }

  /** 某个会话是否正在跑。 */
  isBusy(threadId) {
    return this.turns.has(threadId);
  }

  failAll(message) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    this.pending.clear();
    for (const [threadId, turn] of this.turns) {
      clearTimeout(turn.timer);
      this.turns.delete(threadId);
      turn.settle({ status: "disconnected", error: { message } });
    }
    for (const [, entry] of this.approvals || []) {
      entry.resolved = true;
      clearTimeout(entry.timer);
    }
    if (this.approvals) this.approvals.clear();
  }

  /** 立即关闭子进程（强制路径）。 */
  kill(reason) {
    this.clearIdle();
    this.ready = null;
    // 换了进程就不认识任何 thread 了，必须清空，否则下一轮会拿旧 id 撞墙。
    this.liveThreads.clear();
    const child = this.child;
    if (!child) {
      this.failAll(`codex app-server 已关闭（${reason}）`);
      return;
    }
    this.child = null;
    terminate(child, this.killGraceMs, () => {});
    this.onStatus("stopped", reason);
    this.failAll(`codex app-server 已关闭（${reason}）`);
  }

  dispose() {
    this.disposed = true;
    this.kill("服务退出");
  }
}

/** turn/completed 的 items 里把 agentMessage 拼起来（兜底用）。 */
function collectItemText(items) {
  if (!Array.isArray(items)) return "";
  return items
    .filter((it) => it && it.type === "agentMessage" && typeof it.text === "string")
    .map((it) => it.text)
    .join("");
}
