#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
REQUIRED_SERVICES=(redis worker-api worker-runner nginx certbot)
DOCKER_CMD=()
COMPOSE_CMD=()

log() {
  printf '%s\n' "$*"
}

fail() {
  printf '诊断失败: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf '诊断警告: %s\n' "$*" >&2
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少命令: $1"
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
  fail "无法访问 docker daemon（请加入 docker 组或使用 sudo）"
}

resolve_compose_cmd() {
  if "${DOCKER_CMD[@]}" compose version >/dev/null 2>&1; then
    COMPOSE_CMD=("${DOCKER_CMD[@]}" compose)
    return
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    if docker-compose version >/dev/null 2>&1; then
      COMPOSE_CMD=(docker-compose)
      return
    fi
    if sudo -n docker-compose version >/dev/null 2>&1; then
      COMPOSE_CMD=(sudo docker-compose)
      return
    fi
  fi
  fail "未检测到 docker compose"
}

read_env_value() {
  local key="$1"
  grep -E "^${key}=" "${ENV_FILE}" | tail -n 1 | cut -d'=' -f2- || true
}

check_services_running() {
  local running
  running="$("${COMPOSE_CMD[@]}" --env-file "${ENV_FILE}" ps --services --status running)"
  for svc in "${REQUIRED_SERVICES[@]}"; do
    if ! grep -qx "${svc}" <<<"${running}"; then
      fail "服务未运行: ${svc}"
    fi
  done
  log "服务状态检查通过"
}

check_healthz() {
  "${COMPOSE_CMD[@]}" --env-file "${ENV_FILE}" exec -T worker-api node -e '
    const run = async () => {
      const res = await fetch("http://127.0.0.1:8080/healthz");
      if (!res.ok) {
        throw new Error(`healthz status=${res.status}`);
      }
      const data = await res.json();
      if (!data || data.ok !== true) {
        throw new Error("healthz payload invalid");
      }
    };
    run().catch((e) => { console.error(e.message); process.exit(1); });
  ' >/dev/null
  log "API /healthz 检查通过"
}

check_auth_and_rules() {
  local syl_keys syl_key
  syl_keys="$(read_env_value "SYL_LISTING_KEYS")"
  [[ -n "${syl_keys}" ]] || fail ".env 缺少 SYL_LISTING_KEYS"
  syl_key="$(printf '%s' "${syl_keys}" | cut -d',' -f1 | cut -d':' -f2-)"
  [[ -n "${syl_key}" ]] || fail "SYL_LISTING_KEYS 格式错误"

  "${COMPOSE_CMD[@]}" --env-file "${ENV_FILE}" exec -T worker-api node -e "
    const run = async () => {
      const exchange = await fetch('http://127.0.0.1:8080/v1/auth/exchange', {
        method: 'POST',
        headers: { Authorization: 'Bearer ${syl_key}' }
      });
      if (!exchange.ok) {
        throw new Error('auth exchange failed: ' + exchange.status);
      }
      const j = await exchange.json();
      const token = j.access_token;
      if (!token) {
        throw new Error('missing access_token');
      }
      const rules = await fetch('http://127.0.0.1:8080/v1/rules/resolve?current=', {
        headers: { Authorization: 'Bearer ' + token }
      });
      if (!rules.ok) {
        throw new Error('rules resolve failed: ' + rules.status);
      }
      const r = await rules.json();
      if (!r.rules_version) {
        throw new Error('rules_version missing');
      }
    };
    run().catch((e) => { console.error(e.message); process.exit(1); });
  " >/dev/null
  log "鉴权与规则接口检查通过"
}

check_redis() {
  local pong
  pong="$("${COMPOSE_CMD[@]}" --env-file "${ENV_FILE}" exec -T redis redis-cli ping | tr -d '\r')"
  [[ "${pong}" == "PONG" ]] || fail "Redis PING 失败"
  log "Redis 检查通过"
}

check_nginx() {
  "${COMPOSE_CMD[@]}" --env-file "${ENV_FILE}" exec -T nginx nginx -t >/dev/null
  log "Nginx 配置检查通过"
}

check_certificate_files() {
  local domain
  domain="$(read_env_value "DOMAIN")"
  [[ -n "${domain}" ]] || fail ".env 缺少 DOMAIN"
  if "${COMPOSE_CMD[@]}" --env-file "${ENV_FILE}" exec -T nginx sh -c \
    "test -s /etc/letsencrypt/live/${domain}/fullchain.pem && test -s /etc/letsencrypt/live/${domain}/privkey.pem" >/dev/null 2>&1; then
    log "证书文件检查通过"
  else
    warn "证书文件暂未就绪: /etc/letsencrypt/live/${domain}/fullchain.pem"
  fi
}

main() {
  need_cmd docker
  resolve_docker_cmd
  resolve_compose_cmd
  [[ -f "${ENV_FILE}" ]] || fail "未找到 ${ENV_FILE}"

  cd "${ROOT_DIR}"
  check_services_running
  check_healthz
  check_auth_and_rules
  check_redis
  check_nginx
  check_certificate_files
  log "诊断完成: worker 运行正常"
}

main "$@"
