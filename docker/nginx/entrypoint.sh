#!/bin/sh
set -eu

if [ -z "${DOMAIN:-}" ]; then
  echo "DOMAIN is required"
  exit 1
fi

CONF_DIR="/etc/nginx/conf.d"
TPL_DIR="/etc/nginx/templates"
STATE_FILE="/var/run/nginx_tls_mode"
CERT_FILE="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
KEY_FILE="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"

render_http() {
  envsubst '${DOMAIN}' < "${TPL_DIR}/http.conf.template" > "${CONF_DIR}/default.conf"
  echo "http" > "${STATE_FILE}"
}

render_https() {
  envsubst '${DOMAIN}' < "${TPL_DIR}/https.conf.template" > "${CONF_DIR}/default.conf"
  echo "https" > "${STATE_FILE}"
}

if [ -s "${CERT_FILE}" ] && [ -s "${KEY_FILE}" ]; then
  render_https
else
  render_http
fi

reload_loop() {
  while true; do
    sleep 120
    mode="$(cat "${STATE_FILE}" 2>/dev/null || echo "http")"
    if [ "${mode}" = "http" ] && [ -s "${CERT_FILE}" ] && [ -s "${KEY_FILE}" ]; then
      render_https
      nginx -s reload || true
    elif [ "${mode}" = "https" ]; then
      nginx -s reload || true
    fi
  done
}

reload_loop &
exec nginx -g 'daemon off;'
