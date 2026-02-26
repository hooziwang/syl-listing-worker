#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
ENV_EXAMPLE_FILE="${ROOT_DIR}/.env.example"
CONFIG_FILE="${CONFIG_FILE:-${ROOT_DIR}/worker.config.json}"
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-${ROOT_DIR}/.compose.env}"
SKIP_BUILD=0
STOP_LEGACY=0
INSTALL_DOCKER=0
SKIP_WAIT_HTTPS=0
HTTPS_TIMEOUT_SECONDS="${HTTPS_TIMEOUT_SECONDS:-240}"
HTTPS_INTERVAL_SECONDS="${HTTPS_INTERVAL_SECONDS:-2}"
REMOTE_HOST=""
REMOTE_USER="${REMOTE_USER:-ubuntu}"
REMOTE_PORT="${REMOTE_PORT:-22}"
REMOTE_DIR="${REMOTE_DIR:-/opt/syl-listing-worker}"
SKIP_DIAGNOSE=0
DOCKER_CMD=()
COMPOSE_CMD=()

log() {
  printf '%s\n' "$*"
}

die() {
  printf '错误: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
用法:
  bash scripts/deploy.sh [选项]

选项:
  --skip-build              跳过镜像构建（等同 docker compose up -d）
  --stop-legacy             停止并禁用旧 systemd 服务（api/runner/nginx）
  --install-docker          缺少 docker 时尝试自动安装（Ubuntu）
  --skip-wait-https         部署后不等待 HTTPS 就绪（默认等待）
  --https-timeout <sec>     等待 HTTPS 就绪超时秒数，默认 240
  --https-interval <sec>    等待 HTTPS 轮询间隔秒数，默认 2
  --config-file <path>      配置文件路径（默认 worker.config.json）
  --compose-env-file <path> compose 变量文件输出路径（默认 .compose.env）
  --remote-host <host>      远端主机（启用远程部署模式）
  --remote-user <user>      远端 SSH 用户，默认 ubuntu
  --remote-port <port>      远端 SSH 端口，默认 22
  --remote-dir <dir>        远端部署目录，默认 /opt/syl-listing-worker
  --skip-diagnose           远程部署完成后跳过诊断
  -h, --help                显示帮助
USAGE
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
      --skip-wait-https)
        SKIP_WAIT_HTTPS=1
        ;;
      --https-timeout)
        HTTPS_TIMEOUT_SECONDS="${2:-}"
        shift
        ;;
      --https-interval)
        HTTPS_INTERVAL_SECONDS="${2:-}"
        shift
        ;;
      --config-file)
        CONFIG_FILE="${2:-}"
        shift
        ;;
      --compose-env-file)
        COMPOSE_ENV_FILE="${2:-}"
        shift
        ;;
      --remote-host)
        REMOTE_HOST="${2:-}"
        shift
        ;;
      --remote-user)
        REMOTE_USER="${2:-}"
        shift
        ;;
      --remote-port)
        REMOTE_PORT="${2:-}"
        shift
        ;;
      --remote-dir)
        REMOTE_DIR="${2:-}"
        shift
        ;;
      --skip-diagnose)
        SKIP_DIAGNOSE=1
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

validate_positive_integer() {
  local key="$1"
  local value="$2"
  if [[ ! "${value}" =~ ^[1-9][0-9]*$ ]]; then
    die "${key} 必须是正整数"
  fi
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令: $1"
}

ssh_target() {
  printf '%s@%s' "${REMOTE_USER}" "${REMOTE_HOST}"
}

ssh_run() {
  ssh -p "${REMOTE_PORT}" -o ConnectTimeout=10 "$(ssh_target)" "$@"
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
  sudo apt-get install -y docker.io docker-compose-v2 python3
  sudo systemctl enable --now docker
}

resolve_docker_cmd() {
  if docker info >/dev/null 2>&1; then
    DOCKER_CMD=(docker)
    return
  fi
  if sudo -n docker info >/dev/null 2>&1; then
    DOCKER_CMD=(sudo docker)
    return
  fi
  die "无法访问 docker daemon（请加入 docker 组或确保 sudo 免密）"
}

resolve_compose_cmd() {
  if "${DOCKER_CMD[@]}" compose version >/dev/null 2>&1; then
    COMPOSE_CMD=("${DOCKER_CMD[@]}" compose)
    return
  fi

  if command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(docker-compose)
    return
  fi
  if command -v docker-compose >/dev/null 2>&1 && sudo -n docker-compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(sudo docker-compose)
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
  die "已生成 ${ENV_FILE}，请先补全敏感配置后重试"
}

ensure_config_file() {
  [[ -f "${CONFIG_FILE}" ]] || die "未找到配置文件: ${CONFIG_FILE}"
}

read_config_value() {
  local key="$1"
  python3 - "${CONFIG_FILE}" "${key}" <<'PY' 2>/dev/null || true
import json
import sys

path = sys.argv[1]
key = sys.argv[2]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)
value = data
for part in key.split("."):
    if not isinstance(value, dict) or part not in value:
        raise SystemExit(2)
    value = value[part]
