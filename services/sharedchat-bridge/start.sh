#!/usr/bin/env bash
# 启动 sharedchat-bridge（幂等：已在跑就直接返回）
set -euo pipefail
umask 077
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${BRIDGE_PORT:-8787}"
HOST="${BRIDGE_HOST:-127.0.0.1}"
PID_FILE="$DIR/bridge.pid"
ENV_FILE="$DIR/.env"

read_env_value() {
  python3 - "$ENV_FILE" "$1" <<'PY'
import pathlib, sys
path, name = pathlib.Path(sys.argv[1]), sys.argv[2]
if path.is_file():
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith(name + "="):
            print(line.split("=", 1)[1].strip().strip(chr(34) + chr(39)))
            break
PY
}

KEY="${SHAREDCHAT_API_KEY:-}"
if [ -z "$KEY" ] && [ -f "$HOME/.bashrc" ]; then
  KEY="$(bash -lc 'source ~/.bashrc >/dev/null 2>&1; printf %s "${SHAREDCHAT_API_KEY:-}"')"
fi
[ -n "$KEY" ] || KEY="$(read_env_value SHAREDCHAT_API_KEY)"
if [ -z "$KEY" ]; then
  echo "!! 没找到 SHAREDCHAT_API_KEY（写进 ~/.bashrc 或 $ENV_FILE）" >&2
  exit 1
fi

BRIDGE_KEY_VALUE="${BRIDGE_KEY:-}"
[ -n "$BRIDGE_KEY_VALUE" ] || BRIDGE_KEY_VALUE="$(read_env_value BRIDGE_KEY)"
case "$HOST" in
  127.0.0.1|::1|localhost) ;;
  *)
    if [ -z "$BRIDGE_KEY_VALUE" ]; then
      echo "!! 非本机监听必须配置 BRIDGE_KEY（环境变量或 $ENV_FILE）" >&2
      exit 1
    fi
    ;;
esac

if curl -fsS -m 2 -H "Authorization: Bearer $BRIDGE_KEY_VALUE" "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "bridge 已在 $PORT 运行"
  exit 0
fi

cd "$DIR"
nohup setsid env SHAREDCHAT_API_KEY="$KEY" BRIDGE_HOST="$HOST" BRIDGE_KEY="$BRIDGE_KEY_VALUE" \
  python3 bridge.py --host "$HOST" --port "$PORT" \
  >> "$DIR/bridge.log" 2>&1 < /dev/null &
PID=$!
echo "$PID" > "$PID_FILE"
for _ in $(seq 1 10); do
  if curl -fsS -m 2 -H "Authorization: Bearer $BRIDGE_KEY_VALUE" "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "bridge 已启动: http://$HOST:$PORT/v1  (日志 $DIR/bridge.log)"
    exit 0
  fi
  sleep 1
done
kill -TERM "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
echo "启动失败，看 $DIR/bridge.log" >&2
tail -10 "$DIR/bridge.log" >&2 || true
exit 1
