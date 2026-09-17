#!/usr/bin/env bash
# 本地进程栈的启停与管理。
# 用于非 dev 场景（跑构建产物、验证停机行为、后台运行）。
# 开发期热重载请使用 pnpm dev 或 pnpm dev:backend / pnpm dev:web。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/.run"
LOGS_DIR="$ROOT/logs"

mkdir -p "$RUN_DIR" "$LOGS_DIR"

pid_file() { echo "$RUN_DIR/$1.pid"; }
log_file() { echo "$LOGS_DIR/$1.log"; }

get_env_val() {
  local key="$1" default="$2"
  if [[ -n "${!key:-}" ]]; then
    echo "${!key}"
    return
  fi
  if [[ -f "$ROOT/.env" ]]; then
    local val
    val="$(grep -E "^${key}=" "$ROOT/.env" 2>/dev/null | cut -d '=' -f2- | sed -e 's/[[:space:]]*#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | tail -n 1 || true)"
    if [[ -n "$val" ]]; then
      echo "$val"
      return
    fi
  fi
  echo "$default"
}

port_of() {
  case "$1" in
    api)    get_env_val "CAIRN_API_PORT" "3030" ;;
    worker) get_env_val "CAIRN_WORKER_INTERNAL_PORT" "8091" ;;
    web)    get_env_val "CAIRN_WEB_PORT" "5173" ;;
    *)      echo "" ;;
  esac
}

pids_on_port() {
  local port="$1"
  [[ -n "$port" && "$port" -gt 0 ]] || return 0
  lsof -iTCP:"$port" -sTCP:LISTEN -P -n -t 2>/dev/null | sort -u || true
}

recorded_pid() {
  local pid_path; pid_path="$(pid_file "$1")"
  if [[ -f "$pid_path" ]]; then
    local pid; pid="$(cat "$pid_path" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
  fi
  return 1
}

resolve_services() {
  local target="${1:-all}"
  case "$target" in
    all)             echo "api worker web" ;;
    backend)         echo "api worker" ;;
    frontend|web)    echo "web" ;;
    api)             echo "api" ;;
    worker)          echo "worker" ;;
    *)
      echo "未知服务目标: $target (可选: api, worker, web, backend, all)" >&2
      exit 1
      ;;
  esac
}

spawn_detached() {
  local cwd="$1"
  local cmd="$2"
  local log="$3"
  local pid_file="$4"

  node -e '
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const [, cwd, cmd, logPath, pidPath] = process.argv;
    const out = fs.openSync(logPath, "a");
    const child = spawn("sh", ["-c", "exec " + cmd], {
      cwd,
      detached: true,
      stdio: ["ignore", out, out],
    });
    fs.writeFileSync(pidPath, String(child.pid));
    child.unref();
  ' "$cwd" "$cmd" "$log" "$pid_file"
}

