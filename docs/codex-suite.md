# Codex 套件

本仓库把原先分散在 `~/codex` 与 `codex-web` 两个目录里的 Codex 相关组件收进同一条代码线：
**一个仓库、一套 CI、一个 APK 构建入口**。三者互不依赖，各自可单独运行。

| 组件 | 位置 | 作用 | 运行依赖 |
| --- | --- | --- | --- |
| Codex Web | `services/codex-web/` | 手机浏览器里的本地 Codex 聊天界面（三栏、双主题、SSE 流式、工具卡/diff/审批卡） | Node ≥ 20，零 npm 依赖，本机 `codex app-server` |
| OpenAI 兼容桥 | `services/sharedchat-bridge/` | 把只开 Responses API 的 codex 专用上游翻译成 `/v1/chat/completions`，给 RP 客户端直连 | Python 3 + `requests` |
| DSH 插件 | `packages/dsh-codex-delegate/` | `codex_delegate` 工具 + `codex` SubagentProvider，一次常驻 `codex app-server` 供多次调用 | DSH ≥ 0.2，本机 Codex CLI |
| 抓包探针 | `tooling/codex-capture/` | 记录上游请求体、逐项删字段复放，定位"哪个字段才是门禁" | Python 3、curl、可选上游账号 |

## 为什么并进来

- **同一条 PR 门禁**：以前三份代码各自验证，改动跨组件时没有一处能同时看到。现在 `ci.yml` 的 `Codex suite` job 一次跑完。
- **APK 与 Web 端同一个版本号**：`tooling/build-apk.sh` 与 `services/codex-web` 都从仓库根出发，构建脚本不再需要绝对路径。
- **凭据只有一个出口**：真实 key、token、会话历史、抓包日志都不进仓库；启动脚本从环境变量或本地 `.env` 读。

## 目录

```
services/codex-web/          Web 界面：server.js + src/ + public/ + tools/
  server.js                  本地 HTTP/SSE 服务（默认 127.0.0.1:3081）
  src/appserver.js           常驻 codex app-server 的 JSON-RPC 客户端
  src/paths.js               工作目录白名单
  public/                    前端单页（index.html / app.js / app.css / markdown.js）
  tools/                     单测（tools/approval-unit.mjs 等）与 e2e 脚本
services/sharedchat-bridge/  bridge.py + start.sh / stop.sh / .env.example
packages/dsh-codex-delegate/ index.js + src/appserver.js + src/provider.js + cordis.patch.yml
tooling/codex-capture/       cap.py（假上游，落 body.json/capture.jsonl）+ probe*.py + replay*.sh
```

## 运行

### Codex Web

```bash
node services/codex-web/server.js                 # 前台
bash services/codex-web/start.sh                  # Termux 后台（幂等）
cd services/codex-web && npm test                 # 单测，135 项断言，零依赖
```

默认监听 `127.0.0.1:3081`，带 token 的访问地址由 `start.sh` 打印。前端与 `codex app-server` 的 UI 契约见 `services/codex-web/CONTRACT.md`，视觉规范见 `design-spec.md`。

### sharedchat-bridge

```bash
cp services/sharedchat-bridge/.env.example services/sharedchat-bridge/.env   # 填 SHAREDCHAT_API_KEY
bash services/sharedchat-bridge/start.sh                                     # 默认 127.0.0.1:8787
python3 services/sharedchat-bridge/bridge.py --help
```

### dsh-codex-delegate

```bash
# 在 DSH 会话里（danger-full-access）：
#   plugin_manager { action: "install_bundle", target: "<repo>/packages/dsh-codex-delegate" }
# 改完 index.js 必须重启 DSH：loader 缓存模块代号，热改不生效。
```

### 抓包探针

```bash
cd tooling/codex-capture
python3 cap.py            # 假上游监听 127.0.0.1:8899，把请求写进 capture.jsonl/body.json
python3 probe.py          # 基于 body.json 逐字段删减复放，看哪个字段决定 200/403
SHAREDCHAT_API_KEY=... bash replay.sh
```

探针会向真实上游发请求，属于诊断工具，不在 CI 里跑。

## CI 与 APK

- `.github/workflows/ci.yml` 的 `Codex suite` job：`node --check` 全部服务端入口、`services/codex-web` 的 `npm test`、`services/sharedchat-bridge/bridge.py` 的 `py_compile`、插件模块的语法检查。结果并入 `CI OK`。
- `.github/workflows/apk-build.yml`：PR 改动 `app/**`、`runtime/**`、`tooling/**`、`packages/**` 时在 GitHub runner 上编 debug APK 并上传 artifact；`workflow_dispatch` 可手动触发。带签名的正式包仍走 `custom-release.yml`（需要 `KEYSTORE_B64` 等 secrets）。
- 本地没有 Flutter/Android SDK 也能出包：APK 编译全部交给 GitHub Actions。

## 边界

- `services/codex-web` 是独立 Web 端，不嵌入 Flutter App 的岛视图；二者协议、UI 各自演进，**不共享代码**。
- 仓库里不含 Codex CLI 二进制、真实 API key、`~/.codex` 会话、抓包日志（`body.json`、`capture.jsonl`、`*.log` 均被忽略）。
- `services/` 下的服务不参与 App 运行时打包；APK 里不会多出这几万行 JS/Python。

## English summary

The Codex components that used to live in two separate places are now part of this monorepo:

- `services/codex-web/` — zero-dependency Node web UI for a local `codex app-server` (port 3081).
- `services/sharedchat-bridge/` — Responses-API to OpenAI chat-completions bridge (port 8787).
- `packages/dsh-codex-delegate/` — DSH plugin exposing `codex_delegate` plus a `codex` subagent provider.
- `tooling/codex-capture/` — request capture and field-by-field replay probes.

`ci.yml` runs all of them in the `Codex suite` job; `apk-build.yml` builds a debug APK on GitHub Actions for pull requests that touch app/runtime/tooling/packages, so no local Flutter or Android SDK is required.
