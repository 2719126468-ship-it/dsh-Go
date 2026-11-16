# codex-web

> **在 dsh-Go 单仓库里**：源码位于 `services/codex-web/`，与 `services/sharedchat-bridge`、`packages/dsh-codex-delegate`、`tooling/codex-capture` 同属 [Codex 套件](../../docs/codex-suite.md)。
>
> - 直接跑：`node services/codex-web/server.js`（默认 `127.0.0.1:3081`）
> - 单测：`cd services/codex-web && npm test`（零依赖，Node ≥ 20）
> - CI：`.github/workflows/ci.yml` 的 `Codex suite` job
> - 下文出现的 `services/codex-web/...` 都相对仓库根

Termux 里跑的本地 Web 版 Codex 聊天界面。手机上用浏览器打开 `http://127.0.0.1:3081`，
就能跟 Codex 流式对话。

界面按 **ChatGPT / Codex Web（chatgpt.com/codex）** 的样子重做过：52px 图标 rail + 260px 会话
panel + 768px 内容列的三栏骨架、light/dark 双主题（token 取值来自线上 CSS 实测）、
composer 里的模型选择器（数据源是 app-server 的 `model/list`）、推理摘要 "Thinking" 块、
工具卡/计划卡/diff 卡、流式光标与发送↔停止 morph。设计规范见 [design-spec.md](design-spec.md)，
DOM/class 命名契约见 [CONTRACT.md](CONTRACT.md)。

跟 DSH 完全无关，不 import 任何 DSH 路径，也不碰 `~/.dsh/`。

## 用了什么

- **后端**：Node 内置 `http`，零依赖。进程里常驻一个 `codex app-server` 子进程，
  通过 JSON-RPC 2.0 over stdio 跟它对话（`src/appserver.js`，从
  `packages/dsh-codex-delegate/src/appserver.js` 复制后独立演进）。
- **Codex**：`~/.local/bin/codex`（proot wrapper），配置读 `~/.codex/config.toml`
  （provider=sharedchat）。默认模型由前端选择器决定，初值取 `model/list` 里的 `isDefault`。
  本服务**不改**这两个文件。
- **前端**：`public/index.html`（骨架 + 固定 id）、`public/app.css`（全部样式）、
  `public/app.js`（SSE / 状态机 / DOM 装配）、`public/markdown.js`（markdown 渲染器，
  零依赖、纯浏览器脚本）。无构建步骤、无 npm 依赖。

## 起停

```bash
services/codex-web/start.sh     # 后台起服务，打印访问地址（重复执行是安全的）
services/codex-web/stop.sh      # 停服务，连带它拉起的 codex / proot 子进程树
```

`start.sh` 会打印带令牌的完整链接（`http://127.0.0.1:3081/?token=…`）。**第一次用这条链接打开**，
令牌会存进浏览器的 localStorage；之后直接打开 <http://127.0.0.1:3081>，或从主屏幕启动 PWA 就行
（详见下面「认证」）。

`CODEX_WEB_NO_AUTH=1` / `--no-auth` 仅允许 `127.0.0.1`、`::1` 或 `localhost` 绑定；尝试绑定 `0.0.0.0` 或局域网地址会直接拒绝启动。需要跨设备访问时请保留令牌认证。

日志在 `services/codex-web/server.log`。超过 5MB 自动轮转：尾部 2MB 快照进 `server.log.1`，
主文件清空重记（copy+truncate，不换 inode——nohup 的 stdout 和拦截日志的 appendFile
写的是同一个文件，rename 会让两条流分叉）。

## 目录

```
server.js              HTTP 服务：路由 + SSE + 静态资源白名单
src/appserver.js       codex app-server 客户端（协议、事件翻译、会话列表、历史、空闲回收）
src/history.js         历史轮次 → 前端消息序列（复用同一套工具卡片映射）
public/index.html      前端骨架：三栏布局 + 固定 id（不许改 id，见 CONTRACT.md）
public/app.css         全部样式：双主题 token / 布局 / 组件 / 动效（无外部字体图标）
public/app.js          前端主逻辑：SSE、回合状态机、工具卡、菜单、主题
public/markdown.js     markdown 渲染器（window.CodexMarkdown.render）
public/manifest.webmanifest / public/sw.js / public/icons/   PWA
CONTRACT.md            DOM / class / id 命名契约（CSS 与 JS 共用的唯一真相）
design-spec.md         ChatGPT / Codex Web 视觉规范（token 真值、组件规格、动效表）
start.sh / stop.sh     起停
tools/make-icons.js    生成 PWA 图标（手写 PNG 编码，零依赖）
tools/stream-sim.js    开发用：把 public/app.js 与 markdown.js 塞进最小 DOM 跑，135 条断言
                       （流式、推理、工具卡、分组、计划、diff、代码块、中断、重连、菜单、
                        会话列表、steer 的 UI 路径、右侧页签空白回归）
tools/protocol-unit.js 开发用：协议翻译层单测（error/tool 事件的字段形状），46 条断言
tools/approval-unit.mjs  开发用：审批反向请求单测（响应字面形状 + 超时兜底），14 条断言
tools/e2e-steer.cjs        开发用：真浏览器（CDP）跑 steer 的 UI 路径，24 项，打真上游
tools/e2e-tabs.cjs         开发用：真浏览器跑顶部 tab 两态 + demo 各页签，15 项
tools/e2e-token-sanitize.cjs  开发用：真浏览器验证「令牌脏值不再打死界面」，18 项
tools/e2e-mobile.cjs       开发用：真浏览器跑手机端 8 组验收（390/360/320 三种尺寸），51 项
tools/e2e-demo-determinism.cjs
                           开发用：demo=1 在 2.5s/4s/6s 三个等待时长下 13 个字段必须逐项一致
tools/page-hitarea.src.js  页内探针：触摸热区外扩的 A/B 对照（被 e2e-mobile 读入）
tools/page-settings-reach.src.js
                           页内探针：窄屏设置/主题入口可达性（被 e2e-mobile 读入）
tools/probe.js         开发用：直连 app-server 打印原始协议帧
tools/probe-resume.js  开发用：验证 app-server 重启后 thread/resume 能不能接回旧会话
tools/portcheck.js     端口占用探测（这台机器上 ss 不可用，见下）
```

