#!/usr/bin/env bash
# 启动 sharedchat-bridge（幂等：已在跑就直接返回）
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${BRIDGE_PORT:-8787}"

if curl -s -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "bridge 已在 ${PORT} 运行"; exit 0
fi

# 取 key：环境变量 > ~/.bashrc > 本地 .env
KEY="${SHAREDCHAT_API_KEY:-}"
if [ -z "$KEY" ] && [ -f "$HOME/.bashrc" ]; then
  KEY="$(bash -lc 'source ~/.bashrc >/dev/null 2>&1; printf %s "${SHAREDCHAT_API_KEY:-}"')"
fi
if [ -z "$KEY" ] && [ -f "$DIR/.env" ]; then
  KEY="$(grep -E '^SHAREDCHAT_API_KEY=' "$DIR/.env" | head -1 | cut -d= -f2- | tr -d "\"'")"
fi
if [ -z "$KEY" ]; then
  echo "!! 没找到 SHAREDCHAT_API_KEY（写进 ~/.bashrc 或 $DIR/.env）" >&2; exit 1
fi

cd "$DIR"
nohup setsid env SHAREDCHAT_API_KEY="$KEY" python3 bridge.py --port "$PORT" \
  >> "$DIR/bridge.log" 2>&1 < /dev/null &
sleep 2
if curl -s -m 3 "http://127.0.0.1:${PORT}/health" >/dev/null; then
  echo "bridge 已启动: http://127.0.0.1:${PORT}/v1  (日志 $DIR/bridge.log)"
else
  echo "启动失败，看 $DIR/bridge.log" >&2; tail -5 "$DIR/bridge.log" >&2; exit 1
fi
