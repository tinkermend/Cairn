#!/usr/bin/env bash
# 本地进程栈的启停。用于非 dev 场景（跑构建产物、验证停机行为）。
# 开发期请用 pnpm dev —— 那条路径带 watch 与自动重启。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/.run"
SERVICES=(api worker)

mkdir -p "$RUN_DIR"

pid_file()  { echo "$RUN_DIR/$1.pid"; }
log_file()  { echo "$RUN_DIR/$1.log"; }

is_running() {
  local pid_path; pid_path="$(pid_file "$1")"
  [[ -f "$pid_path" ]] || return 1
  kill -0 "$(cat "$pid_path")" 2>/dev/null
}

start_one() {
  local svc="$1"
  if is_running "$svc"; then
    echo "  已在运行  cairn-$svc (pid $(cat "$(pid_file "$svc")"))"
    return
  fi
  if [[ ! -f "$ROOT/packages/$svc/dist/main.js" ]]; then
    echo "  ✗ cairn-$svc 未构建，先执行 pnpm build" >&2
    return 1
  fi
  # setsid 让服务脱离当前 shell 的进程组，收到的信号才是我们发的那个
  ( cd "$ROOT/packages/$svc" && exec node dist/main.js ) \
    >>"$(log_file "$svc")" 2>&1 &
  echo $! > "$(pid_file "$svc")"
  echo "  ✅ 已启动  cairn-$svc (pid $!)  日志 .run/$svc.log"
}

stop_one() {
  local svc="$1" pid_path; pid_path="$(pid_file "$svc")"
  if ! is_running "$svc"; then
    echo "  未运行    cairn-$svc"
    rm -f "$pid_path"
    return
  fi
  local pid; pid="$(cat "$pid_path")"
  # SIGTERM 让 Nest 的 OnApplicationShutdown 有机会释放租约与连接池
  kill -TERM "$pid"
  for _ in $(seq 1 100); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "  ⚠ cairn-$svc 未在 10s 内退出，强制终止"
    kill -KILL "$pid" 2>/dev/null || true
  else
    echo "  ✅ 已停止  cairn-$svc"
  fi
  rm -f "$pid_path"
}

status_one() {
  if is_running "$1"; then
    printf "  %-14s running  pid %s\n" "cairn-$1" "$(cat "$(pid_file "$1")")"
  else
    printf "  %-14s stopped\n" "cairn-$1"
  fi
}

case "${1:-}" in
  start)   for s in "${SERVICES[@]}"; do start_one "$s"; done ;;
  stop)    for s in "${SERVICES[@]}"; do stop_one "$s"; done ;;
  restart) for s in "${SERVICES[@]}"; do stop_one "$s"; done
           for s in "${SERVICES[@]}"; do start_one "$s"; done ;;
  status)  for s in "${SERVICES[@]}"; do status_one "$s"; done
           printf "  %-14s " "api /health"
           curl -fsS --max-time 3 http://127.0.0.1:"${CAIRN_API_PORT:-3030}"/health 2>/dev/null || echo "不可达" ;;
  logs)    shift; tail -n "${1:-50}" -f "$RUN_DIR"/*.log ;;
  *)       echo "用法: $0 {start|stop|restart|status|logs [行数]}" >&2; exit 1 ;;
esac