**跑测试**

```bash
npm test          # 195 条断言 = approval 14 + protocol 46 + stream-sim 135（纯逻辑，不碰浏览器）
npm run test:e2e  # 108 项浏览器级 = token 18 + steer 24 + tab 两态 15 + 手机端 51，
                  # 另附 demo 可重现性比对（13 字段 × 3 个等待时长）
npm run test:all  # 上面两条一起跑
# e2e 前置：server.js 在 3081 且 chromium --headless=new --remote-debugging-port=9222
```

## 跟 Codex 的约定（实测 codex-cli 0.162.1，协议自 0.159.2 起未变）

- `initialize` 握手很快（<1 秒）；`thread/start` 约 3 秒。
- **`turn/start` 是非阻塞的**：立刻返回 `{turn:{id,status:"inProgress"}}`，
  真正的产出全走通知（`item/agentMessage/delta`、`item/completed`、
  `turn/completed`）。所以这一轮必须在发请求**之前**就登记好，否则漏通知。
- 一个 thread 同时只跑一轮；并发 `turn/start` 会挤在同一轮上。
- 空闲回收后重启 app-server，旧 threadId 会失效（`thread not found`）。
  这时先 `thread/resume` 把磁盘上的会话接回来（上下文能保住）；
  接不回来才另起新会话，并通过 `thread {reset:true}` 告诉前端。

## 上游站点对 Codex 客户端有版本要求（踩过的坑）

`sharedchat` 这类中转站会校验调用方是不是**最新版** Codex 客户端。版本旧了，
**任何**请求都被挡在门外：

```
HTTP 403  {"error":{"message":"请使用最新版的codex客户端或codex cli调用",
                    "code":"codex_access_restricted"}}
```

它的迷惑之处在于**同一个 key、同一个接口，返回会飘**：时而 200、时而 402
「余额不足」、时而 403 `codex_access_restricted`、时而又是一个**空体 403**。
所以排查时不要用单次响应下结论——**先固定变量**：拿一个明显无效的 key 打同一
接口，如果稳定拿到应用层的 `401 Invalid API key`，说明 IP 没被封、接口是通的，
那么飘忽的 403 就是客户端校验门，而不是余额或 WAF 问题。

判别顺序（本机实测有效）：

1. 先看服务自己报的版本：`curl -s http://127.0.0.1:3081/healthz` 里的 `codex`
   字段（`version` / `tooOld` / `error`）是启动时异步跑一次 `codex --version`
   探出来的（探的是 `resolveCodexPath()` 选中的那个可执行文件），下限是
   `server.js` 里的 `CODEX_MIN_FLOOR = [0, 162]`（本机实测能用的那一档）。
   太旧时启动日志还会有一行 `⚠ Codex 版本 … 低于本机验证过的下限 0.162`。
   `tooOld: true` ⇒ 直接坐实版本门，跳过下面两步；`version: null` 而 `error` 非空
   ⇒ 探测本身没成功（`codex` 不可执行、超时等），先修这个再回来判。
2. 无效 key → `401 Invalid API key` ⇒ 网络与接口正常，排除封禁/余额。
3. 有效 key 的 403 报文里出现 `codex_access_restricted` ⇒ 版本门。
4. 升级 Codex 到最新版即解。

**2026-11 实测补充**：升级到 0.167.0 后 `codex_access_restricted` 消失，但上游开始
稳定回另一句：

```
unexpected status 403 Forbidden: 您当前没有可用的 Codex 订阅额度或余额。
```

这句在 Codex 的 TurnError 里是 `additionalDetails`，而 `message` 只有
`Reconnecting... 1/5`。本项目现在把两者拼起来一起显示（`appserver.js` 的 `error`
分支），所以界面上能直接看到上游原文，不用再去翻 `server.log`。这句是**账号侧**
的问题：换 key、充值或换 provider 才能解，跟客户端版本无关。

### 在 Termux / Android 上升级 Codex

> **本项目现在的做法（推荐）：并列安装，不动系统那份。**
> 把 `@openai/codex@<VER>-linux-arm64` 的 tarball 解到
> `~/.local/codex-<VER>/`，再放一个 `bin/codex` 的 proot wrapper 进去。
> `src/appserver.js` 的 `resolveCodexPath()` 启动时会扫 `~/.local/codex-*`，
> **自动挑版本号最高的那个**（可用 `CODEX_BIN` 覆盖）。所以升级 = 解一个新目录，
> 想回滚就把目录删掉，旧版一直还在。
>
> ```bash
> mkdir -p ~/.run/codexnew && cd ~/.run/codexnew
> npm pack "@openai/codex@0.167.0-linux-arm64"      # 会下 ~160MB，慢
> tar xzf openai-codex-0.167.0-linux-arm64.tgz
> DEST="$HOME/.local/codex-0.167"; rm -rf "$DEST"; mkdir -p "$DEST"
> cp -a package/. "$DEST"/
> mkdir -p "$DEST/bin"
> cat > "$DEST/bin/codex" <<'WRAP'
> #!/data/data/com.termux/files/usr/bin/bash
> set -euo pipefail
> PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
> SELF_DIR="$(cd "$(dirname "$0")/.." && pwd)"
> exec proot -b "$PREFIX/etc/resolv.conf:/etc/resolv.conf" \
>   "$SELF_DIR/vendor/aarch64-unknown-linux-musl/bin/codex" "$@"
> WRAP
> chmod +x "$DEST/bin/codex"
> "$DEST/bin/codex" --version     # 期望 codex-cli <VER>
> ```
> 之后重启服务，`/healthz` 的 `codex.version` 就会变成新版。

`npm i -g @openai/codex@latest` 装不完整 —— 平台二进制的 optional 依赖要求
`os: linux`，而 Termux 上报的是 `os: android`，npm 会直接跳过它，结果只剩一个
`bin/codex.js` 启动器，一跑就报 `Missing optional dependency @openai/codex-linux-arm64`。
`--force` 可绕过平台检查，但 250MB 的包用 npm 下常撞 `EIDLETIMEOUT`。

