# Thin wrappers over the common workflows. `make help` lists them.
.DEFAULT_GOAL := help
.PHONY: help up down destroy logs build migrate seed test test-unit dev install env not-the-server prod-up prod-down prod-logs prod-ps backup

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

# The production checkout lives at /srv/triage-engine. The dev targets publish
# ports and, in `destroy`'s case, delete volumes -- neither is survivable there.
# The dev compose file carries its own project name so it can no longer collide
# with production, but a mistyped target should still refuse rather than rely on
# that alone.
not-the-server:
	@if [ "$$PWD" = "/srv/triage-engine" ]; then \
		echo "refusing: this is the production checkout. Use the prod-* targets."; \
		exit 1; \
	fi

env: ## Create .env from .env.example if missing
	@test -f .env || (cp .env.example .env && echo "created .env from .env.example")

up: not-the-server env ## Build and start the full stack (app + postgres + redis)
	docker compose up --build -d
	@echo "app:      http://localhost:3000"
	@echo "health:   http://localhost:3000/health"
	@echo "metrics:  http://localhost:3000/metrics"

down: not-the-server ## Stop the local stack (volumes are KEPT)
	docker compose down

destroy: not-the-server ## Stop the local stack AND delete its volumes
	docker compose down -v

logs: not-the-server ## Tail app logs
	docker compose logs -f app

build: ## Compile TypeScript
	npm run build

install: ## Install dependencies
	npm install

dev: not-the-server ## Run the app in watch mode against host-mapped postgres/redis
	npm run start:dev

migrate: not-the-server ## Run database migrations
	npm run migration:run

seed: not-the-server ## Insert a few sample tickets via POST /events
	npm run seed

test: ## Run the integration test suite (testcontainers: real postgres + redis)
	npm run test

test-unit: ## Run unit tests
	npm run test:unit

# ── Production (single host; see docs/DEPLOYMENT.md) ─────────────────────────
PROD := docker compose -f docker-compose.prod.yml

prod-up: ## Start the production stack (needs .env from .env.production.example)
	$(PROD) up -d

prod-down: ## Stop the production stack (volumes are KEPT)
	$(PROD) down

prod-logs: ## Tail production app logs
	$(PROD) logs -f app

prod-ps: ## Show production container status
	$(PROD) ps

backup: ## Dump the production database to ./backups
	./deploy/backup.sh