start_one() {
  local svc="$1"
  local port; port="$(port_of "$svc")"
  local rec_pid=""

  if rec_pid="$(recorded_pid "$svc")"; then
    echo "  已在运行  cairn-$svc (pid $rec_pid, port $port)"
    return
  fi

  local port_pids; port_pids="$(pids_on_port "$port")"
  if [[ -n "$port_pids" ]]; then
    local pids_flat; pids_flat="$(echo $port_pids | tr '\n' ' ')"
    echo "  ✗ 端口 $port 已被占用 (pid $pids_flat)，无法启动 cairn-$svc" >&2
    echo "    可先运行 ./scripts/stack.sh clean $svc 强制释放" >&2
    return 1
  fi

  case "$svc" in
    api)
      if [[ ! -f "$ROOT/packages/api/dist/main.js" ]]; then
        echo "  ✗ cairn-api 未构建，请先执行 pnpm --filter @cairn/api build (或 pnpm build)" >&2
        return 1
      fi
      spawn_detached "$ROOT/packages/api" "node dist/main.js" "$(log_file "$svc")" "$(pid_file "$svc")"
      ;;
    worker)
      if [[ ! -f "$ROOT/packages/worker/dist/main.js" ]]; then
        echo "  ✗ cairn-worker 未构建，请先执行 pnpm --filter @cairn/worker build (或 pnpm build)" >&2
        return 1
      fi
      spawn_detached "$ROOT/packages/worker" "node dist/main.js" "$(log_file "$svc")" "$(pid_file "$svc")"
      ;;
    web)
      if [[ ! -f "$ROOT/packages/web/dist/index.html" ]]; then
        echo "  ✗ cairn-web 未构建，请先执行 pnpm --filter @cairn/web build (或 pnpm build)" >&2
        return 1
      fi
      spawn_detached "$ROOT/packages/web" "pnpm preview --port $port --strictPort" "$(log_file "$svc")" "$(pid_file "$svc")"
      ;;
    *)
      echo "  ✗ 未知服务: $svc" >&2
      return 1
      ;;
  esac

  local pid
  pid="$(cat "$(pid_file "$svc")")"

  # 稍等 0.5s 确认启动未立即失败
  sleep 0.5
  if kill -0 "$pid" 2>/dev/null; then
    echo "  ✅ 已启动  cairn-$svc (pid $pid, port $port)  日志 logs/$svc.log"
  else
    echo "  ✗ cairn-$svc 启动后立即退出，请检查日志: tail -n 30 logs/$svc.log" >&2
    rm -f "$(pid_file "$svc")"
    return 1
  fi
}

stop_one() {
  local svc="$1"
  local pid_path; pid_path="$(pid_file "$svc")"
  local port; port="$(port_of "$svc")"
  local rec_pid=""
  local stopped_something=false

  if rec_pid="$(recorded_pid "$svc")"; then
    echo "  正在停止  cairn-$svc (pid $rec_pid)..."
    kill -TERM "$rec_pid" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$rec_pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$rec_pid" 2>/dev/null; then
      echo "  ⚠ cairn-$svc (pid $rec_pid) 未在 5s 内退出，强制终止"
      kill -KILL "$rec_pid" 2>/dev/null || true
    fi
    stopped_something=true
  fi
  rm -f "$pid_path"

  # 清理端口上残留的孤儿进程或子进程
  local port_pids; port_pids="$(pids_on_port "$port")"
  if [[ -n "$port_pids" ]]; then
    for p in $port_pids; do
      echo "  ⚠ 清理端口 $port 上的残留孤儿进程 (pid $p)..."
      kill -TERM "$p" 2>/dev/null || true
      sleep 0.2
      if kill -0 "$p" 2>/dev/null; then
        kill -KILL "$p" 2>/dev/null || true
      fi
    done
    stopped_something=true
  fi

  if $stopped_something; then
    echo "  ✅ 已停止  cairn-$svc"
  else
    echo "  未运行    cairn-$svc"
  fi
}

status_one() {
  local svc="$1"
  local port; port="$(port_of "$svc")"
  local port_desc=""
  [[ -n "$port" ]] && port_desc="(port $port)"
  local rec_pid=""

  if rec_pid="$(recorded_pid "$svc")"; then
    printf "  %-14s running        pid %-7s %s\n" "cairn-$svc" "$rec_pid" "$port_desc"
  else
    local port_pids; port_pids="$(pids_on_port "$port")"
    if [[ -n "$port_pids" ]]; then
      local pids_flat; pids_flat="$(echo $port_pids | tr '\n' ' ')"
      printf "  %-14s ⚠ 端口异常占用 pid %-7s %s (PID文件缺失/孤儿进程)\n" "cairn-$svc" "$pids_flat" "$port_desc"
    else
      printf "  %-14s stopped        %s\n" "cairn-$svc" "$port_desc"
    fi
  fi
}

