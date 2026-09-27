#!/usr/bin/env bash
# 供 dev.sh / stack.sh 使用的本机分角色 Worker 进程管理。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/.run"
LOGS_DIR="$ROOT/logs"
mkdir -p "$RUN_DIR" "$LOGS_DIR"

mode="${1:-}"
cmd="${2:-}"
target="${3:-worker-roles}"
[[ "$mode" == dev || "$mode" == stable ]] || { echo "模式须为 dev 或 stable" >&2; exit 2; }

roles=(executor scheduler analyst maintenance)
pid_file() { echo "$RUN_DIR/worker-$1.pid"; }
mode_file() { echo "$RUN_DIR/worker-$1.mode"; }
log_file() { echo "$LOGS_DIR/worker-$1.log"; }

running_pid() {
  local path="$1" pid
  [[ -f "$path" ]] || return 1
  pid="$(cat "$path" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid"
}

role_config() {
  local role="$1" config
  config="$(node "$ROOT/tools/worker-role-config.mjs" "$role")" || return 1
  IFS=$'\t' read -r role_id role_port role_url <<< "$config"
  if [[ "$role_url" == '-' ]]; then role_url=''; fi
}

port_pids() {
  lsof -iTCP:"$1" -sTCP:LISTEN -P -n -t 2>/dev/null | sort -u || true
}

spawn_detached() {
  local kind="$1" role="${2:-}" id="${3:-}" port="${4:-}" url="${5:-}"
  local name="worker-$role"
  [[ "$kind" == watch ]] && name='worker-role-watch'
  node -e '
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const [root, name, kind, role, id, port, url, mode] = process.argv.slice(1);
    const out = fs.openSync(`${root}/logs/${name}.log`, "a");
    const cwd = `${root}/packages/worker`;
    const child = kind === "watch"
      ? spawn("pnpm", ["exec", "tsc", "-w", "--preserveWatchOutput", "-p", "tsconfig.build.json"], {
          cwd, detached: true, stdio: ["ignore", out, out],
        })
      : spawn(process.execPath,
          mode === "dev" ? ["--watch", "--watch-preserve-output", "dist/main.js"] : ["dist/main.js"],
          {
            cwd, detached: true, stdio: ["ignore", out, out],
            env: {
              ...process.env,
              CAIRN_WORKER_ID: id,
              CAIRN_WORKER_ROLES: role,
              CAIRN_WORKER_INTERNAL_PORT: port,
              CAIRN_WORKER_ADVERTISE_URL: url,
            },
          });
    fs.writeFileSync(`${root}/.run/${name}.pid`, String(child.pid));
    child.unref();
  ' "$ROOT" "$name" "$kind" "$role" "$id" "$port" "$url" "$mode"
  echo "$mode" > "$RUN_DIR/$name.mode"
}

stop_pid() {
  local name="$1" pid
  if pid="$(running_pid "$RUN_DIR/$name.pid")"; then
    echo "  正在停止 cairn-$name (pid $pid)..."
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$RUN_DIR/$name.pid" "$RUN_DIR/$name.mode"
}

any_role_running() {
  local role
  for role in "${roles[@]}"; do
    if running_pid "$(pid_file "$role")" >/dev/null; then return 0; fi
  done
  return 1
}

ensure_watch() {
  [[ "$mode" == dev ]] || return 0
  local pid
  if pid="$(running_pid "$RUN_DIR/worker-role-watch.pid")"; then
    return 0
  fi
  echo "  构建 Worker 产物，随后启动共享 TypeScript watch..."
  (cd "$ROOT" && pnpm --filter @cairn/worker build)
  spawn_detached watch
  sleep 0.5
  pid="$(running_pid "$RUN_DIR/worker-role-watch.pid")" || {
    echo "  ✗ Worker watch 启动失败；见 logs/worker-role-watch.log" >&2
    return 1
  }
}

stop_watch_if_idle() {
  if ! any_role_running; then stop_pid worker-role-watch; fi
}

