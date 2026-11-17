# codex-capture

Codex/Responses 上游的**抓包 + 复放**探针。从一个真实请求体出发，逐项删字段看服务端还认不认，
用来回答"门禁到底在 header 还是 body 里"这类问题。

## 文件

| 文件 | 作用 |
| --- | --- |
| `cap.py` | 假上游：监听 `127.0.0.1:8899`，把收到的请求追加进 `capture.jsonl`、请求体写 `body.json`，并回一段最小 SSE 流 |
| `probe.py` … `probe9.py` | 基于 `body.json` 的逐字段删减/改写复放，打印每轮的 HTTP 状态码 |
| `replay.sh`、`replay2.sh` | 原样复放两次实测请求（单行 curl） |

## 用法

```bash
cd tooling/codex-capture
python3 cap.py &                 # 终端 1
# 把 Codex 的 base_url 指到 http://127.0.0.1:8899/... 发一轮请求，生成 body.json
python3 probe.py                 # 终端 2：逐字段删减复放
SHAREDCHAT_API_KEY=sk-xxx bash replay.sh
```

## 注意

- 这些脚本会向真实上游发请求，属于一次性诊断工具；CI 只做语法检查，不执行。
- `body.json`、`capture.jsonl`、`out*.txt`、`*.log` 是本地产物，**不要提交**（已在 `.gitignore` 忽略）。
- `capture.jsonl` 会保留请求正文（可能含私密对话内容），但 `Authorization`、`x-api-key`、Cookie 等凭据头会脱敏；捕获文件权限固定为 `0600`。分享诊断产物前仍应检查正文。
- 复放脚本从 `SHAREDCHAT_API_KEY` 读 key，仓库里不保存任何凭据。