clean_one() {
  local svc="$1"
  local pid_path; pid_path="$(pid_file "$svc")"
  local port; port="$(port_of "$svc")"

  rm -f "$pid_path"

  local port_pids; port_pids="$(pids_on_port "$port")"
  if [[ -n "$port_pids" ]]; then
    for p in $port_pids; do
      kill -9 "$p" 2>/dev/null || true
    done
    local pids_flat; pids_flat="$(echo $port_pids | tr '\n' ' ')"
    echo "  ✅ 已强制释放 cairn-$svc 端口 $port (已终止 pid: $pids_flat)"
  else
    echo "  端口 $port 干净，无占用 (cairn-$svc)"
  fi
}

extra_clean_ports() {
  for port in 5174 5175; do
    local pids; pids="$(pids_on_port "$port")"
    if [[ -n "$pids" ]]; then
      for p in $pids; do
        kill -9 "$p" 2>/dev/null || true
      done
      local pids_flat; pids_flat="$(echo $pids | tr '\n' ' ')"
      echo "  ✅ 已强制释放备用端口 $port (已终止 pid: $pids_flat)"
    fi
  done
}

status_cmd() {
  local target="${1:-all}"
  for s in $(resolve_services "$target"); do
    status_one "$s"
  done

  echo ""
  local api_port; api_port="$(port_of api)"
  local web_port; web_port="$(port_of web)"

  printf "  %-14s " "api /health"
  local health; health="$(curl -fsS --max-time 2 "http://127.0.0.1:${api_port}/health" 2>/dev/null || echo "不可达")"
  echo "$health"

  printf "  %-14s " "web (HTTP)"
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${web_port}" 2>/dev/null; then
    echo "正常 (http://127.0.0.1:${web_port})"
  else
    echo "不可达"
  fi
}

logs_cmd() {
  local arg1="${1:-}"
  local arg2="${2:-}"
  local target="all"
  local lines="50"

  if [[ -n "$arg1" ]]; then
    if [[ "$arg1" =~ ^[0-9]+$ ]]; then
      lines="$arg1"
    else
      target="$arg1"
      if [[ -n "$arg2" && "$arg2" =~ ^[0-9]+$ ]]; then
        lines="$arg2"
      fi
    fi
  fi

  local services; services="$(resolve_services "$target")"
  local log_files=()
  for s in $services; do
    local f; f="$(log_file "$s")"
    [[ -f "$f" ]] && log_files+=("$f")
  done

  if [[ ${#log_files[@]} -eq 0 ]]; then
    echo "未找到匹配的日志文件 (logs/*.log)"
    return 0
  fi

  tail -n "$lines" -f "${log_files[@]}"
}

cmd="${1:-}"
target="${2:-all}"

case "$cmd" in
  start)
    for s in $(resolve_services "$target"); do start_one "$s"; done
    ;;
  stop)
    for s in $(resolve_services "$target"); do stop_one "$s"; done
    ;;
  restart)
    for s in $(resolve_services "$target"); do stop_one "$s"; done
    for s in $(resolve_services "$target"); do start_one "$s"; done
    ;;
  status)
    status_cmd "$target"
    ;;
  clean)
    for s in $(resolve_services "$target"); do clean_one "$s"; done
    if [[ "$target" == "all" || "$target" == "web" ]]; then
      extra_clean_ports
    fi
    ;;
  logs)
    shift
    logs_cmd "$@"
    ;;
  *)
    cat <<EOF
用法: $0 {start|stop|restart|status|clean|logs} [服务目标]

服务目标 (可选):
  all        所有服务 (api, worker, web) [默认]
  backend    后端服务 (api, worker)
  api        仅控制面 API
  worker     仅执行面 Worker
  web        仅前端 Web (Preview 产物)

常用示例:
  $0 start              # 启动全部构建好的服务
  $0 start backend      # 仅启动后端 (api + worker)
  $0 stop worker        # 仅停止 worker
  $0 status             # 查看服务状态（含 PID 及端口占用检查）
  $0 clean              # 强制清理并释放所有端口残留
  $0 logs api 100       # 查看 api 最近 100 行日志并跟踪 (logs/api.log)
EOF
    exit 1
    ;;
esac
