# Thin wrappers over the common workflows. `make help` lists them.
.DEFAULT_GOAL := help
.PHONY: help up down logs build migrate seed test test-unit dev install env prod-up prod-down prod-logs prod-ps backup

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

env: ## Create .env from .env.example if missing
	@test -f .env || (cp .env.example .env && echo "created .env from .env.example")

up: env ## Build and start the full stack (app + postgres + redis)
	docker compose up --build -d
	@echo "app:      http://localhost:3000"
	@echo "health:   http://localhost:3000/health"
	@echo "metrics:  http://localhost:3000/metrics"

down: ## Stop the stack and remove volumes
	docker compose down -v

logs: ## Tail app logs
	docker compose logs -f app

build: ## Compile TypeScript
	npm run build

install: ## Install dependencies
	npm install

dev: ## Run the app in watch mode against host-mapped postgres/redis
	npm run start:dev

migrate: ## Run database migrations
	npm run migration:run

seed: ## Insert a few sample tickets via POST /events
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
