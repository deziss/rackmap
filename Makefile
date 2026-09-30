# RackMap — one-command setup.
#
#   make up     start everything (generates .env on first run)
#   make help   every target
#
# The scripts under scripts/ do the real work so they also run without make.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

COMPOSE := docker compose
ENV_FILE := .env

.PHONY: help up start setup doctor logs down restart ps reset credentials build test typecheck

help: ## Show this help
	@echo "RackMap"
	@echo
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-13s\033[0m %s\n", $$1, $$2}'
	@echo

# A file target, so make itself guarantees this runs only when .env is missing.
$(ENV_FILE):
	@./scripts/setup-env.sh

setup: $(ENV_FILE) ## Generate .env only (never overwrites an existing one)

up: $(ENV_FILE) ## Start RackMap (builds on first run), then print the login
	@./scripts/doctor.sh --fatal-only
	@echo "Building and starting — the first build takes a few minutes..."
	@# --build is mandatory, not an optimisation: the api image now carries the
	@# entrypoint that assembles DATABASE_URL. An image from before v1.1.0 run
	@# against this compose file has no database URL at all.
	@# Build first, separately. Folding it into `up` meant a failed build fell
	@# through to the log dump below, which then showed the PREVIOUS container's
	@# stale crash — so a dead network looked like an application bug.
	@$(COMPOSE) build \
		|| { echo; \
		     echo "The image build failed — nothing was started, and any container"; \
		     echo "still running is from a previous attempt."; \
		     echo; \
		     echo "If the log above shows EAI_AGAIN, ETIMEDOUT or slow tarball"; \
		     echo "downloads, the npm registry was unreachable. Check your network"; \
		     echo "or proxy and run 'make up' again — nothing is broken."; \
		     echo; \
		     echo "  docker compose down   stop the old container meanwhile"; \
		     exit 1; }
	@$(COMPOSE) up -d --wait --wait-timeout 420 \
		|| { echo; echo "The images built, but the stack did not come up."; echo; \
		     $(COMPOSE) ps; echo; \
		     echo "Recent api logs:"; echo; \
		     $(COMPOSE) logs --tail=40 api; exit 1; }
	@$(MAKE) --no-print-directory credentials

start: ## Start without rebuilding
	@$(COMPOSE) up -d --wait

down: ## Stop. Your data is kept.
	@$(COMPOSE) down
	@echo "Stopped. Data volumes are intact — 'make up' brings it back."

restart: down start ## Stop and start again

ps: ## Show container status
	@$(COMPOSE) ps

logs: ## Follow the logs
	@$(COMPOSE) logs -f --tail=100

doctor: ## Check the configuration without starting anything
	@./scripts/doctor.sh

credentials: ## Show the URL and the seeded admin login
	@port=$$(grep -E '^PORT=' $(ENV_FILE) 2>/dev/null | cut -d= -f2- || echo 8080); \
	email=$$(grep -E '^SEED_ADMIN_EMAIL=' $(ENV_FILE) 2>/dev/null | cut -d= -f2- || echo '?'); \
	pass=$$(grep -E '^SEED_ADMIN_PASSWORD=' $(ENV_FILE) 2>/dev/null | cut -d= -f2- || echo '?'); \
	echo; \
	echo "  RackMap is up."; \
	echo; \
	echo "  URL       http://localhost:$$port"; \
	echo "  Email     $$email"; \
	echo "  Password  $$pass"; \
	echo; \
	echo "  This is the password seeded on first run — if you changed it in the"; \
	echo "  UI, the UI wins. Stored in .env (mode 600)."; \
	echo; \
	echo "  make logs    follow the logs"; \
	echo "  make down    stop (data is kept)"; \
	echo "  make doctor  check the configuration"; \
	echo

reset: ## DESTRUCTIVE — delete all data and start fresh (CONFIRM=yes)
	@if [ "$${CONFIRM:-}" != "yes" ]; then \
		echo "This permanently deletes:"; \
		echo "  - the database (every server, service, user and audit record)"; \
		echo "  - /data (including any SSH keys you put there)"; \
		echo "  - the backups volume"; \
		echo; \
		echo "Your .env is kept, so the admin login stays the same."; \
		echo "Re-run with:  make reset CONFIRM=yes"; \
		exit 1; \
	fi
	@$(COMPOSE) down -v
	@$(MAKE) --no-print-directory up

build: ## Build all workspaces
	@pnpm build

test: ## Run the test suite
	@pnpm test

typecheck: ## Typecheck all workspaces
	@pnpm -r typecheck