可靠做法是直接取 tarball 手工就位（`<VER>` 换成目标版本）：

```bash
VER=0.162.1
TB="https://registry.npmjs.org/@openai/codex/-/codex-${VER}-linux-arm64.tgz"
DEST="$PREFIX/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-arm64"

# 先问 registry 这个包该当的 sha512（dist.integrity），别下完再找
EXPECT=$(curl -s "https://registry.npmjs.org/@openai/codex/${VER}-linux-arm64" \
  | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).dist.integrity)")

mkdir -p "$PREFIX/lib/node_modules/@openai/codex/node_modules"
curl -L --retry 5 -C - -o /tmp/codex.tgz "$TB"   # 会断，重跑同一条命令即续传
gzip -t /tmp/codex.tgz                            # 必须先校验完整再解包

# 比对完整性：这条配方在本机对 0.162.1 主包与 linux-arm64 包（约 50MB）都实测 MATCH
ACTUAL="sha512-$(openssl dgst -sha512 -binary /tmp/codex.tgz | openssl base64 -A)"
[ "$EXPECT" = "$ACTUAL" ] && echo "INTEGRITY MATCH: PASS" || { echo "FAIL: expect=$EXPECT actual=$ACTUAL"; exit 1; }

rm -rf "$DEST" && mkdir -p "$DEST"
tar -xzf /tmp/codex.tgz -C "$DEST" --strip-components=1
"$HOME/.local/bin/codex" --version                # 期望 codex-cli $VER
```

要点：

- **`dist.integrity` 是 `sha512-<base64>`，不是十六进制**，所以算完必须再过一道
  `openssl base64 -A`（`-A` 是单行无换行）。`sha256sum` 那类十六进制输出跟它比
  永远不相等，别拿错基准。本机 OpenSSL 3.6.5 自带 `dgst -sha512`。
- **两道校验各管各的**：本机实测把 tarball 尾部砍掉 500 字节，`gzip -t` 回
  `exit=1 / unexpected end of file`，所以**截断**它挡得住；但它只证明"这份 .gz 自洽"
  （自己的 CRC 与长度对得上），**不证明这就是 registry 上那份字节**——镜像/中间人换了
  包它照样过。`dist.integrity` 比对补的就是这一层，谁也别替谁。

- **解包目标必须是 `@openai/codex/node_modules/@openai/codex-linux-arm64/`**。
  `bin/codex.js` 用 `require.resolve("@openai/codex-linux-arm64/package.json")`
  解析，靠的是**目录名**——包内 `package.json` 的 `name` 其实写的是
  `@openai/codex`，这不影响解析，但别按 name 字段判断装没装对。
- 别把 `--strip-components=1` 的结果解到 `node_modules/` 这一级，否则
  `vendor/` 会散落在 `node_modules/` 下，`require.resolve` 依然找不到。
- `~/.local/bin/codex` 这个 proot wrapper 硬编码了上面的嵌套路径，装对位置它
  就直接生效；装不上时它会退到 `$PREFIX/bin/codex`，也就是那个会报错的启动器。
- 升级会**删掉旧版二进制**（npm 先删后装），旧版不可回滚，只能按同样步骤重下。
  本机留了一份 `~/codex-upgrade-backup/dl/codex-arm64.tgz`（151MB）作底，磁盘紧张
  时可删。


## 后端 → 前端 的 SSE 契约

不是 OpenAI 协议，是本项目自己定的一套：

| event | data | 说明 |
|---|---|---|
| `status` | `{state:"starting"\|"ready"}` | 启动预热后一般不再出现 `starting`；仅当 app-server 被空闲回收、需重新冷启动时先发 `starting`（约 10–30 秒） |
| `thread` | `{threadId,model,effort}` / `{…,reset:true,reason}` | 新会话建立；`reset` 表示上一个会话接不回来了 |
| `delta` | `{text}` | 流式文本增量 |
| `reasoning` | `{id,text,kind:"summary"\|"raw"}` | 推理摘要增量（`summary` 是给人看的那段，`raw` 是原始思维链） |
| `reasoning_done` | `{id,summary}` | 推理结束（前端把 "Thinking…" 换成"已思考 N 秒"） |
| `plan` | `{items:[{step,status}],explanation}` | 计划全量（来自 `turn/plan/updated`） |
| `turn_diff` | `{diff}` | 本轮聚合 diff（来自 `turn/diff/updated`，只含 Codex 自己改的东西） |
| `tool` | `{id,name,input,label}` | 工具调用开始（`label` 是"正在跑：<命令>"这种现成文案） |
| `tool_result` | `{id,output,status,durationMs,exitCode}` | 工具调用结束 |
| `tool_delta` | `{id,text}` | 命令执行过程中的实时输出增量 |
| `usage` | `{used,window}` | 上下文窗口用量（来自 `thread/tokenUsage/updated`，两者都可能为 null） |
| `retry` | `{message,code}` | 上游出错但 app-server 会自己重试（不是失败，别弹红框）。**例外**：`code` 含 401/402/403（认证、余额、额度）时不重试——第一次就中断这一轮并改发 `error`，否则 Codex 会自己重试 5 次、实测白烧 173 秒 |
| `session` | `{cwd,mode,model,effort,modeLabel,modeDesc,tokens,sandboxEnforced}` | 本轮的工作目录 / 权限模式 / 模型与推理档 / 会话累计 tokens |
| `notice` | `{kind,message}` | 给用户的一句说明（例如沙箱在本机用不了） |
| `done` | `{reason,text}` | 这一轮结束；`text` 是权威全文，前端拿它校正一次 |
| `approval` | `{id,method,command,cwd,reason,changes,permissions}` | 等待用户决定的审批（画成卡片） |
| `approval_resolved` | `{id,choice,timeout}` | 审批已解决（别处点了或超时） |
| `error` | `{message}` | 错误 |

