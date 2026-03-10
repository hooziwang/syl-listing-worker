.PHONY: default install test typecheck build clean compose-env docker-up docker-down docker-logs

DEFAULT_GOAL := default
CONFIG_FILE ?= worker.config.json
COMPOSE_ENV_FILE ?= .compose.env
ENV_FILE ?= .env

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
