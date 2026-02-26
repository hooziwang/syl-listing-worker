.PHONY: default install test typecheck build clean docker-up docker-down docker-logs deploy diagnose diagnose-external

DEFAULT_GOAL := default

default: test build

test: typecheck

typecheck:
	npm run typecheck

build:
	npm run build

clean:
	rm -rf dist

docker-up:
	docker compose up -d --build

docker-down:
	docker compose down

docker-logs:
	docker compose logs -f --tail=200

deploy:
	bash scripts/deploy.sh

diagnose:
	bash scripts/diagnose.sh

diagnose-external:
	bash scripts/diagnose_external.sh --base-url "$(BASE_URL)" --key "$(SYL_KEY)" --timeout "$(TIMEOUT)" --interval "$(INTERVAL)" --resolve "$(RESOLVE)" $(DIAGNOSE_EXTERNAL_OPTS)
