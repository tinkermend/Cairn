#!/usr/bin/env bash
# 本地基础设施容器组件（PostgreSQL、Redis、MinIO）的启停与管理。
# 用于一键启动、停止、重启与健康探活容器组件。
# 数据目录保存在 .data/，停止与重启操作不会清除数据。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/deploy/compose.yml"

get_env_val() {
  local key="$1" default="$2"
  if [[ -n "${!key:-}" ]]; then
    echo "${!key}"
    return
  fi
  for env_f in "$ROOT/deploy/.env" "$ROOT/.env"; do
    if [[ -f "$env_f" ]]; then
      local val
      val="$(grep -E "^${key}=" "$env_f" 2>/dev/null | cut -d '=' -f2- | sed -e 's/[[:space:]]*#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | tail -n 1 || true)"
      if [[ -n "$val" ]]; then
        echo "$val"
        return
      fi
    fi
  done
  echo "$default"
}

detect_compose() {
  if [[ -n "${COMPOSE_CMD:-}" ]]; then
    echo "$COMPOSE_CMD"
    return 0
  fi
  if command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
    echo "podman compose"
    return 0
  fi
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    echo "docker compose"
    return 0
  fi
  if command -v podman-compose >/dev/null 2>&1; then
    echo "podman-compose"
    return 0
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    echo "docker-compose"
    return 0
  fi
  return 1
}

detect_engine() {
  if command -v podman >/dev/null 2>&1; then
    echo "podman"
  elif command -v docker >/dev/null 2>&1; then
    echo "docker"
  else
    echo ""
  fi
}

run_compose() {
  local compose_cmd
  compose_cmd="$(detect_compose)" || {
    echo "  ✗ 未找到支持的容器编排工具 (podman compose, docker compose, podman-compose, docker-compose)" >&2
    exit 1
  }

  local env_args=()
  if [[ -f "$ROOT/deploy/.env" ]]; then
    env_args+=(--env-file "$ROOT/deploy/.env")
  elif [[ -f "$ROOT/.env" ]]; then
    env_args+=(--env-file "$ROOT/.env")
  fi

  $compose_cmd "${env_args[@]}" -f "$COMPOSE_FILE" "$@"
}

resolve_services() {
  local target="${1:-all}"
  case "$target" in
    all)
      echo "postgres minio redis"
      ;;
    postgres|pg|db|database)
      echo "postgres"
      ;;
    minio|s3|storage)
      echo "minio"
      ;;
    redis|cache)
      echo "redis"
      ;;
    *)
      echo "未知服务组件: $target (可选: all, postgres, redis, minio)" >&2
      exit 1
      ;;
  esac
}

compose_up_services() {
  local target="${1:-all}"
  case "$target" in
    all)
      echo "postgres minio minio-init redis"
      ;;
    postgres|pg|db|database)
      echo "postgres"
      ;;
    minio|s3|storage)
      echo "minio minio-init"
      ;;
    redis|cache)
      echo "redis"
      ;;
    *)
      echo "未知服务组件: $target" >&2
      exit 1
      ;;
  esac
}

port_of() {
  case "$1" in
    postgres) echo "$(get_env_val "CAIRN_DB_PORT" "5432")" ;;
    redis)    echo "$(get_env_val "CAIRN_REDIS_PORT" "6379")" ;;
    minio)    echo "$(get_env_val "CAIRN_S3_API_PORT" "9021")" ;;
    *)        echo "" ;;
  esac
}

container_name_of() {
  echo "cairn-$1"
}

container_state() {
  local container="$1"
  local engine; engine="$(detect_engine)"
  if [[ -z "$engine" ]]; then
    echo "unknown none"
    return
  fi

  local res
  res="$($engine inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || true)"
  if [[ -z "$res" ]]; then
    echo "not_found none"
  else
    echo "$res"
  fi
}

