#!/usr/bin/env bash
# Stop only the bridge process recorded by this service own start.sh.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/bridge.pid"
[ -f "$PID_FILE" ] || { echo "bridge 未运行（没有 PID 文件）"; exit 0; }
PID="$(cat "$PID_FILE" 2>/dev/null || true)"
case "$PID" in ''|*[!0-9]*) echo "无效 PID 文件，拒绝杀进程" >&2; exit 1;; esac
CMDLINE="$(tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null || true)"
PROC_CWD="$(readlink -f "/proc/$PID/cwd" 2>/dev/null || true)"
case "$CMDLINE" in *bridge.py*) ;; *) echo "PID $PID 已不是 Python bridge，清理陈旧 PID 文件"; rm -f "$PID_FILE"; exit 0;; esac
if [ "$PROC_CWD" != "$DIR" ]; then
  echo "PID $PID 不属于当前 bridge 目录，拒绝杀进程"
  rm -f "$PID_FILE"
  exit 1
fi
kill -TERM "$PID" 2>/dev/null || true
for _ in $(seq 1 10); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
if kill -0 "$PID" 2>/dev/null; then
  CMDLINE="$(tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null || true)"
  case "$CMDLINE" in *bridge.py*) kill -KILL "$PID" 2>/dev/null || true;; esac
fi
rm -f "$PID_FILE"
echo "bridge 已停止"
