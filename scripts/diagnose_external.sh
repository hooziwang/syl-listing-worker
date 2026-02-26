#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-}"
SYL_KEY="${SYL_KEY:-${SYL_LISTING_KEY:-}}"
POLL_TIMEOUT_SECONDS="${POLL_TIMEOUT_SECONDS:-300}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-2}"
CURL_RESOLVE="${CURL_RESOLVE:-}"

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

usage() {
  cat <<'EOF'
用法:
  bash scripts/diagnose_external.sh --base-url <https://worker.example.com> --key <SYL_LISTING_KEY> [选项]

选项:
  --base-url <url>       对外服务地址（必填）
  --key <key>            SYL_LISTING_KEY（必填）
  --timeout <sec>        生成任务轮询超时时间，默认 300
  --interval <sec>       轮询间隔，默认 2
  --resolve <rule>       透传给 curl --resolve（可选），例: worker.aelus.tech:443:127.0.0.1
  -h, --help             显示帮助
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    local val
    case "$1" in
      --base-url)
        val="${2:-}"
        [[ -n "${val}" ]] && BASE_URL="${val}"
        shift
        ;;
      --key)
        val="${2:-}"
        [[ -n "${val}" ]] && SYL_KEY="${val}"
        shift
        ;;
      --timeout)
        val="${2:-}"
        [[ -n "${val}" ]] && POLL_TIMEOUT_SECONDS="${val}"
        shift
        ;;
      --interval)
        val="${2:-}"
        [[ -n "${val}" ]] && POLL_INTERVAL_SECONDS="${val}"
        shift
        ;;
      --resolve)
        val="${2:-}"
        [[ -n "${val}" ]] && CURL_RESOLVE="${val}"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        fail "未知参数: $1"
        ;;
    esac
    shift
  done
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少命令: $1"
}

json_get() {
  local input="$1"
  local key="$2"
  printf '%s' "$input" | python3 -c '
import json
import sys
key = sys.argv[1]
raw = sys.stdin.read().strip()
if not raw:
    print("")
    raise SystemExit(0)
try:
    data = json.loads(raw)
except Exception:
    print("")
    raise SystemExit(0)
value = data.get(key, "")
if isinstance(value, (dict, list)):
    print(json.dumps(value, ensure_ascii=False))
else:
    print(value)
' "$key"
}

api_call() {
  local method="$1"
  local path="$2"
  local auth="${3:-}"
  local data="${4:-}"

  local url="${BASE_URL}${path}"
  local -a args=(-sS -X "$method" "$url")
  if [[ -n "${CURL_RESOLVE}" ]]; then
    args+=(--resolve "${CURL_RESOLVE}")
  fi
  if [[ -n "$auth" ]]; then
    args+=(-H "Authorization: Bearer ${auth}")
  fi
  if [[ -n "$data" ]]; then
    args+=(-H "Content-Type: application/json")
    args+=(-d "$data")
  fi

  local resp
  resp="$(curl "${args[@]}" -w $'\n%{http_code}')" || fail "请求失败: ${method} ${path}"
  local status body
  status="$(printf '%s' "$resp" | tail -n1)"
  body="$(printf '%s' "$resp" | sed '$d')"
  printf '%s\n%s' "$status" "$body"
}

check_healthz() {
  local resp status body
  resp="$(api_call GET /healthz "" "")"
  status="$(printf '%s' "$resp" | sed -n '1p')"
  body="$(printf '%s' "$resp" | sed -n '2,$p')"
  [[ "$status" == "200" ]] || fail "/healthz 状态异常: ${status}"
  [[ "$(json_get "$body" ok)" == "True" || "$(json_get "$body" ok)" == "true" ]] || fail "/healthz 响应异常: ${body}"
  log "外部健康检查通过"
}

check_auth() {
  local resp status body token
  resp="$(api_call POST /v1/auth/exchange "$SYL_KEY" "")"
  status="$(printf '%s' "$resp" | sed -n '1p')"
  body="$(printf '%s' "$resp" | sed -n '2,$p')"
  [[ "$status" == "200" ]] || fail "/v1/auth/exchange 失败: ${status} ${body}"
  token="$(json_get "$body" access_token)"
  [[ -n "$token" ]] || fail "auth 缺少 access_token: ${body}"
  printf '%s' "$token"
}