start_role() {
  local role="$1" name="worker-$1" pid busy existing_mode
  role_config "$role" || return 1
  if pid="$(running_pid "$RUN_DIR/worker.pid")"; then
    echo "  ✗ 单 Worker 仍在运行 (pid $pid)；先停止它再启动分角色进程" >&2
    return 1
  fi
  if pid="$(running_pid "$(pid_file "$role")")"; then
    existing_mode="$(cat "$(mode_file "$role")" 2>/dev/null || true)"
    if [[ "$existing_mode" != "$mode" ]]; then
      echo "  ✗ cairn-$name 已以 $existing_mode 模式运行；请先停止" >&2
      return 1
    fi
    echo "  已在运行 cairn-$name (pid $pid, id $role_id, port $role_port, mode $mode)"
    return 0
  fi
  if [[ "$mode" == stable ]] && pid="$(running_pid "$RUN_DIR/worker-role-watch.pid")"; then
    echo "  ✗ 开发模式的 Worker watch 仍在运行 (pid $pid)；先停止 dev 角色模式" >&2
    return 1
  fi
  busy="$(port_pids "$role_port")"
  if [[ -n "$busy" ]]; then
    echo "  ✗ 端口 $role_port 已被占用 (pid ${busy//$'\n'/,})，无法启动 cairn-$name" >&2
    return 1
  fi
  if [[ "$mode" == dev ]]; then
    ensure_watch || return 1
  elif [[ ! -f "$ROOT/packages/worker/dist/main.js" ]]; then
    echo "  ✗ Worker 尚未构建；请先运行 pnpm --filter @cairn/worker build" >&2
    return 1
  fi
  spawn_detached role "$role" "$role_id" "$role_port" "$role_url"
  sleep 0.5
  pid="$(running_pid "$(pid_file "$role")")" || {
    echo "  ✗ cairn-$name 启动后立即退出；见 logs/$name.log" >&2
    rm -f "$(pid_file "$role")" "$(mode_file "$role")"
    stop_watch_if_idle
    return 1
  }
  echo "  ✅ 已启动 cairn-$name (pid $pid, id $role_id, port $role_port, mode $mode)"
}

stop_role() {
  local role="$1" name="worker-$1"
  stop_pid "$name"
  stop_watch_if_idle
}

status_role() {
  local role="$1" name="worker-$1" pid busy current_mode
  role_config "$role" || return 1
  if pid="$(running_pid "$(pid_file "$role")")"; then
    current_mode="$(cat "$(mode_file "$role")" 2>/dev/null || true)"
    printf '  %-24s running [%s] pid %-7s id %s port %s\n' "cairn-$name" "$current_mode" "$pid" "$role_id" "$role_port"
  else
    busy="$(port_pids "$role_port")"
    if [[ -n "$busy" ]]; then
      printf '  %-24s ⚠ 端口 %s 被占用 (pid %s)\n' "cairn-$name" "$role_port" "${busy//$'\n'/,}"
    else
      printf '  %-24s stopped   id %s port %s\n' "cairn-$name" "$role_id" "$role_port"
    fi
  fi
}

clean_role() {
  local role="$1" pid
  role_config "$role" || return 1
  stop_role "$role"
  for pid in $(port_pids "$role_port"); do
    echo "  强制释放端口 $role_port (pid $pid)"
    kill -KILL "$pid" 2>/dev/null || true
  done
}

selected_roles=()
case "$target" in
  worker-roles) selected_roles=("${roles[@]}") ;;
  worker-executor|worker-scheduler|worker-analyst|worker-maintenance)
    selected_roles=("${target#worker-}") ;;
  *) echo "未知分角色目标: $target" >&2; exit 2 ;;
esac

case "$cmd" in
  start)
    # 在启动首个角色前核对四个角色的唯一 ID、端口和广告入口。
    role_config executor
    for role in "${selected_roles[@]}"; do start_role "$role"; done
    ;;
  stop)
    for role in "${selected_roles[@]}"; do stop_role "$role"; done
    ;;
  restart)
    for role in "${selected_roles[@]}"; do stop_role "$role"; done
    for role in "${selected_roles[@]}"; do start_role "$role"; done
    ;;
  status)
    for role in "${selected_roles[@]}"; do status_role "$role"; done
    ;;
  clean)
    for role in "${selected_roles[@]}"; do clean_role "$role"; done
    ;;
  logs)
    lines="${4:-50}"
    [[ "$lines" =~ ^[0-9]+$ ]] || { echo "日志行数须为整数" >&2; exit 2; }
    files=()
    for role in "${selected_roles[@]}"; do
      [[ -f "$(log_file "$role")" ]] && files+=("$(log_file "$role")")
    done
    [[ ${#files[@]} -gt 0 ]] || { echo "尚无角色日志"; exit 0; }
    tail -n "$lines" -f "${files[@]}"
    ;;
  *)
    echo "用法: $0 {dev|stable} {start|stop|restart|status|clean|logs} {worker-roles|worker-executor|worker-scheduler|worker-analyst|worker-maintenance} [日志行数]" >&2
    exit 2
    ;;
esac