probe_tcp() {
  local port="$1"
  node -e '
    const net = require("node:net");
    const port = Number(process.argv[1]);
    const sock = net.createConnection({ host: "127.0.0.1", port });
    sock.setTimeout(1000);
    sock.once("connect", () => { sock.destroy(); process.exit(0); });
    sock.once("timeout", () => { sock.destroy(); process.exit(1); });
    sock.once("error", () => { sock.destroy(); process.exit(1); });
  ' "$port" 2>/dev/null
}

wait_for_ready() {
  local services="$1"
  local timeout="${2:-90}"
  echo "  ⏳ 等待容器服务就绪 (最长等待 ${timeout}s)..."

  local start_time; start_time="$(date +%s)"
  local last_log=0
  while true; do
    local all_ready=true
    local current_time; current_time="$(date +%s)"
    local elapsed=$((current_time - start_time))

    for s in $services; do
      local c_name; c_name="$(container_name_of "$s")"
      local raw_state; raw_state="$(container_state "$c_name")"
      local c_status c_health
      c_status="$(echo "$raw_state" | awk '{print $1}')"
      c_health="$(echo "$raw_state" | awk '{print $2}')"

      if [[ "$c_status" != "running" ]]; then
        all_ready=false
        break
      fi

      if [[ "$c_health" == "healthy" || "$c_health" == "none" ]]; then
        continue
      else
        all_ready=false
        break
      fi
    done

    if $all_ready; then
      echo "  ✅ 目标服务全部就绪 (耗时 ${elapsed}s)"
      return 0
    fi

    if [[ "$elapsed" -ge "$timeout" ]]; then
      echo "  ⚠ 部分容器未在 ${timeout}s 内进入健康状态，请执行 ./scripts/infra.sh status 或 ./scripts/infra.sh logs 查看详情" >&2
      return 1
    fi

    if [[ $((elapsed - last_log)) -ge 10 && $elapsed -gt 0 ]]; then
      last_log=$elapsed
      echo "  ... 容器仍在恢复或初始化中 (${elapsed}s / ${timeout}s)"
    fi

    sleep 1
  done
}

status_one() {
  local svc="$1"
  local c_name; c_name="$(container_name_of "$svc")"
  local raw_state; raw_state="$(container_state "$c_name")"
  local c_status c_health
  c_status="$(echo "$raw_state" | awk '{print $1}')"
  c_health="$(echo "$raw_state" | awk '{print $2}')"
  local port; port="$(port_of "$svc")"

  local port_desc=""
  case "$svc" in
    postgres)
      port_desc="127.0.0.1:${port}"
      ;;
    redis)
      port_desc="127.0.0.1:${port}"
      ;;
    minio)
      local console_port; console_port="$(get_env_val "CAIRN_S3_CONSOLE_PORT" "9022")"
      port_desc="127.0.0.1:${port} (api), 127.0.0.1:${console_port} (console)"
      ;;
  esac

  local status_str="stopped"
  local mark="✗"

  if [[ "$c_status" == "running" ]]; then
    if [[ "$c_health" == "healthy" ]]; then
      status_str="running (healthy)"
      mark="✅"
    elif [[ "$c_health" == "starting" ]]; then
      status_str="running (starting)"
      mark="⏳"
    elif [[ "$c_health" == "unhealthy" ]]; then
      status_str="running (unhealthy)"
      mark="⚠"
    else
      status_str="running"
      mark="✅"
    fi
  elif [[ "$c_status" == "not_found" ]]; then
    status_str="not created"
    mark="-"
  elif [[ -n "$c_status" && "$c_status" != "none" ]]; then
    status_str="stopped ($c_status)"
    mark="✗"
  fi

  printf "  %-3s %-16s %-20s %s\n" "$mark" "$c_name" "$status_str" "$port_desc"
}

