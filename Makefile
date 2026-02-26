.PHONY: default install test typecheck build clean compose-env docker-up docker-down docker-logs deploy diagnose diagnose-external push-env deploy-remote servers

DEFAULT_GOAL := default
CONFIG_FILE ?= worker.config.json
COMPOSE_ENV_FILE ?= .compose.env
ENV_FILE ?= .env

# 内置远程服务器清单
# 用法:
#   make push-env SERVER=syl-server
#   make deploy-remote SERVER=syl-server
SERVER ?= syl-server
SERVER_LIST := syl-server

REMOTE_HOST_syl-server := 43.135.112.167
REMOTE_USER_syl-server := ubuntu
REMOTE_PORT_syl-server := 22
REMOTE_DIR_syl-server := /opt/syl-listing-worker

REMOTE_HOST ?= $(REMOTE_HOST_$(SERVER))
REMOTE_USER ?= $(REMOTE_USER_$(SERVER))
REMOTE_PORT ?= $(REMOTE_PORT_$(SERVER))
REMOTE_DIR ?= $(REMOTE_DIR_$(SERVER))

default: test build

test: typecheck

typecheck:
	npm run typecheck

build:
	npm run build

clean:
	rm -rf dist

compose-env:
	@python3 -c 'import json,pathlib,sys;cfg=pathlib.Path("$(CONFIG_FILE)");out=pathlib.Path("$(COMPOSE_ENV_FILE)");data=json.loads(cfg.read_text(encoding="utf-8"));server=data.get("server") or {};domain=str(server.get("domain","")).strip();email=str(server.get("letsencrypt_email","") or "");sys.exit(f"config.server.domain 不能为空: {cfg}") if not domain else None;out.write_text(f"DOMAIN={domain}\nLETSENCRYPT_EMAIL={email}\n",encoding="utf-8")'

docker-up:
	@$(MAKE) compose-env CONFIG_FILE="$(CONFIG_FILE)" COMPOSE_ENV_FILE="$(COMPOSE_ENV_FILE)"
	docker compose --env-file "$(COMPOSE_ENV_FILE)" up -d --build

docker-down:
	@$(MAKE) compose-env CONFIG_FILE="$(CONFIG_FILE)" COMPOSE_ENV_FILE="$(COMPOSE_ENV_FILE)"
	docker compose --env-file "$(COMPOSE_ENV_FILE)" down

docker-logs:
	@$(MAKE) compose-env CONFIG_FILE="$(CONFIG_FILE)" COMPOSE_ENV_FILE="$(COMPOSE_ENV_FILE)"
	docker compose --env-file "$(COMPOSE_ENV_FILE)" logs -f --tail=200

deploy:
	bash scripts/deploy.sh

diagnose:
	bash scripts/diagnose.sh

diagnose-external:
	bash scripts/diagnose_external.sh --base-url "$(BASE_URL)" --key "$(SYL_KEY)" --timeout "$(TIMEOUT)" --interval "$(INTERVAL)" --resolve "$(RESOLVE)" $(DIAGNOSE_EXTERNAL_OPTS)

push-env:
	@test -f "$(ENV_FILE)" || (echo "错误: 未找到 $(ENV_FILE)"; exit 1)
	@test -n "$(REMOTE_HOST)" || (echo "错误: 需要传入 REMOTE_HOST"; exit 1)
	@scp -P "$(REMOTE_PORT)" "$(ENV_FILE)" "$(REMOTE_USER)@$(REMOTE_HOST):/tmp/syl-listing-worker.env.tmp"
	@ssh -p "$(REMOTE_PORT)" "$(REMOTE_USER)@$(REMOTE_HOST)" "set -euo pipefail; if cp /tmp/syl-listing-worker.env.tmp $(REMOTE_DIR)/.env 2>/dev/null; then rm -f /tmp/syl-listing-worker.env.tmp; else if command -v sudo >/dev/null 2>&1; then sudo cp /tmp/syl-listing-worker.env.tmp $(REMOTE_DIR)/.env; sudo chown $(REMOTE_USER):$(REMOTE_USER) $(REMOTE_DIR)/.env; rm -f /tmp/syl-listing-worker.env.tmp; else echo '错误: 无法写入远端 .env（权限不足且无 sudo）' >&2; exit 1; fi; fi; cd $(REMOTE_DIR); python3 -c 'import json,pathlib; data=json.loads(pathlib.Path(\"worker.config.json\").read_text(encoding=\"utf-8\")); server=data.get(\"server\") or {}; domain=str(server.get(\"domain\",\"\")).strip(); email=str(server.get(\"letsencrypt_email\",\"\") or \"\"); assert domain, \"config.server.domain 不能为空\"; pathlib.Path(\".compose.env\").write_text(f\"DOMAIN={domain}\\nLETSENCRYPT_EMAIL={email}\\n\", encoding=\"utf-8\")'; if docker compose version >/dev/null 2>&1 && docker compose --env-file .compose.env up -d --no-deps --force-recreate worker-api worker-runner; then :; elif sudo -n docker compose version >/dev/null 2>&1 && sudo docker compose --env-file .compose.env up -d --no-deps --force-recreate worker-api worker-runner; then :; elif docker-compose version >/dev/null 2>&1 && docker-compose --env-file .compose.env up -d --no-deps --force-recreate worker-api worker-runner; then :; elif sudo -n docker-compose version >/dev/null 2>&1 && sudo docker-compose --env-file .compose.env up -d --no-deps --force-recreate worker-api worker-runner; then :; else echo '错误: 无法重启 worker（docker 权限不足或 compose 不可用）' >&2; exit 1; fi"
	@echo ".env 下发并重启 worker 完成: $(REMOTE_USER)@$(REMOTE_HOST):$(REMOTE_DIR)"

deploy-remote:
	@test -n "$(REMOTE_HOST)" || (echo "错误: 需要传入 REMOTE_HOST"; exit 1)
	bash scripts/deploy.sh --remote-host "$(REMOTE_HOST)" --remote-user "$(REMOTE_USER)" --remote-port "$(REMOTE_PORT)" --remote-dir "$(REMOTE_DIR)"

servers:
	@echo "可用服务器别名: $(SERVER_LIST)"
	@echo "SERVER=$(SERVER)"
	@echo "REMOTE_HOST=$(REMOTE_HOST)"
	@echo "REMOTE_USER=$(REMOTE_USER)"
	@echo "REMOTE_PORT=$(REMOTE_PORT)"
	@echo "REMOTE_DIR=$(REMOTE_DIR)"
