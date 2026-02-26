#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
CONFIG_FILE="${CONFIG_FILE:-${ROOT_DIR}/worker.config.json}"
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-${ROOT_DIR}/.compose.env}"
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
  [[ -n "${value}" ]] || fail "配置文件缺少必填项: ${key} (${CONFIG_FILE})"
  printf '%s' "${value}"
}

read_env_value() {
  local key="$1"
  grep -E "^${key}=" "${ENV_FILE}" | tail -n 1 | cut -d'=' -f2- || true
}

prepare_compose_env() {
  local domain email
  domain="$(read_config_required "server.domain")"
  email="$(read_config_value "server.letsencrypt_email")"

  mkdir -p "$(dirname "${COMPOSE_ENV_FILE}")"
  cat > "${COMPOSE_ENV_FILE}" <<COMPOSE_ENV
DOMAIN=${domain}
LETSENCRYPT_EMAIL=${email}
COMPOSE_ENV
}

check_services_running() {
  local running
  running="$(${COMPOSE_CMD[@]} --env-file "${COMPOSE_ENV_FILE}" ps --services --status running)"
  for svc in "${REQUIRED_SERVICES[@]}"; do
    if ! grep -qx "${svc}" <<<"${running}"; then
      fail "服务未运行: ${svc}"
    fi
  done
  log "服务状态检查通过"
}

check_healthz() {
  "${COMPOSE_CMD[@]}" --env-file "${COMPOSE_ENV_FILE}" exec -T worker-api node -e '
    const run = async () => {
      const res = await fetch("http://127.0.0.1:8080/healthz");
      const raw = await res.text();
      let data = null;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`healthz 非 JSON 响应: ${raw}`);
      }
      if (!res.ok) {
        throw new Error(`healthz status=${res.status} body=${raw}`);
      }
      const fluxOk = data?.llm?.fluxcode?.ok === true;
      const deepseekOk = data?.llm?.deepseek?.ok === true;
      if (!data || data.ok !== true || !fluxOk || !deepseekOk) {
        throw new Error(`healthz payload invalid: ${raw}`);
      }
    };
    run().catch((e) => { console.error(e.message); process.exit(1); });
  ' >/dev/null
  log "API /healthz 与 LLM Key 检查通过"
}

check_auth_and_rules() {
  local syl_keys syl_key
  syl_keys="$(read_env_value "SYL_LISTING_KEYS")"
  [[ -n "${syl_keys}" ]] || fail ".env 缺少 SYL_LISTING_KEYS"
  syl_key="$(printf '%s' "${syl_keys}" | cut -d',' -f1 | cut -d':' -f2-)"
  [[ -n "${syl_key}" ]] || fail "SYL_LISTING_KEYS 格式错误"

  "${COMPOSE_CMD[@]}" --env-file "${COMPOSE_ENV_FILE}" exec -T worker-api node -e "
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
  pong="$(${COMPOSE_CMD[@]} --env-file "${COMPOSE_ENV_FILE}" exec -T redis redis-cli ping | tr -d '\r')"
  [[ "${pong}" == "PONG" ]] || fail "Redis PING 失败"
  log "Redis 检查通过"
}

check_nginx() {
  "${COMPOSE_CMD[@]}" --env-file "${COMPOSE_ENV_FILE}" exec -T nginx nginx -t >/dev/null
  log "Nginx 配置检查通过"
}

check_certificate_files() {
  local domain
  domain="$(read_config_required "server.domain")"
  if "${COMPOSE_CMD[@]}" --env-file "${COMPOSE_ENV_FILE}" exec -T nginx sh -c \
    "test -s /etc/letsencrypt/live/${domain}/fullchain.pem && test -s /etc/letsencrypt/live/${domain}/privkey.pem" >/dev/null 2>&1; then
    log "证书文件检查通过"
  else
    warn "证书文件暂未就绪: /etc/letsencrypt/live/${domain}/fullchain.pem"
  fi
}

main() {
  need_cmd docker
  need_cmd python3
  resolve_docker_cmd
  resolve_compose_cmd
  [[ -f "${ENV_FILE}" ]] || fail "未找到 ${ENV_FILE}"
  [[ -f "${CONFIG_FILE}" ]] || fail "未找到 ${CONFIG_FILE}"
  prepare_compose_env

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
