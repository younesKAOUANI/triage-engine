# Thin wrappers over the common workflows. `make help` lists them.
.DEFAULT_GOAL := help
.PHONY: help up down logs build migrate seed test test-unit dev install env

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
