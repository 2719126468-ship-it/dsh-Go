#!/usr/bin/env bash
# 停 codex-web 后台服务（连带它拉起的 codex / proot 子进程树）。
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-3081}"
PIDFILE="$DIR/.pids/server.pid"

stopped=0

if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    for _ in $(seq 1 40); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$PID" 2>/dev/null; then
      kill -9 "$PID" 2>/dev/null || true
    fi
    echo "已停止 codex-web（pid $PID）"
    stopped=1
  fi
  rm -f "$PIDFILE"
fi

# 兜底：pid 文件丢了但端口还占着。这台机器上 ss 看不到监听套接字，
# 也不是 root，查不到占用者是谁 —— 但至少要把这件事说清楚，别假装停干净了。
NODE_BIN="${NODE_BIN:-$(command -v node)}"
if [ "$stopped" = 0 ] && [ -x "$NODE_BIN" ] && "$NODE_BIN" "$DIR/tools/portcheck.js" "$PORT" 127.0.0.1; then
  if curl -fsS -m 3 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null | grep -q '"appServer"'; then
    echo "警告：${PORT} 端口上还有一个 codex-web 在跑，但 pid 文件丢了、本机权限也查不到它的 pid。" >&2
    echo "      从 Termux 里用 \`ps -ef | grep 'node server.js'\` 找到它再 kill。" >&2
  else
    echo "警告：${PORT} 端口被别的程序占着（不是 codex-web）。" >&2
  fi
fi

[ "$stopped" = 1 ] || echo "codex-web 没有在跑。"
exit 0
