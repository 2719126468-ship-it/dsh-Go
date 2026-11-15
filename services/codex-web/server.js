/**
 * codex-web 的本地 HTTP 服务。
 *
 * 只监听 127.0.0.1（跟 DSH 的 3080 错开），浏览器在手机本机上访问。
 * 路由就四条：
 *   GET  /               → 前端单页
 *   GET  /healthz        → 自检
 *   GET  /api/dirs       → 列子目录（工作目录面板用）
 *   GET  /api/config     → 工作目录、权限预设清单、沙箱在本机能不能用
 *   GET  /api/threads    → 这台机器上的 Codex 会话列表
 *   POST /api/thread/history → 某个会话的历史消息
 *   POST /api/thread     → 新会话
 *   POST /api/chat       → 发消息，SSE 流式回
 *   GET  /api/attach     → 断线重连：按 seq 补齐漏掉的事件后接着直播
 *   POST /api/interrupt  → 中断当前这一轮
 *
 * 发给前端的 SSE 事件（本项目自定义，不是 OpenAI 协议）：
 *   event: status       {state:"starting"|"ready"}
 *   event: thread       {threadId}          // 新建会话时告知前端
 *   event: delta        {text}
 *   event: tool         {id,name,input,label}
 *   event: tool_result  {id,output,status}
 *   event: usage        {used,window}     // 上下文窗口用量（可用 null）
 *   event: retry        {message,code}    // 上游出错但 app-server 会自己重试（不是失败）
 *   event: session      {cwd,mode,...}     // 本轮用的工作目录 / 权限模式 / 会话累计 tokens
 *   event: notice       {kind,message}     // 给用户的一句说明（比如沙箱在本机用不了）
 *   event: done         {reason,text}
 *   event: error        {message}
 */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { accessSync, chmodSync, constants as fsConstants, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CodexAppServer, ThreadGoneError, describe } from "./src/appserver.js";
import { createCwdGuard, realpathOrNull, withinRoot } from "./src/paths.js";
import { turnsToMessages, summarizeThread } from "./src/history.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3081);
const HOST = process.env.HOST || "127.0.0.1";
const WORKDIR = process.env.CODEX_WEB_CWD || homedir();
/**
 * 空闲回收。默认从 5 提到 30：手机上一次对话往往隔着刷消息、切后台，
 * 5 分钟就回收，下一条又撞 10–30s 冷启动。30 分钟内复用同一个 app-server。
 */
const IDLE_MINUTES = Number(process.env.CODEX_IDLE_MINUTES || 30);
const TURN_TIMEOUT_MINUTES = Number(process.env.CODEX_TURN_TIMEOUT_MINUTES || 30);
/** 启动时是否预热 codex app-server（设 CODEX_WEB_NO_PREWARM=1 关闭）。 */
const PREWARM = process.env.CODEX_WEB_NO_PREWARM !== "1";
const NO_AUTH = process.env.CODEX_WEB_NO_AUTH === "1" || process.argv.includes("--no-auth");
const TOKEN_FILE = join(homedir(), ".codex-web-token");
const NEW_TOKEN = process.argv.includes("--new-token");
const execFileAsync = promisify(execFile);

/**
 * 令牌持久化：第一次启动生成并写进 ~/.codex-web-token（0600），之后沿用，
 * 这样手机上存的令牌、主屏幕上的 PWA 重启服务后依然有效。
 * --new-token 强制重新生成；--no-auth 时完全不碰这个文件。
 * 用 homedir() 而不是 WORKDIR：CODEX_WEB_CWD 可能把 WORKDIR 指到别处。
 */
function loadOrCreateToken() {
  if (!NEW_TOKEN) {
    try {
      const saved = readFileSync(TOKEN_FILE, "utf8").trim();
      if (/^[0-9a-f]{32}$/.test(saved)) return { token: saved, source: "reused" };
    } catch { /* 还没有这个文件，往下新建 */ }
  }
  let existed = false;
  try { accessSync(TOKEN_FILE); existed = true; } catch { /* 第一次 */ }
  const token = randomBytes(16).toString("hex");
  try {
    // 直接写文件：这个分区禁了硬链接，不能用"写临时文件再 link"
    writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
    try { chmodSync(TOKEN_FILE, 0o600); } catch { /* mode 只在新建时生效，这里补一刀 */ }
  } catch (error) {
    console.warn(`⚠️ 令牌文件写不进去（${TOKEN_FILE}）：${error?.message || error}。本次令牌只在内存里，重启后会变。`);
  }
  return { token, source: existed ? "regenerated" : "generated" };
}
const { token: AUTH_TOKEN, source: TOKEN_SOURCE } = NO_AUTH
  ? { token: "", source: "disabled" }
  : loadOrCreateToken();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 60;
const RATE_BAN_MS = 5 * 60 * 1000;
const rateStates = new Map();

const DETACH_GRACE_MS = Math.max(0, Number(process.env.CODEX_DETACH_GRACE_SECONDS || 30) * 1000);
const SESSION_KEEP_MS = 90 * 1000;
const HEARTBEAT_MS = 10 * 1000;

/**
 * 前端构建号 = public/index.html 的内容哈希。
 * 手机上说"没出现工具卡片"那次，根因是页面是个很旧的标签页；有了这个号，
 * 服务端日志里一眼就能看出客户端跑的是哪一版。
 */
let buildCache = { stamp: "", build: "unknown" };
/**
 * 前端构建号 = index.html + app.css + app.js + markdown.js 的内容哈希。
 *
 * 只算 index.html 的话，改样式或逻辑（这两者才是日常改的东西）构建号不变，
 * 页面上那个"界面已更新，点此刷新"永远不会出现 —— 用户就只能看到一份旧界面
 * 却没有任何提示。四份一起算，任何一份变了都算新版本。
 */
async function currentBuild() {
  const files = ["index.html", "app.css", "app.js", "markdown.js"].map((n) => join(HERE, "public", n));
  const stats = await Promise.all(files.map((f) => stat(f).catch(() => null)));
  const stamp = stats.map((s) => (s ? s.mtimeMs + ":" + s.size : "-")).join("|");
  if (stamp !== buildCache.stamp) {
    const hash = createHash("sha1");
    for (const f of files) {
      try { hash.update(await readFile(f)); } catch { hash.update(""); }
    }
    buildCache = { stamp, build: hash.digest("hex").slice(0, 8) };
  }
  return buildCache.build;
}

/**
 * 带时间戳的一行日志。手机上报错时，这份日志是唯一的"另一端发生了什么"的证据。
 *
 * stdout 被 start.sh 重定向进 server.log，所以 log() 也是这个文件的写者之一；
 * 轮转检查挂在这里，否则只有 rejectRequest 那条路会触发轮转，正常日志涨到
 * 几十 MB 也没人管。
 */
const SERVER_LOG = join(HERE, "server.log");
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const LOG_ROTATE_CHECK_BYTES = 64 * 1024;
let logBytesSinceCheck = 0;
let rotating = null;

/**
 * 超过 5MB 就把当前内容快照进 server.log.1，然后清空重记。
 *
 * 为什么不用 rename：nohup 的 stdout 是"另一个 fd 指向同一个 inode"，rename
 * 之后那个 fd 还在写旧 inode（也就是 .1），两条日志流会分叉。copy+truncate
 * 只动内容不动 inode，stdout 追加与 appendFile 各自下一次写都落在新末尾。
 */
