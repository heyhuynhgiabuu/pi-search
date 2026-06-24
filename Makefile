.DEFAULT_GOAL := help

.PHONY: help install format lint typecheck test test-watch check build release-dry-run changeset version-packages release

help:
	@printf '%s\n' \
		'Available targets:' \
		'  make install' \
		'  make format' \
		'  make lint' \
		'  make typecheck' \
		'  make test' \
		'  make test-watch' \
		'  make check' \
		'  make build' \
		'  make release-dry-run' \
		'  make changeset' \
		'  make version-packages' \
		'  make release'

install:
	npm ci

format:
	npm run format

lint:
	npm run lint

typecheck:
	npm run typecheck

test:
	npm run test

test-watch:
	npm run test:watch

check:
	npm run check

build:
	npm run build

release-dry-run:
	npm run release:dry-run

changeset:
	npm run changeset

version-packages:
	npm run version-packages

release:
	npm run check
	npm run build
	npm publish --access public
