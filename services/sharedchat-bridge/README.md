# sharedchat-bridge

> **在 dsh-Go 单仓库里**：源码位于 `services/sharedchat-bridge/`，属于 [Codex 套件](../../docs/codex-suite.md)。
> 启动：`cp services/sharedchat-bridge/.env.example services/sharedchat-bridge/.env` 填 key，然后 `bash services/sharedchat-bridge/start.sh`。

把 sharedchat 的 **codex 专用 key** 变成 Tavo / SillyTavern / Risu / 任意 OpenAI 兼容 RP 客户端能直接用的接口。

## 为什么需要它

sharedchat 的 `https://new.sharedchat.cc/codex/v1` 只开 **Responses API**，而且加了客户端指纹校验，实测规则如下（一条条试出来的）：

| 现象 | 结论 |
|---|---|
| `POST /codex/v1/chat/completions` → `{"code":0,"msg":"该接口未接入公益站独立网关"}` | 没有 chat completions，别指望 Tavo 直连 |
| `POST /codex/v1/responses` 带 `originator: codex_exec` + codex UA → 有时 200，有时 403 | 只靠 header 不够 |
| 403 body：`codex_access_restricted` / "请使用最新版的codex客户端或codex cli调用" | 服务端判定"不是 codex 客户端" |
| body 里带 `client_metadata.x-codex-installation-id`（任意非空字符串即可，连 `""` 都过） → 稳定 200 | **真正的门禁在 body，不在 header** |
| `client_metadata` 里只有 `thread_id` / `session_id` / `turn_id` → 403 | 只认 `x-codex-installation-id` 这个键 |
| 不带 `instructions` → 上游塞进 Codex 的编程 agent 系统提示 | RP 会被"我是编程助手"污染，必须自己传 instructions |

所以：**Tavo 无法直连**，必须在本地起一个桥，把 chat/completions 翻成带 `client_metadata` 的 responses 请求。

## 架构

```
Tavo / SillyTavern / 任意 RP 客户端
      │  OpenAI 协议  POST /v1/chat/completions
      ▼
sharedchat-bridge  (127.0.0.1:8787, Python 标准库 + requests)
      │  ① chat messages → responses input items
      │  ② 注入 client_metadata.x-codex-installation-id
      │  ③ 注入 instructions（挡掉 Codex 人设）
      │  ④ 上游 403/RST 自动重试 6 次并换指纹
      ▼
https://new.sharedchat.cc/codex/v1/responses
```

## 起停

```bash
cd services/sharedchat-bridge
./start.sh          # 幂等，已在跑就直接返回
./stop.sh
tail -f bridge.log  # 每条请求一行日志
```

开机自启已挂到 `~/.termux/boot/50-sharedchat-bridge.sh`（需要装 Termux:Boot 并手动启动一次 App）。

key 来源优先级：`$SHAREDCHAT_API_KEY` > `~/.bashrc` > 本目录 `.env`。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions` | 主用。支持 `stream: true/false`、`tools`（function calling）、图片输入 |
| POST | `/v1/responses` | 原样透传（Tavo 的 `openai_responses` 模式用这个） |
| GET | `/v1/models` | 返回 `gpt-5.6-sol`、`gpt-5.6-terra` |
| GET | `/health` `/v1` | 健康检查 |

模型别名：`gpt-4o` / `gpt-4.1` / `claude-sonnet-4` / `deepseek-chat` 等一律映射到 `gpt-5.6-sol`，方便客户端只认老模型名。

实测可用模型（2026-10）：

- ✅ `gpt-5.6-sol`、`gpt-5.6-terra`
- ❌ `gpt-5.4`、`gpt-5.5` → `insufficient_balance`
- ❌ `gpt-6-sol` → `Codex model price is temporarily unavailable`
- ❌ `gpt-6.1-sol`、`gpt-6-astra`、`codex-auto-review` → 连接被重置

## Tavo 里怎么填

Tavo 的「自定义（OpenAI 协议）」要求 **API 基础 URL**，它会自己拼 `/chat/completions`：

| 字段 | 值 |
|---|---|
| 模型平台 | 自定义（OpenAI 协议） |
| API Key | 随便填，例如 `local`（除非你设了 `BRIDGE_KEY`） |
| API 基础 URL | `http://127.0.0.1:8787/v1` |
| 模型名 | `gpt-5.6-sol`（或 `gpt-5.6-terra`） |