async function rotateServerLogIfNeeded() {
  if (rotating) return rotating;      // 同一时刻只轮转一次
  const task = (async () => {
    try {
      const st = await stat(SERVER_LOG);
      if (st.size <= LOG_ROTATE_BYTES) return;
      const data = await readFile(SERVER_LOG);
      // 只保留尾部 2MB 进备份，避免 5MB 快照反复吃满小存储
      const tail = data.subarray(Math.max(0, data.length - 2 * 1024 * 1024));
      await writeFile(`${SERVER_LOG}.1`, tail);
      await truncate(SERVER_LOG, 0);
      process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ↻ server.log 超过 ${Math.round(LOG_ROTATE_BYTES / 1024 / 1024)}MB，已轮转（备份留尾部 2MB → server.log.1）\n`);
    } catch { /* 轮转失败不拦正常日志 */ }
  })().finally(() => { rotating = null; });
  rotating = task;
  return task;
}

/** 每攒够 64KB 输出才做一次 stat 检查，别给每行日志加一次系统调用。 */
function maybeRotateLog(nbytes) {
  logBytesSinceCheck += nbytes;
  if (logBytesSinceCheck < LOG_ROTATE_CHECK_BYTES || rotating) return;
  logBytesSinceCheck = 0;
  rotateServerLogIfNeeded();
}

function log(...args) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${args.join(" ")}\n`;
  process.stdout.write(line);
  maybeRotateLog(Buffer.byteLength(line));
}
const short = (id) => String(id || "").slice(0, 8);

async function appendLogLine(line) {
  try {
    await rotateServerLogIfNeeded();
    await appendFile(SERVER_LOG, line);
  } catch { /* 日志写不进去不影响服务 */ }
}

function rejectRequest(req, res, status, reason) {
  const ip = req.socket.remoteAddress || "unknown";
  const line = `⚠️ 拦截 [${ip}] [${req.url || "/"}] 原因: [${reason}]`;
  console.warn(line);
  appendLogLine(`[${new Date().toISOString()}] ${line}\n`);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ error: status === 429 ? "请求过快" : "禁止访问" }));
}

function validHost(host) {
  return /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(host) || /^\[::1\](?::\d+)?$/.test(host);
}

function validToken(req, url) {
  if (!AUTH_TOKEN) return false;
  const supplied = url.searchParams.get("token") || req.headers["x-auth-token"] || "";
  const actual = Buffer.from(AUTH_TOKEN);
  const candidate = Buffer.from(Array.isArray(supplied) ? supplied[0] : supplied);
  if (candidate.length === 0) return false;
  return candidate.length === actual.length && timingSafeEqual(candidate, actual);
}

const RATE_STATES_MAX = 256;
function rateLimited(ip, now = Date.now()) {
  let state = rateStates.get(ip);
  if (state?.bannedUntil > now) return true;
  if (!state || now - state.windowStart >= RATE_WINDOW_MS) state = { windowStart: now, count: 0, bannedUntil: 0 };
  state.count += 1;
  if (state.count > RATE_LIMIT) state.bannedUntil = now + RATE_BAN_MS;
  rateStates.set(ip, state);
  // 只对端是 127.0.0.1，正常远达不到上限；真撞上了就把过期窗口清掉，别无界留着。
  if (rateStates.size > RATE_STATES_MAX) {
    for (const [key, s] of rateStates) {
      if (s.bannedUntil <= now && now - s.windowStart >= RATE_WINDOW_MS) rateStates.delete(key);
    }
  }
  return state.bannedUntil > now;
}

/**
 * 权限预设。**不拆成 sandbox / approval 两个独立下拉** —— 用户选一个预设，
 * 这里一次性决定 sandbox 与 approval，跟 Codex 自己的捆绑逻辑一致。
 *
 * 注意两套取值不一样：
 *   thread/start 收 `sandbox`（枚举字符串）
 *   turn/start   收 `sandboxPolicy`（对象）
 * 所以每个预设同时给出这两种形态。
 */
/**
 * 本机能不能真正跑沙箱。
 *
 * Codex 在 Linux 上用 bubblewrap 做 read-only / workspace-write；Android 上
 * 既没有 bwrap，也没有 user namespace，内核 4.14 更没有 Landlock。
 * 实测这两种模式的每一条命令都会直接失败：
 *   error building bubblewrap command: No such file or directory (os error 2)
 * 所以要在界面上说清楚，而不是让用户对着这行报错发懵。
 */
const BWRAP_AVAILABLE = (() => {
  for (const dir of String(process.env.PATH || "").split(":")) {
    if (!dir) continue;
    try { accessSync(join(dir, "bwrap"), fsConstants.X_OK); return true; } catch { /* 继续找 */ }
  }
  return false;
})();

/**
 * 三档沙箱 + 各自的默认审批策略。
 *
 * Codex App 把这件事拆成两个正交的开关（顶部工具栏的 "Suggest / Auto Edit /
 * Full Auto" + 设置里的审批策略），这里照同样的拆法：
 *   - `sandbox` 决定能碰什么（read-only / workspace-write / danger-full-access）
 *   - `approval` 决定什么时候停下来问你（untrusted / on-request / never）
 *
 * 默认组合跟 Codex 一致：越放开沙箱，越不需要问。
 */
const MODES = {
  "read-only": {
    label: "只读",
    short: "只读",
    desc: "只读，不修改任何文件",
    sandbox: "read-only",
    approval: "on-request",
    policy: () => ({ type: "readOnly", networkAccess: false }),
  },
  "workspace-write": {
    label: "可写工作区",
    short: "可写",
    desc: "可修改工作目录内文件，不联网（推荐）",
    sandbox: "workspace-write",
    approval: "on-request",
    policy: (cwd) => ({ type: "workspaceWrite", writableRoots: [cwd], networkAccess: false }),
  },
  "danger-full-access": {
    label: "全权限",
    short: "全权限",
    desc: "全权限，可改系统文件、联网",
    sandbox: "danger-full-access",
    approval: "on-request",
    policy: () => ({ type: "dangerFullAccess" }),
  },
};

/**
 * 审批策略（与沙箱正交）。
 *
 * `auto` = 跟随当前沙箱档的默认值。Android 无可用 OS 沙箱时，全权限也默认按需审批。
 * 只有用户显式选择 `never` 才会关闭审批；显式选 `on-request` 能让
 * 本机唯一能真正看到审批卡片的配置（Android 跑不了 bubblewrap，另两档起不来）。
 */
const APPROVALS = {
  auto: { label: "跟随沙箱档", short: "自动", desc: "使用当前权限档的安全默认审批策略" },
  "on-request": { label: "按需确认", short: "按需", desc: "Codex 想越界操作时弹卡片等你点" },
  untrusted: { label: "严格", short: "严格", desc: "非受信操作一律先问" },
  never: { label: "从不询问", short: "不问", desc: "全自动，不打断" },
};
const DEFAULT_APPROVAL = "auto";

function resolveApproval(raw, mode) {
  if (raw && APPROVALS[raw] && raw !== "auto") return raw;
  const m = MODES[mode];
  return (m && m.approval) || "never";
}
const DEFAULT_MODE = "danger-full-access";

/**
 * 默认模式：**恒定全权限**，不看 bwrap 探测结果。
 *
 * 以前是 `BWRAP_AVAILABLE ? "workspace-write" : "danger-full-access"`，那个写法
 * 留了一个隐蔽的坑：探测只找 PATH 里有没有 bwrap 这个可执行文件，而 Android 10
 * 上即使文件存在，user namespace / Landlock 也都没有，沙箱照样起不来。于是
 * "探测通过 → 默认 workspace-write → 新会话第一条命令就报
 * `error building bubblewrap command`"。
 *
 * 这台设备上没有"沙箱可用"这个状态，所以不再猜，直接锁死全权限。
 * BWRAP_AVAILABLE 仍然保留，但只用于在前端把另外两档标成不可选。
 */
const DEFAULT_MODE_RESOLVED = "danger-full-access";

/** 会话登记表：threadId -> {id, createdAt, title, turns, cwd, mode, tokens} */
const threads = new Map();
/** threads 上限：长期跑的服务不能让它无限涨，超出按插入顺序（≈时间顺序）淘汰最旧的。 */
const THREADS_MAX = 200;
/** /api/threads 缓存：thread/list 实测 1s+，前端连续打开会连击，先顶 10s */
const THREADS_CACHE_TTL_MS = 10000;
/** /api/models 缓存：模型目录基本不变，60s 足够，还能省掉一次 3s 的 app-server 往返 */
const MODELS_CACHE_TTL_MS = 60000;
let modelsCache = { at: 0, rows: null };