if isinstance(value, bool):
    print("true" if value else "false", end="")
else:
    print(str(value), end="")
PY
}

read_config_required() {
  local key="$1"
  local value
  value="$(read_config_value "${key}")"
  if [[ -z "${value}" ]]; then
    die "配置文件缺少必填项: ${key} (${CONFIG_FILE})"
  fi
  printf '%s' "${value}"
}

read_config_optional() {
  local key="$1"
  read_config_value "${key}" || true
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
  required_env "SYL_LISTING_KEYS"
  required_env "JWT_SECRET"
  required_env "ADMIN_TOKEN"
  required_env "FLUXCODE_API_KEY"
  required_env "DEEPSEEK_API_KEY"
}

prepare_compose_env() {
  local domain email
  domain="$(read_config_required "server.domain")"
  email="$(read_config_optional "server.letsencrypt_email")"

  mkdir -p "$(dirname "${COMPOSE_ENV_FILE}")"
  cat > "${COMPOSE_ENV_FILE}" <<COMPOSE_ENV
DOMAIN=${domain}
LETSENCRYPT_EMAIL=${email}
COMPOSE_ENV
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
    "${COMPOSE_CMD[@]}" --env-file "${COMPOSE_ENV_FILE}" up -d
  else
    "${COMPOSE_CMD[@]}" --env-file "${COMPOSE_ENV_FILE}" up -d --build
  fi
}

wait_https_ready() {
  if [[ "${SKIP_WAIT_HTTPS}" -eq 1 ]]; then
    return
  fi

  local domain
  domain="$(read_config_required "server.domain")"

  local deadline now restarted
  deadline=$(( $(date +%s) + HTTPS_TIMEOUT_SECONDS ))
  restarted=0

  log "等待 HTTPS 就绪（domain=${domain}，timeout=${HTTPS_TIMEOUT_SECONDS}s）..."
  while true; do
    if "${COMPOSE_CMD[@]}" --env-file "${COMPOSE_ENV_FILE}" exec -T nginx sh -lc \
      "test -s /etc/letsencrypt/live/${domain}/fullchain.pem && \
       test -s /etc/letsencrypt/live/${domain}/privkey.pem && \
       [ \"\$(cat /var/run/nginx_tls_mode 2>/dev/null || true)\" = \"https\" ] && \
       grep -q 'listen 443' /etc/nginx/conf.d/default.conf" >/dev/null 2>&1; then
      log "HTTPS 已就绪"
      return
    fi

    if [[ "${restarted}" -eq 0 ]] && "${COMPOSE_CMD[@]}" --env-file "${COMPOSE_ENV_FILE}" exec -T nginx sh -lc \
      "test -s /etc/letsencrypt/live/${domain}/fullchain.pem && \
       test -s /etc/letsencrypt/live/${domain}/privkey.pem && \
       [ \"\$(cat /var/run/nginx_tls_mode 2>/dev/null || true)\" != \"https\" ]" >/dev/null 2>&1; then
      log "证书已签发，重启 nginx 以立即切换 HTTPS..."
      "${COMPOSE_CMD[@]}" --env-file "${COMPOSE_ENV_FILE}" restart nginx >/dev/null
      restarted=1
    fi

    now="$(date +%s)"
    if (( now >= deadline )); then
      die "等待 HTTPS 就绪超时（${HTTPS_TIMEOUT_SECONDS}s）"
    fi
    sleep "${HTTPS_INTERVAL_SECONDS}"
  done
}

run_local_deploy() {
  validate_positive_integer "https-timeout" "${HTTPS_TIMEOUT_SECONDS}"
  validate_positive_integer "https-interval" "${HTTPS_INTERVAL_SECONDS}"
  need_cmd python3
  ensure_docker
  resolve_docker_cmd
  resolve_compose_cmd
  ensure_env_file
  ensure_config_file
  validate_env
  prepare_compose_env
  prepare_dirs
  stop_legacy_services

  log "开始部署..."
  deploy
  wait_https_ready
  "${COMPOSE_CMD[@]}" --env-file "${COMPOSE_ENV_FILE}" ps
  log "部署完成"
}

refresh_host_key() {
  local known_hosts
  known_hosts="${HOME}/.ssh/known_hosts"
  mkdir -p "${HOME}/.ssh"
  chmod 700 "${HOME}/.ssh"
  touch "${known_hosts}"
  chmod 600 "${known_hosts}"

  ssh-keygen -R "[${REMOTE_HOST}]:${REMOTE_PORT}" >/dev/null 2>&1 || true
  if [[ "${REMOTE_PORT}" == "22" ]]; then
    ssh-keygen -R "${REMOTE_HOST}" >/dev/null 2>&1 || true
  fi
  ssh-keyscan -p "${REMOTE_PORT}" -H "${REMOTE_HOST}" >> "${known_hosts}" 2>/dev/null || die "无法拉取远端主机指纹: ${REMOTE_HOST}"
}