check_rules_endpoints() {
  local token="$1"
  local resp status body rules_version download_url

  resp="$(api_call GET "/v1/rules/resolve?current=" "$token" "")"
  status="$(printf '%s' "$resp" | sed -n '1p')"
  body="$(printf '%s' "$resp" | sed -n '2,$p')"
  [[ "$status" == "200" ]] || fail "/v1/rules/resolve 失败: ${status} ${body}"
  rules_version="$(json_get "$body" rules_version)"
  download_url="$(json_get "$body" download_url)"
  [[ -n "$rules_version" ]] || fail "rules resolve 缺少 rules_version"
  [[ -n "$download_url" ]] || fail "rules resolve 缺少 download_url"

  resp="$(api_call POST "/v1/rules/refresh" "$token" "")"
  status="$(printf '%s' "$resp" | sed -n '1p')"
  body="$(printf '%s' "$resp" | sed -n '2,$p')"
  [[ "$status" == "200" ]] || fail "/v1/rules/refresh 失败: ${status} ${body}"

  local download_status tmp_file
  local -a dl_args=(-sS -H "Authorization: Bearer ${token}" "${download_url}")
  if [[ -n "${CURL_RESOLVE}" ]]; then
    dl_args+=(--resolve "${CURL_RESOLVE}")
  fi
  tmp_file="$(mktemp)"
  trap 'rm -f "$tmp_file"' RETURN
  download_status="$(curl "${dl_args[@]}" -o "${tmp_file}" -w "%{http_code}")" || fail "rules download 请求失败"
  [[ "$download_status" == "200" ]] || fail "rules download 失败: ${download_status}"
  [[ -s "${tmp_file}" ]] || fail "rules download 返回空文件"
  rm -f "${tmp_file}"
  trap - RETURN
  log "外部规则接口检查通过"
}

check_generate_pipeline() {
  local token="$1"
  local payload resp status body job_id
  payload="$(cat <<'JSON'
{"input_markdown":"===Listing Requirements===\n\n# 基础信息\n品牌名: DiagnoseBrand\n\n# 关键词库\nkeyword one\nkeyword two\nkeyword three\n\n# 分类\nHome & Kitchen > Decor\n","candidate_count":1}
JSON
)"

  resp="$(api_call POST "/v1/generate" "$token" "$payload")"
  status="$(printf '%s' "$resp" | sed -n '1p')"
  body="$(printf '%s' "$resp" | sed -n '2,$p')"
  [[ "$status" == "200" ]] || fail "/v1/generate 失败: ${status} ${body}"
  job_id="$(json_get "$body" job_id)"
  [[ -n "$job_id" ]] || fail "generate 缺少 job_id: ${body}"

  local deadline now st_resp st_status st_body job_status job_error
  deadline=$(( $(date +%s) + POLL_TIMEOUT_SECONDS ))
  while true; do
    now="$(date +%s)"
    (( now <= deadline )) || fail "轮询超时: ${job_id}"

    st_resp="$(api_call GET "/v1/jobs/${job_id}" "$token" "")"
    st_status="$(printf '%s' "$st_resp" | sed -n '1p')"
    st_body="$(printf '%s' "$st_resp" | sed -n '2,$p')"
    [[ "$st_status" == "200" ]] || fail "查询任务失败: ${st_status} ${st_body}"

    job_status="$(json_get "$st_body" status)"
    case "$job_status" in
      queued|running|"")
        sleep "$POLL_INTERVAL_SECONDS"
        ;;
      succeeded)
        local result_resp result_status result_body en cn
        result_resp="$(api_call GET "/v1/jobs/${job_id}/result" "$token" "")"
        result_status="$(printf '%s' "$result_resp" | sed -n '1p')"
        result_body="$(printf '%s' "$result_resp" | sed -n '2,$p')"
        [[ "$result_status" == "200" ]] || fail "读取结果失败: ${result_status} ${result_body}"
        en="$(json_get "$result_body" en_markdown)"
        cn="$(json_get "$result_body" cn_markdown)"
        [[ -n "$en" && -n "$cn" ]] || fail "result 缺少 en_markdown/cn_markdown"
        log "外部生成链路检查通过"
        return
        ;;
      failed)
        job_error="$(json_get "$st_body" error)"
        local failed_result_resp failed_result_status
        failed_result_resp="$(api_call GET "/v1/jobs/${job_id}/result" "$token" "")"
        failed_result_status="$(printf '%s' "$failed_result_resp" | sed -n '1p')"
        [[ "$failed_result_status" == "409" || "$failed_result_status" == "404" ]] || fail "失败任务 result 接口异常: ${failed_result_status}"
        warn "生成任务返回 failed（可能为模型内容校验失败），但生成链路接口可用: ${job_error}"
        log "外部生成链路检查通过（failed 状态可观测）"
        return
        ;;
      *)
        fail "未知任务状态: ${job_status}"
        ;;
    esac
  done
}

main() {
  parse_args "$@"
  need_cmd curl
  need_cmd python3

  [[ -n "${BASE_URL}" ]] || fail "--base-url 必填"
  [[ -n "${SYL_KEY}" ]] || fail "--key 必填"

  BASE_URL="${BASE_URL%/}"
  check_healthz
  local token
  token="$(check_auth)"
  check_rules_endpoints "$token"
  check_generate_pipeline "$token"
  log "外部诊断完成: worker 对外接口运行正常"
}

main "$@"
