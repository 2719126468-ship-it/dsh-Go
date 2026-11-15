# dsh-codex-delegate

> **在 dsh-Go 单仓库里**：源码位于 `packages/dsh-codex-delegate/`，属于 [Codex 套件](../../docs/codex-suite.md)。
> 安装时 `plugin_manager { action: "install_bundle", target: "<repo>/packages/dsh-codex-delegate" }`；
> 它是 `link:` 包，路径移动后需要重新安装。

Adds the DSH tool **`codex_delegate`**, which runs one task on the locally
installed Codex CLI and returns the assembled reply.

## How it runs

One resident `codex app-server` child is spawned on first use and reused by
every later call, driven over **JSON-RPC 2.0 on stdio** (newline-delimited
JSON — one message per line, no `Content-Length` framing):

| step | request | result |
| --- | --- | --- |
| handshake | `initialize` `{clientInfo}` | `{userAgent, codexHome, …}` |
| new session | `thread/start` `{cwd, sandbox, approvalPolicy}` | `{thread:{id}}` |
| submit input | `turn/start` `{threadId, input:[{type:"text",text}]}` | `{turn:{id}}` |

Streaming arrives as notifications; `item/agentMessage/delta`
(`{delta,itemId,threadId,turnId}`) is accumulated per thread until
`turn/completed` (`{threadId,turn:{status,error}}`) lands. `TurnStatus` is
`completed | interrupted | failed | inProgress`.

Each call gets a **fresh thread** (no history leaks between calls) but shares
the process. Events are routed by `threadId`, so overlapping calls each get
their own thread. After `idleTimeoutMs` with no calls the child is closed; the
next call respawns it. Unloading the plugin tears down the child's whole
process group (SIGTERM → SIGKILL).

If the app-server cannot spawn or handshake, the plugin falls back to a single
cold `codex exec` for that call and says so in the output, so the tool keeps
working even if the protocol changes under it.

## Install

```bash
# from a DSH session, with danger-full-access:
#   plugin_manager { action: "install_bundle", target: "<this directory>" }
```

The bundle is installed as a `link:` package, so it must stay at this path.

## Enable / disable

Rows are addressed by their full Loader entry id, not the patch id:

```
plugin_manager { action: "set_plugin", target: "include:codex-delegate", enabled: true }
```

**After editing `index.js` you must restart DSH.** The loader caches module
generations and Node caches ESM by URL, so a row toggle, a bundle re-install, or
even renaming the entry file will NOT re-import the edited code — the old
generation keeps running. Only a fresh DSH process picks it up. (A toggle is
enough only when the previous import *failed*, because a failed evaluation is
not cached.)

## Call

```
codex_delegate(prompt: "…", cwd: "/optional/working/directory")
```

`prompt` is required and must be self-contained — Codex cannot ask follow-up
questions. `cwd` defaults to the DSH host process working directory.

## Tunables

Read from this bundle's `cordis.patch.yml` row `config:`; defaults live in
`DEFAULTS` in `index.js`. See the comment block in the patch file.

| key | default | meaning |
| --- | --- | --- |
| `timeoutMs` | `300000` | per-call budget for the turn itself (thread setup has its own budget) |
| `idleTimeoutMs` | `1800000` | close the resident app-server after this idle |
| `handshakeTimeoutMs` | `30000` | spawn + `initialize` budget |
| `codexPath` | `~/.local/bin/codex` | the proot/DNS wrapper — **not** `$PREFIX/bin/codex` |
| `sandboxMode` | `danger-full-access` | any other value re-enables a sandbox that cannot work on Android |
| `approvalPolicy` | `on-request` | mapped to `thread/start`; approval prompts are declined because this tool has no interactive approval UI |
| `defaultCwd` | `""` | used only when the caller omits `cwd` |
| `maxOutputChars` | `100000` | truncation cap |
| `killGraceMs` | `2000` | SIGTERM→SIGKILL grace for the process group |
| `stderrTailChars` | `4000` | child stderr kept for diagnostics |
| `subagentEnabled` | `true` | also register the `codex` SubagentProvider |
| `residentProcess` | `true` | `false` stops the child when the last run disposes (slower, strictly matches the out-of-process teardown contract) |

## Security boundary

The Android host cannot enforce bubblewrap/Landlock, so the delegate currently uses `danger-full-access`. Its default `on-request` policy does **not** auto-approve: any approval request is declined because the DSH tool surface cannot show an interactive approval card. Tasks that need an approval-gated command will fail rather than silently proceed. Use only in a trusted working directory. Setting `approvalPolicy: never` is an explicit opt-in to unattended execution.

