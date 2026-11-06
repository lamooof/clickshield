.PHONY: help run test test-integration test-js test-backup check check-fmt check-js fmt vet build vendor docker-up docker-down

help:
	@echo 'make check             Format, vet, Go race tests, JS syntax and tests'
	@echo 'make test-integration  Race tests with dedicated PostgreSQL (CLICKSHIELD_TEST_DATABASE_URL)'
	@echo 'make test-backup       Backup script tests (Python 3, age and age-keygen required)'
	@echo 'make build             Build bin/clickshield with embedded frontend'
	@echo 'make run               Start server (configuration must be exported)'
	@echo 'make fmt               Format Go sources'
	@echo 'make vendor            Refresh embedded rrweb assets after npm ci'
	@echo 'make docker-up         Build and start local Compose services'
	@echo 'make docker-down       Stop Compose services, preserving database volume'

run:
	go run ./cmd/server

test:
	go test -race -count=1 -p 1 ./...

test-integration:
	@test -n "$$CLICKSHIELD_TEST_DATABASE_URL" || { echo 'Set CLICKSHIELD_TEST_DATABASE_URL to a dedicated test database' >&2; exit 1; }
	go test -race -count=1 -p 1 ./...

test-js:
	npm test

test-backup:
	python3 scripts/backup_test.py -v

check: check-fmt vet test check-js test-js

check-fmt:
	@files="$$(gofmt -l cmd internal)"; test -z "$$files" || { echo "$$files"; echo 'Run make fmt' >&2; exit 1; }

check-js:
	npm run check

fmt:
	gofmt -w cmd internal

vet:
	go vet ./...

build:
	mkdir -p bin
	CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o bin/clickshield ./cmd/server

vendor:
	npm run vendor

docker-up:
	docker compose up -d --build

docker-down:
	docker compose down