ensure_ssh_ready() {
  local out=""
  if out="$(ssh -p "${REMOTE_PORT}" -o BatchMode=yes -o ConnectTimeout=10 "$(ssh_target)" 'echo ok' 2>&1)"; then
    return
  fi

  if grep -q "REMOTE HOST IDENTIFICATION HAS CHANGED" <<<"${out}" || grep -q "Host key verification failed" <<<"${out}"; then
    log "检测到主机指纹异常，自动修复 known_hosts..."
    refresh_host_key
    ssh -p "${REMOTE_PORT}" -o BatchMode=yes -o ConnectTimeout=10 "$(ssh_target)" 'echo ok' >/dev/null 2>&1 || die "主机指纹修复后仍无法连接"
    return
  fi

  die "SSH 连接失败: ${out}"
}

sync_source_to_remote() {
  local q_dir
  q_dir="$(printf '%q' "${REMOTE_DIR}")"
  ssh_run "set -euo pipefail; \
    if mkdir -p ${q_dir} 2>/dev/null; then \
      :; \
    else \
      if command -v sudo >/dev/null 2>&1; then \
        sudo mkdir -p ${q_dir}; \
        sudo chown -R ${REMOTE_USER}:${REMOTE_USER} ${q_dir}; \
      else \
        echo '错误: 无法创建远端目录（权限不足且无 sudo）' >&2; exit 1; \
      fi; \
    fi; \
    find ${q_dir} -mindepth 1 -maxdepth 1 ! -name data ! -name .env -exec rm -rf {} +"

  COPYFILE_DISABLE=1 tar \
    --format=ustar \
    --no-mac-metadata \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='data' \
    --exclude='.env' \
    --exclude='.compose.env' \
    -C "${ROOT_DIR}" -czf - . \
    | ssh -p "${REMOTE_PORT}" -o ConnectTimeout=20 "$(ssh_target)" "tar -xzf - -C ${q_dir}"
}

upload_env_to_remote() {
  local tmp_env q_dir q_tmp
  tmp_env="/tmp/syl-listing-worker.env.$$"
  q_dir="$(printf '%q' "${REMOTE_DIR}")"
  q_tmp="$(printf '%q' "${tmp_env}")"

  scp -P "${REMOTE_PORT}" "${ENV_FILE}" "$(ssh_target):${tmp_env}"
  ssh_run "set -euo pipefail; \
    if cp ${q_tmp} ${q_dir}/.env 2>/dev/null; then \
      rm -f ${q_tmp}; \
    else \
      if command -v sudo >/dev/null 2>&1; then \
        sudo cp ${q_tmp} ${q_dir}/.env; \
        sudo chown ${REMOTE_USER}:${REMOTE_USER} ${q_dir}/.env; \
        rm -f ${q_tmp}; \
      else \
        echo '错误: 无法写入远端 .env（权限不足且无 sudo）' >&2; exit 1; \
      fi; \
    fi"
}

build_remote_deploy_opts() {
  local opts=()
  if [[ "${SKIP_BUILD}" -eq 1 ]]; then
    opts+=(--skip-build)
  fi
  if [[ "${STOP_LEGACY}" -eq 1 ]]; then
    opts+=(--stop-legacy)
  fi
  if [[ "${INSTALL_DOCKER}" -eq 1 ]]; then
    opts+=(--install-docker)
  fi
  if [[ "${SKIP_WAIT_HTTPS}" -eq 1 ]]; then
    opts+=(--skip-wait-https)
  fi
  opts+=(--https-timeout "${HTTPS_TIMEOUT_SECONDS}")
  opts+=(--https-interval "${HTTPS_INTERVAL_SECONDS}")
  if [[ "${#opts[@]}" -eq 0 ]]; then
    printf ''
    return
  fi
  printf ' %q' "${opts[@]}"
}

run_remote_deploy() {
  need_cmd ssh
  need_cmd scp
  need_cmd tar
  need_cmd ssh-keygen
  need_cmd ssh-keyscan
  need_cmd python3

  [[ -n "${REMOTE_HOST}" ]] || die "--remote-host 不能为空"
  ensure_env_file
  ensure_config_file
  validate_env
  ensure_ssh_ready

  local q_dir opts_str
  q_dir="$(printf '%q' "${REMOTE_DIR}")"
  opts_str="$(build_remote_deploy_opts)"

  log "开始远程部署: ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}"
  sync_source_to_remote
  upload_env_to_remote
  ssh_run "set -euo pipefail; cd ${q_dir}; bash scripts/deploy.sh${opts_str}"
  if [[ "${SKIP_DIAGNOSE}" -ne 1 ]]; then
    ssh_run "set -euo pipefail; cd ${q_dir}; bash scripts/diagnose.sh"
  fi
  log "远程部署完成"
}

main() {
  parse_args "$@"
  if [[ -n "${REMOTE_HOST}" ]]; then
    run_remote_deploy
  else
    run_local_deploy
  fi
}

main "$@"