/**
 * Model（app-server 原始形状）→ 前端选择器要的形状。
 *
 * 只留渲染要用的字段：显示名、描述、可用推理档、默认档、是否默认。
 * 推理档的 description 也带上 —— ChatGPT 的模型菜单第二行就是那句话。
 */
function summarizeModel(m) {
  const efforts = Array.isArray(m?.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [];
  return {
    id: m?.id || m?.model || "",
    model: m?.model || m?.id || "",
    displayName: m?.displayName || m?.id || "model",
    description: m?.description || "",
    isDefault: Boolean(m?.isDefault),
    defaultEffort: m?.defaultReasoningEffort || "medium",
    efforts: efforts.map((e) => ({
      id: e?.reasoningEffort || "medium",
      description: e?.description || "",
    })),
    serviceTiers: (Array.isArray(m?.serviceTiers) ? m.serviceTiers : []).map((t) => ({
      id: t?.id || "", name: t?.name || t?.id || "", description: t?.description || "",
    })),
    inputModalities: Array.isArray(m?.inputModalities) ? m.inputModalities : ["text"],
  };
}
let threadsCache = { at: 0, limit: 0, rows: null };
const gitRootCache = new Map();
/** gitRootCache 上限：每个不同 cwd 一条，超了直接清空重算（代价只是几次 existsSync）。 */
const GIT_ROOT_CACHE_MAX = 100;

function findGitRoot(cwd) {
  if (!cwd) return null;
  if (gitRootCache.has(cwd)) return gitRootCache.get(cwd);
  let current = cwd;
  let root = null;
  try {
    while (true) {
      const candidate = join(current, ".git");
      if (existsSync(candidate) && statSync(candidate).isDirectory()) { root = current; break; }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch { root = null; }
  if (gitRootCache.size >= GIT_ROOT_CACHE_MAX) gitRootCache.clear();
  gitRootCache.set(cwd, root);
  return root;
}

const GIT_EXEC_OPTS = (() => {
  const env = { ...process.env, GIT_PAGER: "cat", LC_ALL: "C" };
  delete env.GIT_EXTERNAL_DIFF;
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return { timeout: 10000, maxBuffer: 32 * 1024 * 1024, env };
})();

async function gitDiffInfo(threadId, full = false) {
  const record = threads.get(threadId);
  if (!record || !record.cwd) return { isRepo: false, error: "unknown thread" };
  const root = findGitRoot(record.cwd);
  if (!root) return { isRepo: false };
  try {
    // -C 用仓库根：thread 的 cwd 可能是子目录，在那里跑 git diff 只看得到子树。
    // --no-pager 双保险：即使有人给 git 配了 pager，也不会让非 tty 子进程挂起等输入。
    const args = ["-C", root, "--no-pager", "diff"];
    if (full) {
      const { stdout } = await execFileAsync("git", args, GIT_EXEC_OPTS);
      // 先按字节切再解码：slice 字符串是在 UTF-16 码元上切，会切坏中文/多字节，
      // 前端渲染时正好在截断点上看到乱码。
      const cap = 200 * 1024;
      const buf = Buffer.byteLength(stdout, "utf8") > cap
        ? Buffer.from(stdout, "utf8").subarray(0, cap).toString("utf8") + "\n…（已截断）"
        : stdout;
      return { isRepo: true, diff: buf };
    }
    const [{ stdout: stat }, { stdout: status }] = await Promise.all([
      execFileAsync("git", [...args, "--stat"], GIT_EXEC_OPTS),
      execFileAsync("git", ["-C", root, "--no-pager", "status", "--porcelain"], GIT_EXEC_OPTS),
    ]);
    const last = stat.trim().split(/\r?\n/).pop() || "";
    const match = (re) => { const m = last.match(re); return m ? Number(m[1]) : 0; };
    return { isRepo: true, stat, status, fileCount: match(/(\d+) files? changed/), insertions: match(/(\d+) insertions?\(\+\)/), deletions: match(/(\d+) deletions?\(-\)/) };
  } catch (error) {
    if (error?.code === "ENOENT") return { isRepo: false, reason: "git not found" };
    return { isRepo: false, error: describe(error) };
  }
}

function rememberThread(threadId, { title, cwd, mode, model, effort, approval } = {}) {
  const prev = threads.get(threadId) || {};
  const rec = {
    id: threadId,
    createdAt: prev.createdAt || Date.now(),
    title: title !== undefined ? title : (prev.title || ""),
    turns: prev.turns || 0,
    cwd: cwd || prev.cwd || HOME(),
    mode: MODES[mode] ? mode : (prev.mode || DEFAULT_MODE_RESOLVED),
    model: model || prev.model || null,
    effort: effort || prev.effort || null,
    approval: APPROVALS[approval] && approval !== "auto" ? approval : (prev.approval || DEFAULT_APPROVAL),
    tokens: prev.tokens || 0,
  };
  threads.set(threadId, rec);
  // Map 的插入序≈会话创建序（重复 set 不改位置），超出上限就从最旧的一头淘汰。
  while (threads.size > THREADS_MAX) {
    const oldest = threads.keys().next();
    if (oldest.done) break;
    threads.delete(oldest.value);
  }
  // 新会话会让 /api/threads 的 10s 缓存过期，下次重查，避免抽屉里看不到刚建的会话。
  if (!prev.id) threadsCache.at = 0;
  return rec;
}
/**
 * cwd 守卫（见 src/paths.js）：resolve → realpath → 用 path.relative 判断真的在根之下。
 * 软链逃逸、`/etc`、`/`、`..` 都会被挡住。
 *
 * 不存在的路径不再直接判死：返回 {ok:true, exists:false, path}，
 * 要不要"必须存在"由各调用方自己决定（历史上都是必须存在，所以下面照旧挡）。
 */
const normalizeCwd = createCwdGuard(WORKDIR);
const WORKDIR_REAL = await normalizeCwd.realRoot();
const HOME = () => WORKDIR_REAL;

/** 目录必须真实存在才算通过：给 /api/thread、/api/chat、/api/dirs 共用。 */
function cwdFailure(target) {
  if (!target.ok) return target.error;
  if (!target.exists) return "目录不存在";
  return null;
}

function modeOf(raw, fallback) {
  if (MODES[raw]) {
    // 沙箱用不了的模式仍然允许显式选择（用户可能想自己踩一次），
    // 但调用方都会拿到明确的不可用提示。
    return raw;
  }
  return MODES[fallback] ? fallback : DEFAULT_MODE_RESOLVED;
}

/** 正在直播的轮次：threadId -> TurnSession。断线重连要靠它把丢掉的那段补回来。 */
const sessions = new Map();

/**
 * 一轮对话的直播流。
 *
 * 为什么要这个东西：手机网络抖一下、浏览器把后台标签页冻住、我自己重启服务，
 * 都会让 SSE 连接断掉。以前一断就 `interrupt` 把这一轮掐死，用户看到的就是
 * 一个光秃秃的 "network error"。现在断线只是"暂时没人看"，事件继续进缓冲区，
 * 客户端拿 seq 重连（GET /api/attach）就能把断掉那段补回来接着看。
 */
class TurnSession {
  constructor(threadId) {
    this.threadId = threadId;
    this.seq = 0;
    this.frames = [];
    this.sse = null;
    this.finished = false;
    this.detachTimer = null;
    this.cleanupTimer = null;
    this.onAbandon = null;
  }

  emit(event, data) {
    const frame = { seq: ++this.seq, event, data };
    this.frames.push(frame);
    if (this.frames.length > 5000) this.frames.splice(0, 1000);
    if (this.sse && !this.sse.closed) this.sse.send(event, data, frame.seq);
    return frame.seq;
  }

  attach(sse) {
    this.resume();
    this.sse = sse;
  }

  /** 客户端断开：不要立刻杀这一轮，给一个窗口等它回来。 */
  detach(sse) {
    if (this.sse !== sse) return;
    this.sse = null;
    if (this.finished || this.detachTimer) return;
    log(`  ⚠ 客户端断开 thread=${short(this.threadId)} seq=${this.seq}，${DETACH_GRACE_MS / 1000}s 内重连可续，否则中断`);
    this.detachTimer = setTimeout(() => {
      this.detachTimer = null;
      if (this.finished) return;
      log(`  ✗ 超过 ${DETACH_GRACE_MS / 1000}s 没人回来，中断 thread=${short(this.threadId)}`);
      this.onAbandon?.();
    }, DETACH_GRACE_MS);
    this.detachTimer.unref?.();
  }

  resume() {
    if (!this.detachTimer) return;
    clearTimeout(this.detachTimer);
    this.detachTimer = null;
    log(`  ✓ 客户端回来了 thread=${short(this.threadId)} seq=${this.seq}`);
  }

  closeClient() {
    const sse = this.sse;
    this.sse = null;
    sse?.close();
  }

  finish() {
    this.finished = true;
    this.resume();
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = setTimeout(() => {
      if (sessions.get(this.threadId) === this) sessions.delete(this.threadId);
    }, SESSION_KEEP_MS);
    this.cleanupTimer.unref?.();
  }
}

const codex = new CodexAppServer({
  cwd: WORKDIR,
  idleTimeoutMs: IDLE_MINUTES * 60 * 1000,
  turnTimeoutMs: TURN_TIMEOUT_MINUTES * 60 * 1000,
});

/**
 * 版本门。上游中转站校验调用方是不是最新版 Codex 客户端，版本旧了任何请求都
 * 被挡在门外（HTTP 403，报文含 codex_access_restricted），而它的迷惑之处在于
 * 同一 key 同一接口返回会飘，排查时很容易误判成"key 失效 / 余额不足 / WAF"。
 *
 * 所以启动时异步探一次 `codex --version`（只读，不阻塞服务，失败也不致命），
 * 低于本机验证过的下限就在启动日志点名，结果同时挂在 /healthz.codex 上，
 * 让 403 先排除"客户端版本旧"这一档。下限取 README 里实测能用的 0.162。
 */
const CODEX_MIN_FLOOR = [0, 162];
const TERMUX_PREFIX = process.env.PREFIX || "/data/data/com.termux/files/usr";
let codexVersion = { raw: null, tooOld: null, error: null };

function parseCodexVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

async function probeCodexVersion() {
  try {
    const env = { ...process.env };
    env.PATH = [join(homedir(), ".local", "bin"), join(TERMUX_PREFIX, "bin"), env.PATH].filter(Boolean).join(":");
    const { stdout } = await execFileAsync(codex.codexPath, ["--version"], { timeout: 20000, env });
    const raw = String(stdout).trim();
    const semver = parseCodexVersion(raw);
    const tooOld = semver ? (semver[0] < CODEX_MIN_FLOOR[0]
      || (semver[0] === CODEX_MIN_FLOOR[0] && semver[1] < CODEX_MIN_FLOOR[1])) : null;
    codexVersion = { raw, tooOld, error: null };
    if (tooOld) {
      log(`⚠ Codex 版本 ${raw} 低于本机验证过的下限 0.162 —— 上游很可能回 403 codex_access_restricted，`
        + `请按 README「在 Termux / Android 上升级 Codex」升级。`);
    }
  } catch (error) {
    // 探不到不拦启动：/healthz 里如实标 unknown，让用户知道探测没成功。
    codexVersion = { raw: null, tooOld: null, error: describe(error).slice(0, 200) };
  }
}

// 进程退出时把 codex 子进程树一起带走，别留孤儿 proot。
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    codex.dispose();
    process.exit(0);
  });
}
process.on("exit", () => { try { codex.dispose(); } catch { /* 尽力而为 */ } });

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * 打开一条 SSE 通道，返回 send(event, data, id) / close()。
 *
 * 两个细节很重要：
 *   1. **建连后立刻写一个注释行**。冷启动那几秒线上一个字节都没有，
 *      任何"多久没数据就掐"的东西都可能在这里动手；先发一个字节把这段填上。
 *   2. 每个事件带 `id:`，客户端据此记录 seq，断线后用 /api/attach?since= 续传。
 */
function openSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let closed = false;
  const send = (event, data, id) => {
    if (closed || res.writableEnded) return;
    try {
      const head = id === undefined ? "" : `id: ${id}\n`;
      res.write(`${head}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      closed = true;
    }
  };

  // 立刻一个字节，别让开头那几秒是空的
  try { res.write(": keepalive\n\n"); } catch { closed = true; }

  const heartbeat = setInterval(() => {
    if (closed || res.writableEnded) return;
    try { res.write(": keepalive\n\n"); } catch { closed = true; }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  // 连接没了就把定时器收掉，否则每次断线都留一个 10 秒的定时器在跑。
  res.on("close", () => { closed = true; clearInterval(heartbeat); });

  return {
    send,
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      try { res.end(); } catch { /* 已经断了 */ }
    },
    get closed() { return closed; },
  };
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

async function handleThread(req, res) {
  let body = {};
  try { body = await readBody(req); } catch { body = {}; }

  const want = await normalizeCwd(body.cwd ?? WORKDIR_REAL);
  const wantErr = cwdFailure(want);
  if (wantErr) { json(res, 400, { error: wantErr }); return; }
  const mode = modeOf(body.mode, DEFAULT_MODE);
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
  const effort = typeof body.effort === "string" && body.effort.trim() ? body.effort.trim() : null;
  const approval = typeof body.approval === "string" && APPROVALS[body.approval]
    ? body.approval : DEFAULT_APPROVAL;

  const threadId = await codex.startThread({
    cwd: want.path, sandboxMode: MODES[mode].sandbox, model, effort,
    approvalPolicy: resolveApproval(approval, mode),
  });
  rememberThread(threadId, { cwd: want.path, mode, model, effort, approval, title: "" });
  json(res, 200, { threadId, cwd: want.path, mode, model, effort, approval });
}

/** 列目录：只给子目录（不给文件），供前端的面板浏览。 */
async function handleDirs(req, res, url) {
  const raw = url.searchParams.get("path") || WORKDIR_REAL;
  const target = await normalizeCwd(raw);
  const targetErr = cwdFailure(target);
  if (targetErr) { json(res, 400, { error: targetErr }); return; }

  let entries;
  try {
    entries = await readdir(target.path, { withFileTypes: true });
  } catch (error) {
    json(res, 403, { error: `读不了这个目录：${describe(error)}` });
    return;
  }

  const dirs = [];
  for (const entry of entries) {
    const full = join(target.path, entry.name);
    let isDir = entry.isDirectory();
    let blocked = false;
    if (!isDir && entry.isSymbolicLink()) {
      // 软链接指向目录的也列出来（比如 ~/storage）。先 realpath 看它真实指向哪：
      // 逃出工作目录的只列出来并标 blocked（前端灰显、点不进去），不进 stat 详情。
      const real = await realpathOrNull(full);
      if (real) {
        if (!withinRoot(WORKDIR_REAL, real)) {
          isDir = true;
          blocked = true;
        } else {
          try { isDir = (await stat(real)).isDirectory(); } catch { isDir = false; }
        }
      }
    }
    if (isDir) dirs.push(blocked ? { name: entry.name, path: full, symlink: true, blocked: true } : { name: entry.name, path: full });
  }
  dirs.sort((a, b) => {
    const da = a.name.startsWith(".") ? 1 : 0;
    const db = b.name.startsWith(".") ? 1 : 0;
    if (da !== db) return da - db;                       // 隐藏目录排后面
    return a.name.localeCompare(b.name, "zh");
  });

  const parent = target.path === WORKDIR_REAL ? null : dirname(target.path);
  json(res, 200, { path: target.path, parent, home: WORKDIR_REAL, dirs });
}

async function handleChat(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    json(res, 400, { error: describe(error) });
    return;
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  // 图片附件：前端先 POST /api/upload 拿到绝对路径，这里再带上来。
  // 只收「在 $HOME 之下、真实存在、扩展名是图片」的路径，别把它变成任意文件读取口子。
  const images = [];
  if (Array.isArray(body.images)) {
    for (const raw of body.images.slice(0, 8)) {
      if (typeof raw !== "string" || !raw.trim()) continue;
      const checked = await normalizeCwd(raw.trim());
      if (!checked.ok || !checked.exists) continue;
      const p = checked.path;
      if (!/\.(png|jpe?g|gif|webp|bmp)$/i.test(p)) continue;
      try { if (!statSync(p).isFile()) continue; } catch { continue; }
      images.push(p);
    }
  }
  if (!message && !images.length) {
    json(res, 400, { error: "message 不能为空" });
    return;
  }

  // 客户端跑的是哪一版界面？对不上就是"旧标签页"，说明为什么没看到新功能。
  const clientBuild = String(req.headers["x-codex-web-build"] || "unknown");
  const serverBuild = await currentBuild();
  const buildKnown = clientBuild && clientBuild !== "unknown" && clientBuild !== "dev";
  if (buildKnown && clientBuild !== serverBuild) {
    log(`⚠ 客户端界面是旧版（客户端=${clientBuild} 服务端=${serverBuild}）—— 让用户刷新页面`);
  }

  // 这一轮用哪个目录、哪个权限：请求里带优先，否则用会话记住的，再否则用默认。
  const reqCwdRaw = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd : null;
  let reqCwd = null;
  if (reqCwdRaw) {
    const checked = await normalizeCwd(reqCwdRaw);
    const checkedErr = cwdFailure(checked);
    if (checkedErr) { json(res, 400, { error: checkedErr }); return; }
    reqCwd = checked.path;
  }

  const sse = openSse(req, res);
  let interrupted = false;
  let threadId = typeof body.threadId === "string" && body.threadId ? body.threadId : null;
  /** @type {TurnSession|null} */
  let session = null;
  const pendingEvents = [];
  let disconnectedBeforeSession = false;

  const priorRecord = threadId ? threads.get(threadId) : null;
  const cwd = reqCwd || priorRecord?.cwd || WORKDIR_REAL;
  const mode = modeOf(body.mode, priorRecord?.mode || DEFAULT_MODE);
  // 模型 / 推理档：请求里带优先，否则用这条会话记住的。
  const model = typeof body.model === "string" && body.model.trim()
    ? body.model.trim() : (priorRecord?.model || null);
  const effort = typeof body.effort === "string" && body.effort.trim()
    ? body.effort.trim() : (priorRecord?.effort || null);
  // 审批策略：请求里带优先，否则用会话记住的，再否则跟随沙箱档。
  const approval = typeof body.approval === "string" && APPROVALS[body.approval]
    ? body.approval : (priorRecord?.approval || DEFAULT_APPROVAL);
  const approvalPolicy = resolveApproval(approval, mode);
  const modeDef = MODES[mode];
  const sandboxPolicy = modeDef.policy(cwd);
  let sandboxWarned = false;

  // 客户端断开（切后台、刷新、网络抖动、我自己重启服务）先不杀这一轮：
  // 交给 TurnSession 记着，窗口内重连上来就接着看，超时才中断省 token。
  res.on("close", () => {
    if (res.writableEnded) return;
    if (session) session.detach(sse);
    else disconnectedBeforeSession = true;
  });

  /** 事件统一走 session.emit；会话建立前的事件先排队，避免绕过断线重放缓冲。 */
  const emit = (event, data) => {
    if (session) return session.emit(event, data);
    pendingEvents.push({ event, data });
  };

  try {
    if (!threadId) {
      if (!codex.isReady()) emit("status", { state: "starting" });
      threadId = await codex.startThread({ cwd, sandboxMode: modeDef.sandbox, model, effort, approvalPolicy });
      rememberThread(threadId, { cwd, mode, model, effort, approval, title: message.slice(0, 40) });
      emit("thread", { threadId, cwd, mode, model, effort, approval });
    } else if (!codex.isReady()) {
      // 已有会话但 app-server 已被空闲回收：前端要重新显示"启动中"。
      emit("status", { state: "starting" });
    } else if (codex.isBusy(threadId)) {
      // 这里不关流：交给 finally 的 else 先 drain 再 close，否则这条 error 会被吃掉。
      emit("error", { message: "这个会话还有一轮没跑完" });
      return;
    }

    await codex.ensure();
    const rec = rememberThread(threadId, { cwd, mode, model, effort, approval });
    emit("status", { state: "ready" });
    emit("session", {
      threadId, cwd, mode, model, effort, approval, approvalPolicy,
      modeLabel: modeDef.label, modeDesc: modeDef.desc,
      tokens: rec.tokens || 0,
      sandboxEnforced: BWRAP_AVAILABLE,
    });

    // 到这一步 threadId 已经确定，可以建直播会话了。
    sessions.get(threadId)?.finish();
    session = new TurnSession(threadId);
    session.onAbandon = () => {
      interrupted = true;
      codex.interrupt(threadId).catch(() => {});
    };
    session.attach(sse);
    sessions.set(threadId, session);
    for (const { event, data } of pendingEvents) session.emit(event, data);
    pendingEvents.length = 0;
    if (disconnectedBeforeSession) session.detach(sse);
    log(`▶ 开始 thread=${short(threadId)}`);

    const record = threads.get(threadId);
    if (record) {
      record.turns += 1;
      if (!record.title) record.title = message.slice(0, 40);
    }

    // 逐轮埋点：手机上说"感觉跑了几分钟"的时候，这里能给出三段分别多久，
    // 以及 tool / tool_delta 这些事件到底有没有发出去。
    const turnT0 = Date.now();
    const counts = new Map();
    let firstDeltaAt = 0, firstToolAt = 0, toolDoneAt = 0, countRetry = 0;
    /** 401/403 只处理一次：真正的重试由 Codex 内部在跑，我们只负责早停。 */
    let fatalAuthRetry = false;
    const since = (t) => (t ? `+${((t - turnT0) / 1000).toFixed(1)}s` : "—");

    const onEvent = (event) => {
        counts.set(event.type, (counts.get(event.type) || 0) + 1);
        if (event.type === "delta" && !firstDeltaAt) firstDeltaAt = Date.now();
        if (event.type === "tool" && !firstToolAt) firstToolAt = Date.now();
        if (event.type === "tool_result" && !toolDoneAt) toolDoneAt = Date.now();
        switch (event.type) {
          case "delta":
            emit("delta", { text: event.text });
            break;
          case "tool":
            emit("tool", { id: event.id, name: event.name, input: event.input, label: event.label });
            break;
          case "approval":
            emit("approval", {
              id: event.id, method: event.method,
              command: event.command, cwd: event.cwd, reason: event.reason,
              changes: event.changes, permissions: event.permissions,
            });
            break;
          case "approval_resolved":
            emit("approval_resolved", { id: event.id, choice: event.choice, timeout: event.timeout || false });
            break;
          case "reasoning_summary":
            emit("reasoning", { id: event.id, text: event.text, kind: "summary" });
            break;
          case "reasoning_text":
            emit("reasoning", { id: event.id, text: event.text, kind: "raw" });
            break;
          case "reasoning_done":
            emit("reasoning_done", { id: event.id, summary: event.summary });
            break;
          case "plan":
            emit("plan", { items: event.items, explanation: event.explanation });
            break;
          case "plan_delta":
            emit("plan_delta", { id: event.id, text: event.text });
            break;
          case "plan_text":
            emit("plan_text", { id: event.id, text: event.text });
            break;
          case "turn_diff":
            emit("turn_diff", { diff: event.diff });
            break;
          case "tool_result": {
            emit("tool_result", {
              id: event.id, output: event.output, status: event.status,
              durationMs: event.durationMs ?? null, exitCode: event.exitCode ?? null,
            });
            // 沙箱跑不起来是这台设备的硬限制，与其让用户看到一行看不懂的报错，
            // 不如直接说清楚该怎么办。一轮最多提示一次。
            if (!sandboxWarned && mode !== "danger-full-access"
                && typeof event.output === "string" && /bubblewrap|bwrap|user.?namespace|landlock/i.test(event.output)) {
              sandboxWarned = true;
              emit("notice", {
                kind: "sandbox",
                message: `「${modeDef.label}」模式需要 bubblewrap 沙箱，这台设备用不了`
                  + `（Android 没有 user namespace，内核也没有 Landlock）。`
                  + `命令根本没法执行 —— 请在权限模式里换成「全权限」。`,
              });
            }
            break;
          }
          case "tool_delta":
            emit("tool_delta", { id: event.id, text: event.text });
            break;
          case "usage": {
            // 会话累计 tokens：直接用 Codex 自己报的 thread 累计值，
            // 不自己逐轮相加（那样会把同一条通知加重复）。
            const r = threads.get(threadId);
            if (r && typeof event.used === "number") r.tokens = event.used;
            emit("usage", {
              used: event.used, window: event.window,
              input: event.input ?? null, cached: event.cached ?? null,
              output: event.output ?? null, reasoning: event.reasoning ?? null,
            });
            break;
          }
          case "error":
            emit("error", { message: event.message });
            break;
          // app-server 自己会重试的错（willRetry=true）：不是失败，
          // 单独发一个事件让前端显示成"重试中"，别弹红框。
          case "retry":
            log(`   ⚠ 上游错误将重试 code=${event.code || "?"} ${String(event.message).slice(0, 120)}`);
            countRetry += 1;
            // 401/402/403 是认证或计费类错误，Codex 自己重试 5 次纯属烧时间
            // （实测烧掉 173s 才失败）。第一次见到就中断这一轮，把原因说清楚。
            // 实测：余额不足时上游流式接口回 402，带 codex 头时回 403。
            // code 未必带数字：CodexErrorInfo 是字符串枚举（Unauthorized/
            // PaymentRequired…）或解析不到 httpStatusCode 时，状态码只出现在
            // message 文本里，所以两个都查。
            // 其余（断流、超时、5xx）交给 Codex 自己重试。
            const authBlob = `${event.code || ""} ${event.message || ""}`;
            const authish = /\b(?:401|402|403)\b/.test(authBlob)
              || /codex_access_restricted|Invalid API key|unauthorized|payment.?required|insufficient.(?:balance|credit|quota)|余额不足|额度不足/i.test(authBlob);
            if (!fatalAuthRetry && authish) {
              fatalAuthRetry = true;
              emit("error", {
                message: `上游拒绝这一轮（${event.code || "认证/计费类错误"}），重试没有意义，已停止。\n`
                  + `上游原文：${String(event.message || "").replace(/^Reconnecting\.\.\. \d+\/\d+｜?/, "").trim() || "（无）"}\n`
                  + `按这个顺序查：① 账户余额 / Codex 订阅额度（"没有可用的 Codex 订阅额度或余额"就是这条）；`
                  + `② SHAREDCHAT_API_KEY 失效；③ 客户端版本过旧（报文含 codex_access_restricted 时升级 codex，`
                  + `本机并列安装 ~/.local/codex-<版本>/bin/codex 即可，服务会自动挑最高版本）。`,
              });
              codex.interrupt(threadId).catch(() => {});
              break;
            }
            emit("retry", { message: event.message, code: event.code });
            break;
          // message_final 不进 SSE：它的全文并进 done.text 一起给，
          // 前端在收尾时校正一次即可（契约里就这几种事件）。
          default:
            break;
        }
    };

    // 会话接不回来（app-server 被回收过、磁盘上也没了）就自动开个新的接着聊，
    // 而不是把 "thread not found" 甩给用户。只重试一次。
    let result;
    try {
      result = await codex.runTurn({ threadId, prompt: message, images, onEvent, cwd, sandboxPolicy, model, effort, approvalPolicy });
    } catch (error) {
      if (!(error instanceof ThreadGoneError)) throw error;
      threadId = await codex.startThread({ cwd, sandboxMode: modeDef.sandbox, model, effort, approvalPolicy });
      rememberThread(threadId, { cwd, mode, model, effort, approval, title: message.slice(0, 40) });
      emit("thread", { threadId, cwd, mode, model, effort, approval, reset: true, reason: "上一轮的会话上下文已经过期，已自动开始新会话。" });
      result = await codex.runTurn({ threadId, prompt: message, images, onEvent, cwd, sandboxPolicy, model, effort, approvalPolicy });
    }

    if (interrupted) {
      emit("done", { reason: "interrupted", text: result.text || "" });
    } else if (result.status === "completed") {
      emit("done", { reason: "completed", text: result.text || "" });
    } else if (result.status === "interrupted") {
      emit("done", { reason: "interrupted", text: result.text || "" });
    } else if (result.status === "timeout") {
      emit("error", { message: result.error?.message || "这一轮超时了" });
      emit("done", { reason: "timeout" });
    } else {
      emit("error", { message: result.error?.message || `这一轮以 ${result.status} 结束` });
      emit("done", { reason: result.status });
    }
    log(`■ 结束 thread=${short(threadId)} status=${result.status} 用时=${((Date.now() - turnT0) / 1000).toFixed(1)}s`);
    log(`   阶段 首字=${since(firstDeltaAt)} 首个工具=${since(firstToolAt)} 工具结束=${since(toolDoneAt)}`);
    log(`   事件 ${[...counts].map(([k, v]) => `${k}=${v}`).join(" ") || "（无）"}${countRetry ? ` 上游重试=${countRetry} 次` : ""}`);
  } catch (error) {
    emit("error", { message: describe(error) });
    emit("done", { reason: "error" });
    log(`■ 出错 thread=${short(threadId)} ${describe(error)}`);
  } finally {
    if (session) {
      session.finish();
      session.closeClient();
    } else {
      for (const { event, data } of pendingEvents) sse.send(event, data);
      sse.close();
    }
  }
}

/**
 * 断线重连：把这一轮已经发过、但客户端没收到的事件按 seq 补发，然后接着直播。
 * 前端把它当成同一条流的续集，不需要任何特殊处理。
 */
async function handleAttach(req, res, url) {
  const threadId = url.searchParams.get("threadId") || "";
  const since = Number(url.searchParams.get("since") || 0) || 0;
  if (!threadId) {
    json(res, 400, { error: "threadId 必填" });
    return;
  }
  const session = sessions.get(threadId);
  if (!session) {
    json(res, 404, { error: "这一轮已经不在了" });
    return;
  }

  const sse = openSse(req, res);
  res.on("close", () => {
    if (res.writableEnded) return;
    session.detach(sse);
  });

  const missed = session.frames.filter((f) => f.seq > since);
  log(`⟳ 重连 thread=${short(threadId)} since=${since} 补发 ${missed.length} 条`);
  for (const f of missed) sse.send(f.event, f.data, f.seq);

  if (session.finished) {
    sse.close();
    return;
  }
  session.attach(sse);
  // 故意不 end：连接保持打开，后面的事件继续从这里出去。
}

async function handleInterrupt(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    body = {};
  }
  const threadId = typeof body.threadId === "string" ? body.threadId : "";
  if (!threadId) {
    json(res, 400, { error: "threadId 必填" });
    return;
  }
  const ok = await codex.interrupt(threadId);
  json(res, 200, { ok, threadId });
}

/**
 * 静态资源白名单（PWA 用）。写死表而不是拼路径，天然没有目录穿越问题。
 */
const STATIC = new Map([
  // 前端三件套（样式 / markdown 渲染器 / 主逻辑）。开发期 no-store，改完刷新即生效。
  ["/app.css", ["public/app.css", "text/css; charset=utf-8"]],
  ["/app.js", ["public/app.js", "text/javascript; charset=utf-8"]],
  ["/markdown.js", ["public/markdown.js", "text/javascript; charset=utf-8"]],
  ["/manifest.webmanifest", ["public/manifest.webmanifest", "application/manifest+json; charset=utf-8"]],
  ["/sw.js", ["public/sw.js", "text/javascript; charset=utf-8"]],
  ["/icons/icon-192.png", ["public/icons/icon-192.png", "image/png"]],
  ["/icons/icon-512.png", ["public/icons/icon-512.png", "image/png"]],
  ["/icons/maskable-512.png", ["public/icons/maskable-512.png", "image/png"]],
]);

const server = createServer(async (req, res) => {
  const host = req.headers.host || "";
  if (!NO_AUTH && !validHost(host)) {
    rejectRequest(req, res, 403, "Host错误");
    return;
  }
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const path = url.pathname;
  const method = req.method || "GET";
  // 公开路径：页面壳、PWA 素材、自检。浏览器自己发起的请求（导航到 /、拉 manifest、
  // 注册 sw.js、取图标）带不了令牌；这些文件里没有机密，数据都在 /api/* 后面。
  const isPublic = method === "GET"
    && (path === "/" || path === "/index.html" || path === "/healthz" || STATIC.has(path));
  if (!NO_AUTH && !isPublic && !validToken(req, url)) {
    rejectRequest(req, res, 403, "Token错误");
    return;
  }
  if (!NO_AUTH && path.startsWith("/api/") && rateLimited(req.socket.remoteAddress || "unknown")) {
    rejectRequest(req, res, 429, "请求过快");
    return;
  }
  const started = Date.now();
  const isStream = path === "/api/chat" || path === "/api/attach";

  // 手机端出问题时，这行日志是唯一能说明"另一端到底有没有再连上来"的证据。
  if (path !== "/healthz" && !path.startsWith("/icons/")) {
    log(`→ ${method} ${path}${isStream ? " (SSE 开始)" : ""}`);
  }
  res.on("finish", () => {
    if (path !== "/healthz" && !path.startsWith("/icons/")) {
      log(`← ${method} ${path} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });

  try {
    if (method === "GET" && (path === "/" || path === "/index.html")) {
      const html = await readFile(join(HERE, "public", "index.html"));
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": html.length,
        "Cache-Control": "no-store",
      });
      res.end(html);
      return;
    }

    if (method === "GET" && STATIC.has(path)) {
      const [rel, type] = STATIC.get(path);
      const body = await readFile(join(HERE, rel));
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": body.length,
        // sw.js 与前端三件套都不缓存：改了要能立刻看到，否则"为什么我的改动没生效"
        // 会变成排查半小时的谜案。
        "Cache-Control": (path === "/sw.js" || path === "/app.css" || path === "/app.js" || path === "/markdown.js")
          ? "no-store"
          : "public, max-age=86400",
      });
      res.end(body);
      return;
    }

    if (method === "GET" && path === "/api/config") {
      json(res, 200, {
        home: WORKDIR_REAL,
        defaultMode: DEFAULT_MODE_RESOLVED,
        sandboxAvailable: BWRAP_AVAILABLE,
        sandboxReason: BWRAP_AVAILABLE ? null
          : "这台设备没有 bubblewrap（Android 没有 user namespace，内核 4.14 也没有 Landlock），"
            + "只读 / 可写工作区这两档的命令会直接失败。",
        modes: Object.entries(MODES).map(([id, m]) => ({
          id, label: m.label, short: m.short, desc: m.desc,
          available: id === "danger-full-access" ? true : BWRAP_AVAILABLE,
          // 这一档默认问不问
          defaultApproval: m.approval,
        })),
        defaultApproval: DEFAULT_APPROVAL,
        approvals: Object.entries(APPROVALS).map(([id, a]) => ({
          id, label: a.label, short: a.short, desc: a.desc,
        })),
      });
      return;
    }

    // 模型目录：前端「模型选择器」的数据源。直接来自 app-server 的 model/list，
    // 不在前端写死模型名 —— 上游换了模型，这里跟着变。
    if (method === "GET" && path === "/api/models") {
      const now = Date.now();
      if (!modelsCache.rows || now - modelsCache.at > MODELS_CACHE_TTL_MS) {
        try {
          const rows = await codex.listModels({ includeHidden: false });
          modelsCache = { at: Date.now(), rows };
        } catch (error) {
          if (modelsCache.rows) {
            json(res, 200, { models: modelsCache.rows.map(summarizeModel), stale: true });
            return;
          }
          json(res, 502, { error: describe(error), models: [] });
          return;
        }
      }
      json(res, 200, { models: modelsCache.rows.map(summarizeModel) });
      return;
    }

    if (method === "GET" && path === "/api/diff") {
      json(res, 200, await gitDiffInfo(url.searchParams.get("threadId") || ""));
      return;
    }

    if (method === "GET" && path === "/api/diff/full") {
      json(res, 200, await gitDiffInfo(url.searchParams.get("threadId") || "", true));
      return;
    }

    if (method === "GET" && path === "/api/dirs") {
      await handleDirs(req, res, url);
      return;
    }

    if (method === "GET" && path === "/api/version") {
      json(res, 200, { build: await currentBuild() });
      return;
    }

    if (method === "GET" && path === "/healthz") {
      json(res, 200, {
        ok: true,
        appServer: { running: codex.isRunning(), ready: codex.isReady() },
        threads: threads.size,
        cwd: WORKDIR,
        port: PORT,
        codex: { version: codexVersion.raw, tooOld: codexVersion.tooOld, error: codexVersion.error },
      });
      return;
    }

    if (method === "GET" && path === "/api/threads") {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 50)));
      try {
        const now = Date.now();
        const hit = threadsCache.rows && threadsCache.limit === limit
          && now - threadsCache.at < THREADS_CACHE_TTL_MS;
        let rows = hit ? threadsCache.rows : null;
        if (!rows) {
          rows = await codex.listThreads({ limit });
          threadsCache = { at: Date.now(), limit, rows };
        }
        // `generating` 让会话列表能标出"这条正在跑"，前端据此决定要不要接流。
        json(res, 200, {
          threads: rows.map((row) => ({ ...summarizeThread(row), generating: codex.isBusy(row.id) })),
          cached: Boolean(hit),
        });
      } catch (error) {
        json(res, 502, { error: describe(error), threads: [] });
      }
      return;
    }

    // 页面加载 / 切回前台时问一句：有没有哪一轮还在后台跑？
    //
    // 这是"刷新页面会杀掉正在生成的任务"的正面解法：页面根本没有本地状态，
    // 它必须能从服务端问出"现在有什么在跑、跑到第几条了"，然后 /api/attach
    // 接回来。没有这个端点，刷新就只能傻等 30 秒宽限期被熬完然后中断。
    if (method === "GET" && path === "/api/active") {
      const active = [];
      for (const [id, session] of sessions) {
        if (session.finished) continue;
        const known = threads.get(id);
        active.push({
          threadId: id,
          seq: session.seq,
          cwd: known?.cwd || null,
          mode: known?.mode || null,
          model: known?.model || null,
          effort: known?.effort || null,
          approval: known?.approval || DEFAULT_APPROVAL,
          title: known?.title || "",
        });
      }
      json(res, 200, { active });
      return;
    }

    // 点开会话列表里的一条 → 把它已有的对话回填给前端
    // 图片附件上传。
    //
    // 为什么不直接让前端把 base64 塞进 /api/chat：app-server 的 localImage
    // 只吃**绝对路径**，它自己去读文件。所以把字节落盘成临时文件、把路径传下去，
    // 是唯一不需要改 Codex 协议的做法。文件落在 $HOME/.codex-web/uploads/，
    // 24 小时后由清扫任务删掉（上传时就顺手清扫一遍，不需要额外定时器）。
    if (method === "POST" && path === "/api/upload") {
      let body;
      try {
        body = await readBody(req, 24 * 1024 * 1024);
      } catch (error) {
        json(res, 413, { error: describe(error) });
        return;
      }
      const dataUrl = typeof body.data === "string" ? body.data : "";
      const m = /^data:image\/(png|jpeg|jpg|gif|webp|bmp);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
      if (!m) { json(res, 400, { error: "只接受 data:image/...;base64 的图片" }); return; }
      const ext = m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
      const bytes = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
      if (bytes.length > 20 * 1024 * 1024) { json(res, 413, { error: "图片超过 20MB" }); return; }
      const dir = join(WORKDIR_REAL, ".codex-web", "uploads");
      try {
        await mkdir(dir, { recursive: true });
        const name = `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}.${ext}`;
        const file = join(dir, name);
        await writeFile(file, bytes);
        // 顺手清扫：同一目录下超过 24 小时的文件直接删（失败不影响这次上传）。
        try {
          const cutoff = Date.now() - 24 * 3600 * 1000;
          for (const entry of await readdir(dir)) {
            const full = join(dir, entry);
            try {
              const st = await stat(full);
              if (st.isFile() && st.mtimeMs < cutoff) await unlink(full);
            } catch { /* 单个文件失败不影响别的 */ }
          }
        } catch { /* 清扫失败无所谓 */ }
        json(res, 200, { path: file, size: bytes.length, name });
      } catch (error) {
        json(res, 500, { error: `写不了上传目录：${describe(error)}` });
      }
      return;
    }

    if (method === "POST" && path === "/api/thread/history") {
      const payload = await readBody(req);
      const threadId = typeof payload.threadId === "string" ? payload.threadId : "";
      if (!threadId) {
        json(res, 400, { error: "threadId 必填" });
        return;
      }
      // 生成中也照样返回已落盘的历史，**不再 409**。
      //
      // 以前这里用 isBusy 直接挡掉，于是"会话正在跑 → 想翻历史 → 被拒绝"，
      // 而用户恰恰是在等结果的时候最想翻历史。现在照常回历史，另加
      // `isGenerating` 标记和直播进度 `liveSeq`；前端先渲染历史，再把正在
      // 生成的流接上去，UI 全程不阻塞。
      const isGenerating = codex.isBusy(threadId);
      const liveSession = sessions.get(threadId);
      try {
        const turns = await codex.listTurns({ threadId });
        const known = rememberThread(threadId, {});
        json(res, 200, {
          threadId,
          messages: turnsToMessages(turns),
          turns: turns.length,
          title: known.title || "",
          cwd: known.cwd,
          mode: known.mode,
          model: known.model || null,
          effort: known.effort || null,
          approval: known.approval || DEFAULT_APPROVAL,
          tokens: known.tokens || 0,
          isGenerating,
          liveSeq: isGenerating && liveSession ? liveSession.seq : 0,
        });
      } catch (error) {
        json(res, 502, { error: describe(error) });
      }
      return;
    }

    if (method === "POST" && path === "/api/thread") {
      await handleThread(req, res);
      return;
    }

    if (method === "POST" && path === "/api/chat") {
      await handleChat(req, res);
      return;
    }

    if (method === "GET" && path === "/api/attach") {
      await handleAttach(req, res, url);
      return;
    }

    if (method === "POST" && path === "/api/interrupt") {
      await handleInterrupt(req, res);
      return;
    }

    // 追加到当前轮次（steer）：{ threadId, message }
    if (method === "POST" && path === "/api/steer") {
      const body = await readBody(req);
      const threadId = typeof body.threadId === "string" ? body.threadId : "";
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!threadId || !message) { json(res, 400, { error: "threadId 与 message 必填" }); return; }
      try {
        await codex.steer({ threadId, prompt: message });
        json(res, 200, { ok: true, threadId });
      } catch (error) {
        json(res, 409, { error: describe(error) });
      }
      return;
    }

    // 审批卡片的回话：{ id, choice: "approve" | "session" | "deny" | "abort" }
    if (method === "POST" && path === "/api/approval") {
      const body = await readBody(req);
      const id = Number(body.id);
      const choice = String(body.choice || "deny");
      if (!Number.isFinite(id)) { json(res, 400, { error: "id 必填" }); return; }
      if (!["approve", "session", "deny", "abort"].includes(choice)) {
        json(res, 400, { error: "choice 只能是 approve / session / deny / abort" });
        return;
      }
      const ok = codex.resolveApproval(id, choice);
      json(res, ok ? 200 : 404, { ok, id, choice });
      return;
    }

    // 会话改名 / 删除：侧栏行 hover 出来的那两个动作。
    if (method === "POST" && path === "/api/thread/rename") {
      const body = await readBody(req);
      const threadId = typeof body.threadId === "string" ? body.threadId : "";
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
      if (!threadId) { json(res, 400, { error: "threadId 必填" }); return; }
      try {
        await codex.renameThread(threadId, name);
        rememberThread(threadId, { title: name });
        threadsCache.at = 0;
        json(res, 200, { ok: true, threadId, name });
      } catch (error) {
        json(res, 502, { error: describe(error) });
      }
      return;
    }

    if (method === "POST" && path === "/api/thread/delete") {
      const body = await readBody(req);
      const threadId = typeof body.threadId === "string" ? body.threadId : "";
      if (!threadId) { json(res, 400, { error: "threadId 必填" }); return; }
      if (codex.isBusy(threadId)) { json(res, 409, { error: "这个会话还在生成，先停止再删" }); return; }
      try {
        await codex.deleteThread(threadId);
        threads.delete(threadId);
        sessions.delete(threadId);
        threadsCache.at = 0;
        json(res, 200, { ok: true, threadId });
      } catch (error) {
        json(res, 502, { error: describe(error) });
      }
      return;
    }

    json(res, 404, { error: `没有这个路由：${method} ${path}` });
  } catch (error) {
    if (!res.headersSent) json(res, 500, { error: describe(error) });
    else try { res.end(); } catch { /* 已经断了 */ }
  }
});

