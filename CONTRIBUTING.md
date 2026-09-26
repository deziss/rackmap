# Contributing to RackMap

Thanks for taking the time to contribute. This document covers everything you need to get a change merged.

## Code of Conduct

This project ships a [Code of Conduct](CODE_OF_CONDUCT.md). By participating you agree to uphold it.

## Ways to contribute

- **Report a bug** — use the [bug report template](https://github.com/deziss/rackmap/issues/new?template=bug_report.yml). Include your deployment mode (Docker or bare metal), RackMap version, and the relevant logs.
- **Request a feature** — use the [feature request template](https://github.com/deziss/rackmap/issues/new?template=feature_request.yml). Describe the operational problem, not just the proposed solution.
- **Improve documentation** — corrections to `README.md`, `USER_GUIDE.md`, and `MIGRATION.md` are always welcome.
- **Submit code** — see below.

> **Never open a public issue for a security vulnerability.** Follow the [Security Policy](SECURITY.md) instead.

## Development setup

**Prerequisites:** Node.js 24 (the version used by CI and the Docker images), pnpm 10 (`corepack enable pnpm`), and
PostgreSQL 18. SQLite is not supported.

```bash
git clone https://github.com/deziss/rackmap.git
cd rackmap
pnpm install

# 1. A local PostgreSQL 18, e.g. in Docker (use -p 127.0.0.1:5433:5432 if 5432 is taken, and adjust the URLs)
docker run -d --name rackmap-dev-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 postgres:18
docker exec rackmap-dev-pg psql -U postgres \
  -c 'CREATE DATABASE server_inventory' \
  -c 'CREATE DATABASE server_inventory_test' \
  -c 'CREATE DATABASE server_inventory_shadow'

# 2. API configuration — the API and the Prisma CLI read apps/api/.env
cp .env.example apps/api/.env
sed -i "s|^APP_ENCRYPTION_KEY=.*|APP_ENCRYPTION_KEY=$(openssl rand -base64 32)|" apps/api/.env
sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$(openssl rand -hex 32)|" apps/api/.env
sed -i "s|^PORT=.*|PORT=3001|" apps/api/.env   # the Vite dev server proxies /api and /health to :3001
# DATABASE_URL in .env.example already points at postgres:postgres@localhost:5432/server_inventory

# 3. Schema and seed data
pnpm --filter @inv/api db:generate
pnpm --filter @inv/api db:deploy
pnpm --filter @inv/api db:seed    # the SEED_ADMIN_* admin, plus demo editor/viewer accounts (see prisma/seed.ts)

pnpm dev   # API on :3001, web on http://localhost:5173
```

The root `.env` is for Docker Compose only. Outside production the seed accepts the example admin password and always
adds demo accounts, so never point a development `.env` at a real database.

## Project layout

```
apps/api/         Hono REST API, Prisma schema and migrations, WebSocket SSH, background jobs
apps/web/         React + Vite SPA (TanStack Router/Query, shadcn/ui)
packages/shared/  Zod schemas, permissions (RBAC), license features, and constants shared by both apps
contrib/          Ansible inventory, Prometheus config, Grafana dashboard
e2e/              Playwright end-to-end specs
```

## Tests

The API suite (about 1,300 tests, Vitest) runs against a real PostgreSQL database:

```bash
export TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/server_inventory_test?schema=public"
pnpm test
```

- The database name **must end in `_test`**. The suite refuses anything else, because it brings the schema up to date
  with `prisma db push` and **truncates every table** once per run. Unset, it defaults to
  `postgresql://postgres:postgres@localhost:5432/server_inventory_test`.
- Spec files run one at a time, each in its own fork, and share that database, so each file seeds the rows it needs.
- CI runs the same suite against a `postgres:18` service. Tests must pass; do not skip or disable a test to get a
  green build.

## Before you open a pull request

Run the full local gate — CI runs the same commands, in this order:

```bash
pnpm build       # first: generates apps/web/src/routeTree.gen.ts (not committed), which typecheck needs
pnpm typecheck   # type-checks every workspace
pnpm test        # needs TEST_DATABASE_URL (see above)
pnpm e2e         # optional; Playwright against a running instance at http://localhost:3123 (playwright.config.ts)
```

## Database changes and migrations

Migrations live in `apps/api/prisma/migrations/` and are applied with `prisma migrate deploy` (the Docker image does
this on every start). To change the schema:

1. Edit `apps/api/prisma/schema.prisma`.
2. Generate the SQL with `prisma migrate diff`, writing the file with **`--output`**. Do not use shell redirection
   (`> migration.sql`): it can capture tool output or leave a partial file when the command fails. A truncated
   migration once shipped that way.

   ```bash
   cd apps/api
   export SHADOW_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/server_inventory_shadow?schema=public"
   NAME=$(date -u +%Y%m%d%H%M%S)_add_widget_table
   pnpm exec prisma migrate diff \
     --from-migrations prisma/migrations \
     --to-schema-datamodel prisma/schema.prisma \
     --shadow-database-url "$SHADOW_DATABASE_URL" \
     --script --output /tmp/migration.sql
   mkdir prisma/migrations/$NAME && mv /tmp/migration.sql prisma/migrations/$NAME/migration.sql
   ```

   The shadow database is scratch space that Prisma wipes; never point it at real data.
3. Read the generated SQL, then apply it to your dev database with `pnpm --filter @inv/api db:deploy`.
4. Confirm there is no drift left. This is the check CI runs, and it fails the build on any difference (exit code 2):

   ```bash
   pnpm exec prisma migrate diff \
     --from-migrations prisma/migrations \
     --to-schema-datamodel prisma/schema.prisma \
     --shadow-database-url "$SHADOW_DATABASE_URL" \
     --exit-code
   ```

Never edit a migration that has been released; add a new one instead.

## Branches and commits

Branch from `main` using a descriptive prefix:

```
feat/ssl-wildcard-grouping
fix/metrics-gpu-null-temp
docs/deployment-postgres
chore/bump-prisma
```

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(servers): add sticky hostname column
fix(ssh): fall back to keyboard-interactive when key auth is rejected
docs(readme): document VAULT_PASSPHRASE unlock modes
chore(deps): bump prisma to 6.2
```

Common scopes: `api`, `web`, `shared`, `db`, `ssh`, `ssl`, `servers`, `services`, `logs`, `auth`, `cron`,
`heartbeats`, `runbooks`, `alerts`, `systemd`, `patches`, `drift`, `access-grants`, `ops`, `ci`, `docker`.

## Pull request checklist

- [ ] `pnpm build`, `pnpm typecheck`, and `pnpm test` all pass
- [ ] New or changed behaviour is covered by a test where practical
- [ ] Database changes include a migration generated with `prisma migrate diff --output`, and the drift check passes
- [ ] New permissions go in `packages/shared/src/permissions.ts`, and new license features in
      `packages/shared/src/schemas/license.ts`, with the README RBAC / licensing tables updated
- [ ] New environment variables are added to `apps/api/src/env.ts`, `.env.example`, the README configuration table,
      and, if Docker users need them, the api service's `environment` list in `docker-compose.yml`
- [ ] User-facing changes are reflected in `USER_GUIDE.md`; breaking changes in `MIGRATION.md`
- [ ] No secrets, real hostnames, internal IP addresses, or customer data in code, fixtures, tests, or screenshots
      (use `example.com` and the documentation ranges `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`)
- [ ] `CHANGELOG.md` updated under `## [Unreleased]`

## Things that will block a merge

- Committing a real `.env`, private key, certificate, or database file
- Screenshots or test fixtures containing production hostnames, IPs, or account names
- Schema changes without a migration, or a migration that fails the drift check
- Disabling a test rather than fixing it

## License

By contributing, you agree that your contributions are licensed under the
[GNU AGPL-3.0](LICENSE), the same license that covers this project.
