.PHONY: default test typecheck build clean

DEFAULT_GOAL := default

default: test build

test: typecheck

typecheck:
	npm run typecheck

build:
	npm run build

clean:
	rm -rf dist
