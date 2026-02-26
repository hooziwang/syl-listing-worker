#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
ENV_EXAMPLE_FILE="${ROOT_DIR}/.env.example"
SKIP_BUILD=0
STOP_LEGACY=0
INSTALL_DOCKER=0

log() {
  printf '%s\n' "$*"
}

die() {
  printf '错误: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
用法:
  bash scripts/deploy.sh [选项]

选项:
  --skip-build       跳过镜像构建（等同 docker compose up -d）
  --stop-legacy      停止并禁用旧 systemd 服务（api/runner/nginx）
  --install-docker   缺少 docker 时尝试自动安装（Ubuntu）
  -h, --help         显示帮助
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --skip-build)
        SKIP_BUILD=1
        ;;
      --stop-legacy)
        STOP_LEGACY=1
        ;;
      --install-docker)
        INSTALL_DOCKER=1
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "未知参数: $1"
        ;;
    esac
    shift
  done
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1; then
    return
  fi

  if [[ "${INSTALL_DOCKER}" -ne 1 ]]; then
    die "未检测到 docker。可先手动安装，或加 --install-docker"
  fi

  if ! command -v apt-get >/dev/null 2>&1; then
    die "自动安装仅支持 apt-get 环境，请手动安装 docker"
  fi

  log "未检测到 docker，开始安装..."
  sudo apt-get update -y
  sudo apt-get install -y docker.io docker-compose-v2
  sudo systemctl enable --now docker
}

resolve_compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(docker compose)
    return
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD=(docker-compose)
    return
  fi

  die "未检测到 docker compose，可安装 docker-compose-v2"
}

ensure_env_file() {
  if [[ -f "${ENV_FILE}" ]]; then
    return
  fi

  if [[ ! -f "${ENV_EXAMPLE_FILE}" ]]; then
    die "缺少 ${ENV_FILE} 且不存在 ${ENV_EXAMPLE_FILE}"
  fi

  cp "${ENV_EXAMPLE_FILE}" "${ENV_FILE}"
  die "已生成 ${ENV_FILE}，请先补全配置后重试"
}

required_env() {
  local key="$1"
  local value
  value="$(grep -E "^${key}=" "${ENV_FILE}" | tail -n 1 | cut -d'=' -f2- || true)"
  if [[ -z "${value}" ]]; then
    die "${ENV_FILE} 缺少必填项: ${key}"
  fi
}

validate_env() {
  required_env "DOMAIN"
  required_env "SYL_LISTING_KEYS"
  required_env "JWT_SECRET"
  required_env "ADMIN_TOKEN"
  required_env "FLUXCODE_API_KEY"
  required_env "DEEPSEEK_API_KEY"
}

prepare_dirs() {
  mkdir -p \
    "${ROOT_DIR}/data/rules" \
    "${ROOT_DIR}/data/redis" \
    "${ROOT_DIR}/data/letsencrypt" \
    "${ROOT_DIR}/data/certbot-webroot"
}

stop_legacy_services() {
  if [[ "${STOP_LEGACY}" -ne 1 ]]; then
    return
  fi

  if ! command -v systemctl >/dev/null 2>&1; then
    log "未检测到 systemctl，跳过旧服务停用"
    return
  fi

  log "停止旧 systemd 服务..."
  sudo systemctl stop syl-listing-worker-api.service syl-listing-worker-runner.service nginx || true
  sudo systemctl disable syl-listing-worker-api.service syl-listing-worker-runner.service nginx || true
}

deploy() {
  cd "${ROOT_DIR}"
  if [[ "${SKIP_BUILD}" -eq 1 ]]; then
    "${COMPOSE_CMD[@]}" --env-file "${ENV_FILE}" up -d
  else
    "${COMPOSE_CMD[@]}" --env-file "${ENV_FILE}" up -d --build
  fi
}

main() {
  parse_args "$@"
  ensure_docker
  resolve_compose_cmd
  ensure_env_file
  validate_env
  prepare_dirs
  stop_legacy_services

  log "开始部署..."
  deploy
  "${COMPOSE_CMD[@]}" --env-file "${ENV_FILE}" ps
  log "部署完成"
}

main "$@"