## HTTP 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 前端页面 |
| GET | `/healthz` | 自检：app-server 是否在跑 / 是否 ready |
| GET | `/api/threads?limit=60` | 这台机器上落盘的 Codex 会话列表（命令行里开过的也算）。服务端缓存 10 秒，命中时响应里带 `cached:true`；新建会话会立即失效缓存 |
| POST | `/api/thread/history` | `{threadId}` → 该会话的历史消息（含工具卡片） |
| POST | `/api/thread` | 新建会话 → `{threadId}` |
| POST | `/api/chat` | `{threadId?, message, cwd?, mode?, model?, effort?}` → SSE 流（省略 threadId 会自动开会话） |
| GET | `/api/models` | 模型目录（app-server `model/list`）：id / displayName / description / 可用推理档 / 默认档。服务端缓存 60 秒 |
| GET | `/api/dirs?path=` | 列子目录（只列目录；路径必须在 `$HOME` 下） |
| GET | `/api/config` | 工作目录、权限预设、沙箱在本机能不能用 |
| GET | `/api/diff?threadId=xxx` | 本轮改动摘要 → `{isRepo,fileCount,insertions,deletions,stat,status}` |
| GET | `/api/diff/full?threadId=xxx` | 本轮完整 diff → `{isRepo,diff}` |
| GET | `/api/attach?threadId=&since=` | 断线重连：补发 seq 之后的事件，然后接着直播 |
| POST | `/api/interrupt` | `{threadId}` → 中断当前这一轮 |
| POST | `/api/approval` | `{id, choice:"approve"\|"session"\|"deny"\|"abort"}` → 回话给 app-server 的审批反向请求 |
| POST | `/api/upload` | `{data:"data:image/…;base64"}` → `{path,size,name}`。落盘到 `$HOME/.codex-web/uploads/`，24 小时后自动清扫 |
| POST | `/api/thread/rename` | `{threadId,name}` → `thread/name/set`，并同步内存里的标题 |
| POST | `/api/thread/delete` | `{threadId}` → `thread/delete`（落盘记录一起删；正在生成时 409） |
| GET | `/api/active` | 还有哪些轮次在后台跑；刷新页面后据此用 `/api/attach` 接回来 |
| GET | `/api/version` | 前端构建号（`index.html` + `app.css` + `app.js` + `markdown.js` 四份的联合内容哈希，只算其中一份的话改样式/逻辑不会触发"界面已更新"提示），页面据此判断自己是不是旧版 |
| GET | `/manifest.webmanifest` `/sw.js` `/icons/*` | PWA 静态素材 |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3081` | 监听端口（避开 DSH 的 3080） |
| `HOST` | `127.0.0.1` | 只监听本机 |
| `CODEX_WEB_CWD` | `$HOME` | Codex 干活的工作目录 |
| `CODEX_IDLE_MINUTES` | `30` | app-server 空闲多久回收（可给小数，测试用）。原为 5，手机上一次对话常隔着切后台，5 分钟就回收、下一条又撞冷启动 |
| `CODEX_TURN_TIMEOUT_MINUTES` | `30` | 单轮超时 |
| `CODEX_DETACH_GRACE_SECONDS` | `30` | 客户端断开后等多久重连，超时才中断这一轮 |
| `SHAREDCHAT_API_KEY` | 自动找 | 没设的话从 `~/.bashrc` 的 export 行读一次（只读） |
| `CODEX_WEB_NO_AUTH` | 空 | 设为 `1`（或启动参数 `--no-auth`）关闭认证，见「认证」 |
| `CODEX_WEB_NO_PREWARM` | 空 | 设为 `1` 关闭启动预热（默认启动即拉起 app-server，首轮不再等冷启动） |

## 认证

服务端有一个访问令牌：32 位十六进制，存在 `~/.codex-web-token`（权限 0600），
**重启后沿用同一个**，只有第一次启动（或手动轮换）才会生成新的。

- 请求要带 `?token=…` 或请求头 `X-Auth-Token`，否则 403。前端会从地址栏的 `?token=` 取出令牌
  存进 localStorage，之后给本站所有 fetch 自动加上请求头，所以从主屏幕打开 PWA 不用再带链接。
  取完之后地址栏里的 `?token=` 会被 `history.replaceState` 擦掉——token 不留地址栏、
  不留浏览历史、截图分享也不会泄露。
- 不需要令牌的（只限 GET）：`/`、`/index.html`、`/healthz`，以及 PWA 素材
  （`/manifest.webmanifest`、`/sw.js`、`/icons/*`）。这些是浏览器自己发起的请求，带不了令牌；
  里面没有机密，数据全在 `/api/*` 后面。
- Host 头必须是 `localhost` / `127.0.0.1` / `[::1]`，否则 403。
- `/api/*` 限速：每个 IP 每分钟 60 次，超了封 5 分钟（429）。
- 被拦的请求记在 `server.log`，形如 `⚠️ 拦截 [ip] [url] 原因: [Token错误]`。
- 启动时打印的完整链接（含令牌）也会进 `server.log`，别把日志原样发给别人。

**轮换令牌**：先 `services/codex-web/stop.sh`，再二选一：删掉 `~/.codex-web-token` 后正常 `start.sh`；
或者前台跑一次 `node services/codex-web/server.js --new-token`（强制重新生成并覆盖文件）。
换完用新链接打开一次，手机里存的旧令牌才会被刷新。

**关掉认证**：`--no-auth` 或环境变量 `CODEX_WEB_NO_AUTH=1`。此时令牌、Host 检查、限速全部不生效，
也不读写令牌文件。虽然只听 127.0.0.1，但同一台手机上的其他 App 也连得上，建议保持认证开启。

## 断线与重连

手机上报过 "network error"。查下来的结论和修法：

**线上实测**（curl 逐字节打时间戳）：`tick1..tick20` 每秒一条全部到达，
心跳准点发出，连接活了 42 秒以上 —— 服务端的 SSE 本身是健康的，
不是"空闲被掐"。真正的问题有两个：

1. **每个请求的前 15 秒线上一个字节都没有**。心跳要等 15 秒才第一次触发，
   而"模型在想"的那段静默正好落在这个窗口里。
   → 现在**建连立刻写一个注释行**，心跳缩到 **10 秒**，静默窗口上限 ≤10s。
2. **断了就丢**。以前客户端一断开就 `interrupt` 把这一轮掐死，
   用户看到的就是一个光秃秃的 network error。
   → 现在断了不立刻杀：`TurnSession` 把这一轮的事件按 seq 存着，
   **30 秒宽限期**内客户端可以 `GET /api/attach?threadId=X&since=N` 续接，
   服务端把漏掉的事件补发完再接着直播；宽限期过了才中断省 token。
   前端在 `send()` 里自动重连（4 次退避重试），用户只会看到
   "连接断了，正在重连（1/4）…"，不会再弹错误。

另外，**开发期间重启服务会硬断所有 SSE**。`stop.sh` 是 SIGTERM，
正在看的那条流会直接断 —— 现在有重连兜底，不再致命。

排查手机端问题时，`server.log` 是唯一能说明"另一端发生了什么"的证据：

```
[03:10:12] → POST /api/chat (SSE 开始)
[03:10:12] ▶ 开始 thread=01a0f570
[03:10:42]   ⚠ 客户端断开 thread=01a0f570 seq=15，30s 内重连可续，否则中断
[03:10:45] → GET /api/attach (SSE 开始)
[03:10:45] ⟳ 重连 thread=01a0f570 since=15 补发 3 条
[03:11:16] ■ 结束 thread=01a0f570 status=completed 事件数=29
```

"客户端断开"后面**没有** `→ GET /api/attach`，就是真断了没回来；
两条都有，说明是客户端自动重连、链路本身没问题。

相关开关：`CODEX_DETACH_GRACE_SECONDS`（默认 30）。

## 工作目录与权限模式

顶栏的 📁 按钮选工作目录，输入框左边的按钮切权限模式。

**工作目录**：面板里 [↑ 上级] + 「最近使用」+ 当前路径的子目录（只列目录），
底部 [选择当前目录]。最近使用存 localStorage（最多 5 条、去重、最新在前，
每条带 × 可删）；目录已经没了的会灰显并标注「目录已删除」，点不进去。

后端 `GET /api/dirs?path=` 列子目录，路径必须落在 `$HOME` 之下（判定规则见下面
「cwd 守卫」；`/etc`、`/`、`../../etc`、指向 `$HOME` 外的软链都会被 400 挡掉）。
真实指向 `$HOME` 外的软链目录仍会列出来，但标 `blocked`，前端灰显、点不进去。

**权限模式**：三档沙箱预设 + 一条**独立**的审批策略轴（第 8 轮拆开，见下面「沙箱 × 审批」）。
下拉菜单分两段，第一段是沙箱：

| 档位 | sandboxPolicy | 说明 |
|---|---|---|
| read-only | `{type:"readOnly"}` | 只读，不修改任何文件 |
| workspace-write | `{type:"workspaceWrite", writableRoots:[cwd]}` | 可改工作目录内文件，不联网 |
| danger-full-access | `{type:"dangerFullAccess"}` | 全权限 |

第二段是审批（`auto` / `on-request` / `untrusted` / `never`）：`auto` 跟随当前权限档的安全默认值；目前三档均默认 `on-request`，包括 Android 上必须使用的 `danger-full-access`。只有用户显式选择 `never` 才会关闭审批；显式选择 `on-request` 或 `untrusted` 则覆盖沙箱档默认值。

都是用 `turn/start` 的 `cwd` / `sandboxPolicy` / `approvalPolicy` 覆盖传的（协议原话：
"Override … for this turn and subsequent turns"），**换目录换权限都不用重开会话**。
注意 `turn/start` 收的是 `sandboxPolicy` **对象**，而 `thread/start` 收的是
`sandbox` **枚举字符串**，两套取值不一样。

每个 threadId 在内存里记着自己的 cwd / mode / approval / 累计 tokens；
新建会话重置为 `~` + 默认模式 + tokens 清零。

### cwd 守卫（`src/paths.js`）

所有工作目录都过 `createCwdGuard(root)`（`root` 默认 `$HOME`，即 `WORKDIR`），
`server.js` 里就是 `normalizeCwd`。它返回：

```js
{ ok: true,  path: "<真实路径>", exists: true|false }   // 通过
{ ok: false, error: "<原因>" }                          // 拒绝
```

**契约（调用方必须知道的两点）**：

1. **不存在的路径不算错**。`normalizeCwd("$HOME/还没建的目录")` 会返回
   `{ ok:true, exists:false, path:"<真实路径>" }` —— 路径已经被钉在根内，只是还不存在。
   调用方必须自己判 `exists`（`server.js` 里统一走 `cwdFailure()`），
   否则会把不存在的 cwd 递给 codex。
2. **返回的 `path` 是 realpath**，不是入参的原样回显。拿它做字符串比较时要和
   真实根 `WORKDIR_REAL` 比（服务端回给前端的 `home` / `parent` 也都是真实路径）。

**拒绝规则**（任一命中即 400）：

| 输入 | 结果 |
|---|---|
| `$HOME` 之外（`/etc`、`/`、同名前缀的兄弟目录如 `$HOME2`） | 只能在工作目录 … 之下选择目录 |
| 含 `..` 路径段（realpath 之前就拒，不靠折叠兜底） | 路径里不能出现 .. |
| 含 NUL 字节 | 路径不合法 |
| 路径存在但不是目录（比如一个文件） | 不是一个目录 |
| 存在但 `realpath` 后逃出根：`$HOME/x -> /etc`、`$HOME/x -> /` | 只能在工作目录 … 之下选择目录 |
| 不存在，但最近存在祖先是逃逸软链（`$HOME/x/sub`，`x -> /etc`） | 只能在工作目录 … 之下选择目录 |

**实现要点**：比较用 `path.relative(realRoot, realPath)` 判定 —— 结果不得以 `..` 开头、
不得是绝对路径、不得为空（为空表示就是根本身）；**不要用 `startsWith(root + "/")`
前缀匹配**，它管不住软链，也分不清 `$HOME2` 这种前缀相同的兄弟目录。根自己也要
realpath（根是软链时以它指向的真实目录为基准）。不存在的路径先向上找最近存在祖先、
realpath 祖先、再拼回剩余段，所以"祖先是不是软链、指向哪"照样参与判定。

列目录（`handleDirs`）复用同一个 `withinRoot()`：软链条目 realpath 后若越界，
返回 `{ name, path, symlink:true, blocked:true }` 而不进 stat 详情，前端据此灰显。

### ⚠️ 这台设备上只有「全权限」能用

Codex 在 Linux 上用 **bubblewrap** 做只读 / 可写工作区沙箱。这台设备：

- 没有 `bwrap`，Android 的 SELinux 也不允许 untrusted app 建 user namespace；
- 内核 4.14.116，**Landlock 需要 5.13+**，同样没有。

实测这两档的每一条命令都会直接失败：

```
error building bubblewrap command: No such file or directory (os error 2)
```

所以：

1. **默认模式是「全权限」**，不是规格里写的 workspace-write —— 否则开箱即坏。
   默认值不再随 `bwrap` 变化（曾写成 `BWRAP_AVAILABLE ? "workspace-write" : "danger-full-access"`，但那在「探测通过、实际跑不起来」的设备上照样开箱就坏）；`BWRAP_AVAILABLE` 现在只用来在前端把另外两档标成不可选。
2. 另外两档**仍然可选**，但菜单里标注「本机不可用」，选中时给提示；
   真跑到命令失败时服务端会发一次 `notice` 事件，前端显示成一句人话。
3. `GET /api/config` 会带上 `sandboxAvailable` 和原因，前端据此渲染。

## 上游出错与重试（willRetry）

app-server 的 `error` 通知长这样：

```json
{ "error": { "message": "...", "codexErrorInfo": "serverOverloaded" },
  "threadId": "...", "turnId": "...", "willRetry": true }
```

两个坑：

1. **`error` 是对象，不是字符串。** 早先翻译层写的是 `String(params.error)`，
   结果对话底部冒出两张内容为 `[object Object]` 的框。现在按 `TurnError`
   的结构取 `message` / `codexErrorInfo`，取不到就退化成 JSON，**永远不会**再
   出现 `[object Object]`（`tools/protocol-unit.js` 有 46 条断言锁住）。
2. **`willRetry=true` 不是失败。** 表示 app-server 自己会重试这一轮。
   现在这种发 `retry` 事件，前端显示成"上游出错，正在重试…（serverOverloaded）"
   的状态提示，**不往对话里塞红框**；只有 `willRetry=false` 才弹错误。

附带说明：上游报错重试时，模型会把开场白**重新说一遍**——那一轮出现了
"说了两遍"的现象，根因就是这个重试，不是模型抽风。

## 这台机器上的两个坑

1. **`ss` 看不到监听端口**。SELinux 策略让 Termux 里的 `ss -tln` 永远只有表头，
   拿它判断"端口空不空"会误判 → 新实例 `EADDRINUSE` 秒退，而请求被上一个
   老进程悄悄接走，现象是"改了代码却不生效"。所以 `start.sh` 用
   `tools/portcheck.js` 真连一下，别再用 `ss`。
2. **hardlink 被禁**。`services/codex-web` 所在分区不允许创建硬链接，凡是靠
   "写临时文件再 link 过去"的原子写工具在这里都会 `EACCES`。直接写文件即可。

## 界面（对齐 chatgpt.com/codex）

**骨架**：52px 图标 rail（品牌 / 新会话 / 搜索 / 主题 / 设置）+ 260px 会话 panel（分组：
今天 / 昨天 / 最近 7 天 / 更早，含搜索框、正在生成的绿点）+ 768px 内容列 + 底部 dock
（活动行 / 用量 / composer / footnote）。<1024px panel 退化成 overlay drawer，
<768px 单栏、rail 隐藏、header 出现 ☰。

**双主题**：`:root` 是 light（画布 #fff / 侧栏 #f9f9f9 / 墨 #0d0d0d），
`[data-theme="dark"]` 是 dark（画布 #212121 / 侧栏 #171717 / 文字 #ececec / 边框 #3d3d3d）。
无任何色相强调色，层级靠字重与留白。rail 上的月亮按钮切换，选择存 localStorage；
首次访问跟随 `prefers-color-scheme`。

**composer**：28px 胶囊（<768px 24px），结构按 ChatGPT 的真实排法 ——
第一行 textarea 通栏，第二行 `+ | 模型 pill | 权限 pill | 目录 pill | 弹簧 | 提示 | 发送键`。
卡面用 `--bg-composer`（dark #303030 / light #ffffff）+ 1px `--border-composer`
（dark #484848）的**描边卡**，不投影 —— 这是从线上 userstyle 的 token 映射表
（`--color-background-composer-surface` / `--border-medium`）核对出来的真值。

发送键 32×32 圆形：空输入灰底暗箭头 / 有输入白底黑箭头 / 生成中变停止方块，
150ms morph（图标 crossfade + rotate 90° + 容器 scale(.92)→1）。

**模型选择**：pill 上直接写「显示名 · 推理档」（跟 Codex 一样），点开 300px 菜单，
数据来自 `GET /api/models`（即 app-server 的 `model/list`，不在前端写死模型名）。

菜单顺序按 Codex：**先推理强度**（当前模型的 low/medium/high/xhigh/max/ultra，按它
实际支持的能力渲染、单排 chip、下方一行英文说明），分隔线，然后才是模型列表
（displayName + 两行描述 + 选中勾）。选择通过 `/api/chat` 的 `model` / `effort` 传给
`turn/start`，并记在会话上；顶部副标题实时显示「~ · GPT-6.1-Sol · 低」。

**品牌图标**：rail 顶部与空态大标用的都是 **Codex 的真标** —— 浅色下是白瓷块 +
紫蓝渐变 glyph，深色下是纯白 glyph（跟随 `data-theme` 切 `<g>`，跟 Codex 桌面 App
一致）。路径取自 langwatch 的 Codex provider icon（其注释说明它与 Codex App 的 mark
同源），没有用 OpenAI 的六瓣花 —— 两者是不同标。

**推理**：`item/reasoning/summaryTextDelta` → 一条带扫光文字的 "正在思考…"，
`item/completed` 后变"已思考 N 秒"，点开看推理摘要全文。

**回合页脚**：每轮助手消息底部一行 token 明细 ——
`输入 18.2k · 缓存 4.2k · 输出 6 · 推理 0 · 总计 18.2k`，
数据来自 `thread/tokenUsage/updated` 的 `last` 四项（input / cachedInput /
output / reasoningOutput）。这是 Codex 卡片底部那行的对应物。

**助手消息是卡片**：整轮回复包在一个 12px 圆角、1px 描边、`#1e1e1e`（浅色 `#fff`）
的卡里，工具组不再画左侧竖线 —— 对齐 Codex 的实拍（canvas `#1c1c1c` / 卡 `#1e1e1e`）。

**工具调用可视化**：
- 卡片 36px 头：图标 + 「已运行 npm test」+ 右侧时长 + ✓/✗/■/转圈 + 折叠箭头
- 语义化：`apply_patch` → 「正在修改：src/a.js」、`filesystem/read_file` → 「正在读取：…」
- 未知工具降级成通用卡片：工具名当标题，参数 JSON 摊在展开区
- 连续多个工具自动归到一组，组头显示「正在执行 3 个操作…」
- 输出通过 `tool_delta` 实时滚进卡片（max-height 320px 内部滚动）；跑完用 `tool_result` 的权威全文校正
- 折叠规则：**运行中自动展开**（不然看不到实时输出），**跑完自动收起**；用户手动点过之后一律听用户的

**计划卡**：`turn/plan/updated` → 有序清单，每步 ✓ / ▸ / ○ 三态。

**diff 卡**：优先用 `turn/diff/updated` 的聚合 diff（只含 Codex 自己改的），
超过 30 行折叠、按钮可展开全文；app-server 没发时用 `/api/diff`（git）兜底。
行渲染成四列（旧行号 / 新行号 / +− / 正文），行号从 hunk 头解析、删行只动左列，
配色走 `--diff-add-bg` / `--diff-del-bg`，跟 GitHub 和 Codex 的 diff 视图一致。

**代码块**：34px header（语言名 + 图标+文字的复制键，28px 高）+ 12px 圆角，
单一容器圆角（内部 pre 不再有第二个框）+ bash/js/ts/python/json 四类 token 着色；
复制用 `data-code` 里的 base64 还原原文（中文/emoji 无损）。

**新增 item 类型**：Codex 0.16x 的 `collabAgentToolCall`（派子任务）、`subAgentActivity`、
`sleep`、`contextCompaction`、`functionCallOutput` 都做了语义化映射（"正在派发 N 个子任务"、
"等待 N 秒"、"正在压缩上下文"），不再是"通用卡片 + 一坨 JSON"。

**消息动作**：每条用户消息 hover 出「复制 / 编辑」（编辑 = 回填到输入框并聚焦光标到末尾，
改完再发；不做分叉），每条助手消息 hover 出「复制 / 重试」（重试 = 把最后一条用户消息原样再发一次）。

**图片附件**：composer 左上角的 + 按钮、粘贴、拖拽文件都能加图（png/jpeg/gif/webp/bmp，单张 ≤20MB）。
前端 `POST /api/upload` 把字节落成临时文件，拿回绝对路径；发送时作为 `images` 传给
`/api/chat`，后端转成 app-server 的 `{type:"localImage",path}` —— 协议自己读文件，不用把
base64 塞进 JSON。用户气泡里直接显示缩略图。

**快捷键**：`Ctrl/Cmd+K` 搜索会话、`Ctrl/Cmd+Shift+O` 新会话、`Ctrl/Cmd+B` 折叠侧栏
（rail 顶部的方形按钮是同一个动作，状态存 localStorage）。`Esc` 关掉所有浮层。

**回到底部**：滚上去之后 composer 上方浮出圆形 ↓ 按钮，滚回底部自动消失。

**右侧多功能区**（≥1280px，320px，Codex App 的第三栏）：四个页签 ——
**文件**（`/api/dirs` 的目录树，逐层点进去）、**终端**（本轮跑过的命令与实时输出，
数据源是 SSE 的 `tool` / `tool_delta` / `tool_result`）、**变更**（`/api/diff/full` 的
完整 diff，四列行号视图）、**上下文**（工作目录 / 模型 / 推理档 / 权限 / 用量 / 会话 ID，
每行还标出它的数据来源接口）。顶栏右侧的方块图标开关，或 `Ctrl+\`；
`Ctrl+1..4` 直接切页签。

**图标化**：工具卡的状态位、折叠箭头、计划卡三态、Think 圆点、消息动作
（复制 / 编辑 / 重试）、文件树、代码块复制键 —— 全部换成 inline SVG，
不再用 ✓ ✗ ■ › 📁 这些文字/emoji 符号（emoji 在不同系统上字形和宽度都不一样，
是"看起来不像"的一大来源）。

**沙箱 × 审批（两个正交轴）**：Codex App 把"能碰什么"和"什么时候停下来问你"拆成两件事。
本项目照同样的拆法：`mode`（只读 / 可写工作区 / 全权限）决定 sandbox，
`approval`（跟随沙箱档 / 按需确认 / 严格 / 从不询问）决定 `approvalPolicy`。
权限 pill 上写的是 `全权限 · 自动` 这种两段文案，菜单里分「沙箱」「审批」两段。
本机（Android 跑不了 bubblewrap）真正能看到审批卡的唯一组合是
**全权限 + 按需确认** —— 界面上的「按需确认」就是为这个加的。

**审批卡**（Codex App 的 Approve / Reject）：app-server 的
`ExecCommandApproval` / `ApplyPatchApproval` / `PermissionsRequestApproval` 反向请求
不再被一律自动拒绝 —— `appserver.js` 把它登记成 pending，转成 SSE 的 `approval` 事件，
前端画成一张卡（命令 / 文件 / 目录 / 原因 + 「允许 / 总是允许 / 拒绝」三颗按钮），
点按钮回 `POST /api/approval {id, choice}`，后端用同一个 jsonrpc id 回给 Codex。
5 分钟没人理按拒绝处理（不放任一轮挂死）；事件流里的 `approval_resolved` 会把
别处点的结果同步到卡片上。

**追加输入（steer）**：一轮跑着的时候输入框仍然可用 —— placeholder 变成
「向当前轮次追加输入…」，回车/发送键把内容作为**补充指令**发给同一轮
（`POST /api/steer` → app-server 的 `turn/steer`），不是新开一轮。这是 Codex App
的 `向当前轮次追加输入…` 那条。

**中断**：生成中的停止键是 composer 右侧独立的方块按钮（也可 `Ctrl+.`，Codex 的
中断快捷键）→ `POST /api/interrupt`，卡片转「已中断」，6 秒安全网兜底。

**连接状态**：顶栏胶囊 `● 已连接` 三态 —— 绿（connected）/ 黄脉冲（working，正在跑
一轮）/ 灰（offline，SSE 断了正在重连），状态跟着真实的 SSE 生命周期走。

**演示模式**（只用于视觉验收，不走网络）：

| URL | 作用 |
|---|---|
| `/?demo=1` | 把一段真实形状的对话（推理 / 三个工具卡 / 计划 / 代码块 / 表格 / 引用 / diff）直接塞进 DOM |
| `/?demo=stream` | 按真实节奏播一遍流式：光标逐字推进、Thinking 扫光 → "已思考 N 秒"、工具卡自动展开→自动收起、发送键 morph 成停止、用量条跳数 |

`&theme=light\|dark` 强制主题。两个 demo 都走**和真回合同一套** DOM 装配函数，
所以看到的排版和真实跑一轮完全一致。

**上下文用量**：输入框上方右侧 `14k/258k` + 进度条，≥70% 变黄、≥90% 变红。

**会话列表**：左侧 260px panel（<1024px 变成 ☰ 抽屉），列出这台机器上所有落盘的
Codex 会话（**包括命令行里开的**），按**工作区**分组（Codex App 的侧栏就是按 workspace
分，不是按日期）—— 组头可点折叠、带会话条数，折叠状态存 localStorage。带搜索框。
点一条就把历史回填出来（推理摘要、工具卡片、计划都在），之后继续聊就是同一个 thread ——
app-server 被回收过也没关系，会自动 `thread/resume` 把上下文接回来。
行 hover 出两个动作：✎ 重命名（`thread/name/set`）、🗑 删除（`thread/delete`，二次确认；
正在生成的会话拒绝删除）。

**PWA**：可「添加到主屏幕」，独立窗口打开。`sw.js` **只**缓存图标和清单，
页面和接口永远走网络 —— 免得改前端时拿到旧界面。

## 手机端（主要使用场景）

手机浏览器打开带 token 的链接，或「添加到主屏幕」后用 PWA 独立窗口。

**链接要整条复制干净。** 服务打印的是
`http://127.0.0.1:3081/?token=…`，手机上全选很容易把前后的中文一起粘进地址栏。
粘脏了不会坏 —— 前端会把 32 位十六进制的真令牌抠出来用，并提示一次；
实在抠不出来就退回「未认证」并告诉你去重贴，不会把界面打死（详见 MEMORY.md §12.1）。

窄屏（<768px）与桌面的差别：

| | 窄屏 |
|---|---|
| 一级导航 rail | 隐藏，改用顶栏 ☰ 开抽屉 |
| 会话列表 | 280px overlay 抽屉，头部有 ＋ / ⚙ 设置 / ✕ |
| 设置与主题 | 抽屉头部那颗齿轮（rail 没了，这是唯一入口） |
| 右侧多功能区 | **全屏浮层**（顶栏 ▢ 打开；五个页签照常） |
| 「会话」页签 | 手机上等于关闭浮层回到聊天（没有 320px 窄栏这个形态） |
| 顶栏 | 收起目录/权限两颗 pill，把宽度让给标题（它们与 composer 里的是同一入口） |
| composer | 圆角 24px，工具行 36px，技能 chip 收成纯图标 |
| 键盘 | `interactive-widget=resizes-content`，输入框跟着视口顶起，不会被挡 |
| 刘海 / Home 条 | `env(safe-area-inset-*)` 避让 |

其它触摸相关的处理：`touch-action: manipulation`（去掉点按 300ms 延迟与双击缩放）、
去掉点击高亮闪块、粗指针设备上动作条常驻可见、横屏收紧 composer 与 hero。

验收：`node tools/e2e-mobile.cjs`（51 项，390x844 / 360x800 / 320x700 三种手机尺寸 +
桌面回归），已并进 `npm run test:e2e`。

## 还不知道 / 没做的

- **真实截图比对**：只有开源 `codex-webui` 的 6 张实拍，chatgpt.com/codex 本体的像素级截图没拿到，
  间距与灰度靠反推（详见 MEMORY.md §9 第 1 条）。
- **审批卡的 UI 链路只在协议层测过**：`tools/approval-unit.mjs` 断言回包字面形状，
  `makeApprovalCard()` 三颗按钮 → `POST /api/approval` 这条还没有浏览器端到端脚本。
- 推理强度是 chip 不是滑杆；会话行是 hover 两个图标不是 ⋯ 菜单；「技能」chip 只弹说明。
- 没有多用户 / 权限分级：所有人共用同一个令牌；只监听 127.0.0.1。

> 早期这里写过「没法删除会话」「历史里不渲染 reasoning」——**两条都已经实现了**：
> `POST /api/thread/rename` / `/api/thread/delete`（server.js:1447 / 1463 → `thread/delete`），
> `src/history.js` 会把 `item.type === "reasoning"` 的 summary 作为 parts 回吐给前端。