注意：

1. **别填 `https://new.sharedchat.cc/codex/v1`** —— 那是 responses 协议 + 指纹校验，Tavo 直连必然失败。
2. Tavo 的 manifest 是 `usesCleartextTraffic=true`，`http://127.0.0.1` 能直连，不用 https、不用证书。
3. 如果 Tavo 跑在另一台设备（同一 WiFi），把 bridge 用 `--host 0.0.0.0`（默认已是）启动，URL 换成本机内网 IP，例如 `http://192.168.x.x:8787/v1`。建议同时设 `BRIDGE_KEY=你的口令`，Tavo 的 API Key 填同一个值。
4. 模型平台里如果 Tavo 有「API 模式 / API Mode」选项，选 `openai_chat`；选 `openai_responses` 也能用（走 `/v1/responses` 透传）。

## 已知坑

- **上游会随机 RST**：约 25–50% 的首次请求被 `Connection reset by peer` 掐断，与 header 无关（各种 header 组合都测过，成功率无差异）。桥里做了 6 次重试 + `Connection: close` 不复用连接，实际体感是"首字慢 5–15 秒但一定出结果"。
- **偶发 524**：Cloudflare 超时，重试即可。
- **必须自己给 instructions**：不传的话上游会注入 Codex 的编程 agent 提示词，角色扮演会串味。桥默认注入中性的 `DEFAULT_INSTRUCTIONS`，可在 `BRIDGE_DEFAULT_INSTRUCTIONS` 里改。
- **reasoning.effort 别设 `minimal`**：上游会去找 `gpt-5.6-sol-minimal` 这个不存在的计价项，直接 503。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `SHAREDCHAT_API_KEY` | 无 | 必填 |
| `SHAREDCHAT_BASE` | `https://new.sharedchat.cc/codex/v1` | 上游 |
| `SHAREDCHAT_MODEL` | `gpt-5.6-sol` | 默认模型 |
| `SHAREDCHAT_INSTALL_ID` | 固定 UUID | 指纹；换成任意非空字符串也行 |
| `BRIDGE_KEY` | 空 | 非空则校验下游 Authorization |
| `BRIDGE_PORT` / `BRIDGE_HOST` | 8787 / 0.0.0.0 | 监听 |
| `BRIDGE_TIMEOUT` | 300 | 上游超时秒 |
| `BRIDGE_DEFAULT_INSTRUCTIONS` | 中性 RP 提示 | 客户端没给 system 时用 |

---

## 七、破甲（2026-11-15 实测补充）

gpt-5.6-sol 的"甲"不是拒绝，是**软性降级**：写成"亲吻—抚触—相拥—呼吸渐渐急促—直到呼吸平复"，
一个具体动作都没有。压住它的不是 prompt 技巧，是三个参数：

| 配置 | 硬词命中 |
|---|---|
| 人设放 `instructions` | 0/9 |
| 人设放 `input[].role=developer` | 9/9 |
| developer 有人设 **+ 还带 instructions** | 0/9 |
| developer 有人设 + `store:false` | 2/3（抖） |
| developer 有人设，instructions/store 都不带 | 3/3 稳定 |

所以桥现在的行为：

1. `instructions` 不传（`BRIDGE_KEEP_INSTRUCTIONS=1` 可恢复）
2. `store` 不传（`BRIDGE_KEEP_STORE=1` 可恢复）
3. 人设一律走 `input[0] role=developer`
4. 客户端自带的 system（Tavo 角色卡）先经 `scrub_client_style()` 洗掉写法约束
   （正则 `STYLE_KILL`：含蓄/点到为止/适度/避免直白/文学化/克制/留白/淡出…整句剔除），
   只留角色名、人称、世界观，再拼在人设前面

人设文件与 codex CLI 共用 `~/.agent-purge/personas/active.md`，
`agent-purge use <id>` 切换后下一条请求即生效（按 mtime 热重载），不用重启桥。