start_cmd() {
  local target="${1:-all}"
  local up_svcs; up_svcs="$(compose_up_services "$target")"
  local check_svcs; check_svcs="$(resolve_services "$target")"

  echo "正在启动容器组件: $target ($up_svcs)..."
  run_compose up -d $up_svcs
  echo ""
  wait_for_ready "$check_svcs" 90 || true
  echo ""
  echo "当前组件状态:"
  for s in $check_svcs; do
    status_one "$s"
  done
}

stop_cmd() {
  local target="${1:-all}"
  local svcs; svcs="$(resolve_services "$target")"

  echo "正在停止容器组件: $target ($svcs)..."
  if [[ "$target" == "all" ]]; then
    run_compose stop
  else
    if [[ "$target" == "minio" || "$target" == "s3" || "$target" == "storage" ]]; then
      run_compose stop minio minio-init
    else
      run_compose stop $svcs
    fi
  fi

  echo "✅ 已停止目标容器"
  echo ""
  echo "当前组件状态:"
  for s in $svcs; do
    status_one "$s"
  done
}

down_cmd() {
  echo "正在停止并移除所有容器及网络 (保留 .data 数据卷)..."
  run_compose down
  echo "✅ 已完成 down"
}

restart_cmd() {
  local target="${1:-all}"
  echo "正在重启容器组件: $target..."
  stop_cmd "$target"
  echo ""
  start_cmd "$target"
}

status_cmd() {
  local target="${1:-all}"
  local svcs; svcs="$(resolve_services "$target")"

  local engine; engine="$(detect_engine)"
  local compose_tool; compose_tool="$(detect_compose || echo 'none')"
  echo "引擎: ${engine:-未检测到} | 编排工具: ${compose_tool}"
  echo "------------------------------------------------------------"
  for s in $svcs; do
    status_one "$s"
  done
}

logs_cmd() {
  local follow=true
  local target="all"
  local lines="50"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-follow|-n)
        follow=false
        shift
        ;;
      [0-9]*)
        lines="$1"
        shift
        ;;
      all|postgres|pg|db|database|redis|cache|minio|s3|storage)
        target="$1"
        shift
        ;;
      *)
        shift
        ;;
    esac
  done

  local compose_args=()
  if $follow; then
    compose_args+=(-f)
  fi
  compose_args+=(--tail="$lines")

  if [[ "$target" == "all" ]]; then
    run_compose logs "${compose_args[@]}"
  else
    local svcs
    svcs="$(resolve_services "$target")"
    run_compose logs "${compose_args[@]}" $svcs
  fi
}

cmd="${1:-}"
target="${2:-all}"

case "$cmd" in
  start|up)
    start_cmd "$target"
    ;;
  stop)
    stop_cmd "$target"
    ;;
  down)
    down_cmd
    ;;
  restart)
    restart_cmd "$target"
    ;;
  status|ps)
    status_cmd "$target"
    ;;
  logs)
    shift
    logs_cmd "$@"
    ;;
  *)
    cat <<EOF
用法: $0 {start|stop|restart|status|down|logs} [服务组件]

服务组件 (可选):
  all        所有基础设施组件 (postgres, minio, redis) [默认]
  postgres   仅 PostgreSQL 数据库 (别名: pg, db, database)
  redis      仅 Redis 缓存与变化提示 (别名: cache)
  minio      仅 MinIO 对象存储 (别名: s3, storage)

常用示例:
  $0 start              # 启动所有数据库、Redis 和对象存储容器并等待健康就绪
  $0 stop               # 停止所有基础设施容器（保留数据）
  $0 restart            # 重启所有基础设施容器并等待健康就绪
  $0 status             # 查看所有组件容器运行状态与健康检查
  $0 start redis        # 仅启动 Redis 容器
  $0 stop postgres      # 仅停止 PostgreSQL 容器
  $0 restart minio      # 仅重启 MinIO 容器
  $0 logs redis 100     # 查看 Redis 最近 100 行日志并跟踪
  $0 down               # 停止并移除容器和网络（数据目录仍保留）
EOF
    exit 1
    ;;
esac