// SSE 是长连接，别让默认超时把响应掐了。
server.requestTimeout = 0;
server.headersTimeout = 60000;
server.keepAliveTimeout = 120000;

server.listen(PORT, HOST, () => {
  // token 落一份到 .token，供 start.sh 在终端打印完整可点链接。
  //
  // start.sh 是后台启动 + 日志重定向，stdout 会进 server.log；而 token 是长期
  // 凭证（默认复用 ~/.codex-web-token），所以这里只把它写进 0600 的 .token 给
  // 脚本读，日志里不打。
  try {
    writeFileSync(join(HERE, ".token"), NO_AUTH ? "" : AUTH_TOKEN, { mode: 0o600 });
  } catch { /* 写不进去也不该影响服务本身 */ }

  if (NO_AUTH) console.log(`codex-web 已启动（无认证）：http://${HOST}:${PORT}/`);
  else console.log(`codex-web 已启动：http://${HOST}:${PORT}/（带 token 的完整地址由 start.sh 打印，token 见 ${join(HERE, ".token")}）`);
  console.log(`工作目录：${WORKDIR}`);
  if (!NO_AUTH) console.log(`令牌：${TOKEN_SOURCE}（${TOKEN_FILE}）`);
  console.log(`空闲回收：${IDLE_MINUTES} 分钟 · 单轮超时：${TURN_TIMEOUT_MINUTES} 分钟`);

  // 版本门：异步探一次 codex --version，低于下限就在日志点名。
  // 不 await，不阻塞预热；结果进 /healthz.codex，403 排查先看这一眼。
  probeCodexVersion();

  // 启动就预热 codex app-server：冷启动要 10–30 秒（spawn proot + 握手 + 建会话），
  // 以前全砸在用户的第一条消息上。这里提前拉起，首轮就只剩模型本身的时间。
  // 失败不致命（比如 key 没配好），照旧留给第一轮去报，所以只记日志。
  if (PREWARM) {
    const t0 = Date.now();
    codex.ensure()
      .then(() => console.log(`预热完成：codex app-server 就绪（${((Date.now() - t0) / 1000).toFixed(1)}s）`))
      .catch((error) => console.log(`预热失败（不影响使用，首轮会重试）：${describe(error)}`));
  }
});
