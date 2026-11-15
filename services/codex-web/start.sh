#!/usr/bin/env bash
# 起 codex-web 后台服务。重复执行是安全的（已在跑就直接报地址）。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-3081}"
HOST="${HOST:-127.0.0.1}"
PIDDIR="$DIR/.pids"
PIDFILE="$PIDDIR/server.pid"
LOGFILE="$DIR/server.log"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

mkdir -p "$PIDDIR"

# 这台机器上 ss 看不到监听套接字（SELinux），只能 TCP 实连。
port_busy() { "$NODE_BIN" "$DIR/tools/portcheck.js" "$PORT" "$HOST"; }

# 端口上跑的是不是我们自己人（而不是别的程序）。
is_ours() {
  curl -fsS -m 3 "http://${HOST}:${PORT}/healthz" 2>/dev/null | grep -q '"appServer"'
}

# 打印带 token 的完整访问地址。
#
# token 由服务端生成并默认复用（~/.codex-web-token），脚本自己算不出来，所以由
# server.js 写进 .token，这里读出来拼成一条可直接点/可整条复制的链接。读不到就
# 退回普通地址，不让"少一个文件"变成启动失败。
print_url() {
  local tk=""
  if [ -f "$DIR/.token" ]; then
    tk="$(cat "$DIR/.token" 2>/dev/null || true)"
  fi
  echo
  if [ -n "$tk" ]; then
    echo "🔐 访问地址: http://${HOST}:${PORT}/?token=${tk}"
    echo "   （整条复制到浏览器；token 默认复用，用 --new-token 轮换）"
  else
    echo "⚠️  访问地址：http://${HOST}:${PORT}"
    echo "   （没读到 .token —— 若服务要求认证，请看 ~/.codex-web-token）"
  fi
  echo
}

# --- 已经在跑？ ------------------------------------------------------------
if [ -f "$PIDFILE" ]; then
  OLD="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    if is_ours; then
      echo "codex-web 已经在跑了（pid $OLD）"
      print_url
      exit 0
    fi
    echo "pid $OLD 还活着但 ${PORT} 上没有应答，先把它清掉再启动。" >&2
    kill "$OLD" 2>/dev/null || true
    sleep 1
    kill -9 "$OLD" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
fi

if port_busy; then
  if is_ours; then
    # pid 文件丢了但服务还在（比如手动 nohup 起的）。
    echo "codex-web 已经在跑了（pid 文件缺失，端口 ${PORT} 上就是它）"
    print_url
    exit 0
  fi
  echo "端口 ${PORT} 被别的程序占用了（本机权限查不到是哪个进程）。" >&2
  echo "换一个端口再跑，例如：" >&2
  echo "  PORT=3082 $0" >&2
  exit 1
fi

# --- Codex 的 key ----------------------------------------------------------
# 非交互 shell 拿不到 ~/.bashrc 里的 export，这里补一次；只读，不改任何文件。
if [ -z "${SHAREDCHAT_API_KEY:-}" ]; then
  KEY="$(sed -n "s/^[[:space:]]*export[[:space:]]\{1,\}SHAREDCHAT_API_KEY=['\"]\{0,1\}\([^'\"]*\)['\"]\{0,1\}.*/\1/p" "$HOME/.bashrc" 2>/dev/null | tail -1 || true)"
  if [ -n "$KEY" ]; then
    export SHAREDCHAT_API_KEY="$KEY"
  else
    echo "提示：没找到 SHAREDCHAT_API_KEY，Codex 可能会报缺少环境变量。" >&2
  fi
fi

# --- 起服务 ---------------------------------------------------------------
cd "$DIR"
nohup "$NODE_BIN" server.js >>"$LOGFILE" 2>&1 &
PID=$!
echo "$PID" > "$PIDFILE"

# --- 等它真的能应答 --------------------------------------------------------
for i in $(seq 1 40); do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "服务启动失败，日志末尾：" >&2
    tail -20 "$LOGFILE" >&2
    rm -f "$PIDFILE"
    exit 1
  fi
  if curl -fsS "http://${HOST}:${PORT}/healthz" >/dev/null 2>&1; then
    echo "codex-web 已启动（pid $PID）"
    print_url
    echo "日志：$LOGFILE"
    echo
    echo "注：服务启动时已预热 Codex 子进程（见 server.log 的「预热完成」），首轮不再等冷启动。"
    exit 0
  fi
  sleep 0.25
done

echo "服务起来了但 /healthz 没应答，看看日志：$LOGFILE" >&2
tail -20 "$LOGFILE" >&2
exit 1