## Notes

* **Upstream errors arrive as `error` notifications, not `turn/completed`.**
  A dead upstream (e.g. HTTP 403 `codex_access_restricted` from a relay with a
  version gate) makes the app-server emit `{method:"error", willRetry:false}`
  and then fall silent — a client without an `error` branch waits for a
  completion that never comes. Verified against a scripted mock: before the
  fix a terminal error surfaced only as a 6 s `timeout` with an empty reason;
  after it the call fails in ~1 s with `status:"failed"` and the real message
  (`HTTP 403 codex_access_restricted`). `willRetry:true` is deliberately NOT a
  failure — the app-server is retrying upstream itself, so the turn keeps
  waiting (same semantics as codex-web's transient "retry" event).
* **Client-version awareness lives on the codex-web side, not here.** Relays
  like `sharedchat` 403 older Codex CLIs, so `services/codex-web/server.js` probes
  `codex --version` at startup (`CODEX_MIN_FLOOR = [0, 162]`) and surfaces the
  verdict in its startup log and `/healthz.codex`. This plugin intentionally
  ships no probe of its own: it stays lean, and with the `error` branch above
  a version-gated relay now reports `codex_access_restricted` verbatim in the
  tool result, which is enough for the caller to consult that README.
* **`--full-auto` does not exist** in Codex 0.159.x. It was replaced by
  `--sandbox <mode>` (one-shot path) / `sandbox` (`thread/start`), and only
  `danger-full-access` works on Android — bubblewrap and Landlock both fail.
* The child gets `SHAREDCHAT_API_KEY` from the DSH process environment when
  present, otherwise from `$DSH_HOME/.credentials.yaml` (`CODEX_API_API_KEY`),
  and failing that from the `export SHAREDCHAT_API_KEY=…` line in `~/.bashrc` /
  `~/.profile` / `~/.bash_profile` (a non-interactive shell never sourced them).
  `~/.codex/*` stays untouched — that is Codex's own state.
* Model calls are slow here: a one-word reply measured **~85 s** wall clock, so
  raise `timeoutMs` for real work.
* `~/.codex/*` is never read or written by this plugin.
* `index.oneshot.js.bak` is the previous per-call implementation, kept for
  reference; it is not loaded.

## Subagent provider (`codex`)

The plugin also registers a `SubagentProvider` named `codex` on
`ctx.subagents`, so DSH's own delegation machinery can hand work to Codex. It
is bound to a model-facing tool by a second `@deepseek-ai/dsh-tool-subagent` row
(`toolName: codex_subagent`, `provider: codex`); the backend is fixed per row,
never chosen by the model at call time.

It shares the same resident app-server as `codex_delegate`.

### Capabilities: the minimum set, on purpose

```js
{ agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false }
inheritsParentContext: false
```

Every capability left false is one DSH would have to enforce *inside* Codex,
which it cannot: Codex owns the child's model, its own tool registry, and any
sub-delegation of its own. `inheritsParentContext: false` is accurate (a fresh
Codex thread sees none of the parent conversation) and only changes wording.

`prepareContinuable` is deliberately NOT implemented. Continuable children are
DSH-local Agents — the service calls `activations.materialize(...)` and then
reads `activation.handle.agent.session.header`, so it needs a Session we would
not own. Declaring the method would claim a capability we cannot honor.

### Result mapping

| Codex outcome | `stopReason` | notes |
| --- | --- | --- |
| turn completed | `completed` | text in `output` |
| exceeded `timeoutMs` | `error` | diagnostic names the budget |
| upstream/protocol failure | `error` | upstream message lands in `diagnostic` |
| parent `signal` aborted, or `dispose()` | `aborted` | settles within the 3s cap |

Non-text prompt blocks (`image`, `file`) cannot be carried, so each is recorded
as `[unsupported: <type>]` in `diagnostic` rather than silently dropped.

### dispose() semantics — and the one documented deviation

`dispose()` is idempotent, drops the parent abort listener, and settles local
cancellation without assuming Codex cooperates. The server's own abort path
issues the `turn/interrupt`, so this layer does not duplicate it.

DSH documents the out-of-process contract as "awaits the backend's teardown **to
actual exit**". With `residentProcess: true` (the default) the shared process
deliberately survives, bounded instead by `idleTimeoutMs` and by plugin unload.
That is a deviation, taken knowingly: a per-run cold start costs 60–222s here,
and nothing in DSH asserts the child is gone afterwards (`settleRun` only awaits
`dispose`; the `subagent/end` consumers either skip `!info.local` runs or degrade
to `undefined`). Set `residentProcess: false` for strict conformance.

### Cancellation

One-shot remote runs are cancelled through the `AbortSignal` on the start
request — **not** through `ctx.subagents.interrupt()`, which targets durable
continuable child sessions and has no meaning for an external process.

## 写 provider 插件时必须知道的内核行为

这一节记的是**真踩过的坑**，不是推测。下次改这个插件、或照它写别的 provider
插件之前先读一遍。

### 1. `ctx.get("xxx")` 在 apply() 那一瞬间可能是 `undefined`

**不是**因为服务没被组合，而是因为它**还没被 provide 出来** —— 插件常常比自己
依赖的服务先加载。

这个插件的第一版就是：

```js
const subagents = ctx.get("subagents");          // ← 此刻是 undefined
if (typeof subagents?.registerProvider === "function") { /* 注册 */ }
else { ctx.logger?.info?.("no subagents service"); }   // ← 静默走了这里
```

后果是**永不注册**。而 `tool-subagent-codex` 那一行在等
`subagent/provider-added` 事件，事件永远不会来 —— 于是 `codex_subagent`
工具根本不出现，日志里也没有任何东西能说明为什么。排查时先排除了"行没挂上"
（`Config.listConfigs` 显示该行 status `schema`）和"能力校验失败"
（`registerProvider` 只查重名，不校验 capabilities），最后才定位到这一行。

**正解**：用 `ctx.inject(deps, cb)` 让 DSH 为这个依赖开一条 fiber，等它就绪
（服务被替换时会重跑），而不是在加载瞬间猜一次：

```js
ctx.inject(["subagents"], (scoped) => {
  scoped.effect(() => scoped.subagents.registerProvider(provider), "label");
});
```

同一条经验在 `dsh-our-free-model` 的 README 里也有记载（它们踩的是
`webServer`）。

### 2. 回调里的错误不能静默吞

一个 `try { ... } catch { logger.info(...) }` 会把"注册失败"变成"工具不出现，
无人知道为什么"。inject 回调里至少 `logger.error` 一次。

### 3. `link:` bundle 无法 import `@deepseek-ai/*`

bundle 以 `link:` 安装时，Node 从工作区真实路径解析 import，那里没有
`node_modules`，任何 `@deepseek-ai/*` import 都会 `ERR_MODULE_NOT_FOUND`，
插件完全不激活。所以 `src/provider.js` 自己实现了同形状的 run handle，而不是
import `subprocessRunHandle`。

### 4. 改完代码必须重启 DSH，toggle 不够

loader 只重读 **patch**，不会重新 import **模块**。实测：改了 `index.js`、
做 bundle toggle（该动作确实重读 patch），线上跑的还是旧模块代。只有新的 DSH
进程才会加载新模块。

## 已知限制

### `residentProcess: false` 的引用计数路径未在线上验证

`false` 模式依赖 `CodexAppServer` 里的引用计数（`activeTurns` + `maybeKill` +
`drainPendingKill`）：当工具与 provider 共享同一进程、而 provider 先结束并触发
关闭时，请求会被挂起，等工具那个 turn 也排空后才真正关进程——否则工具的 turn 会被
从底下抽掉进程。

这条路径**只由 mock 测试精确验证过**（构造 provider 跑 800ms、工具跑 4000ms，
确认进程未被早杀、工具正常拿到结果、随后挂起的关闭立即排空）。**它从未在真实
DSH 上被触发过。**

**日常使用推荐 `residentProcess: true`**（默认）：该模式下根本不存在"共享实例 +
独占销毁"的场景，引用计数不会被触发，进程由 `idleTimeoutMs` 与插件卸载回收。

若要改用 `false`，请把上面那条并发场景在真实环境跑一遍再依赖它。

### 其余

- **`max-tokens` 无法表达**：Codex 协议里 `TurnStatus` 只有
  `completed | interrupted | failed | inProgress`，`CodexErrorInfo` 也没有输出截断
  这一档。撞到输出上限时 Codex 表现为一次正常的 `completed`，只是文本短。所以
  provider 无法给出 DSH 的 `max-tokens` 停止原因——父级分不清"说完了"和"被截断"。
- **空输出**：turn 正常完成但没有文本时，provider 会补一条
  `diagnostic: "turn completed with no text output"`，`stopReason` 仍为
  `completed`（它确实完成了）。
- **Codex 内部的子委派不受 DSH 深度上限约束**：`depthLimit: false` 的诚实体现，
  见上文 capabilities 一节。
