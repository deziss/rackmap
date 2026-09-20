# Contributing to RackMap

Thanks for taking the time to contribute. This document covers everything you need to get a change merged.

## Code of Conduct

This project ships a [Code of Conduct](CODE_OF_CONDUCT.md). By participating you agree to uphold it.

## Ways to contribute

- **Report a bug** — use the [bug report template](https://github.com/deziss/rackmap/issues/new?template=bug_report.yml). Include your deployment mode (Docker or bare metal), RackMap version, and the relevant logs.
- **Request a feature** — use the [feature request template](https://github.com/deziss/rackmap/issues/new?template=feature_request.yml). Describe the operational problem, not just the proposed solution.
- **Improve documentation** — corrections to `README.md` and `USER_GUIDE.md` are always welcome.
- **Submit code** — see below.

> **Never open a public issue for a security vulnerability.** Follow the [Security Policy](SECURITY.md) instead.

## Development setup

**Prerequisites:** Node.js 22+, pnpm 10+

```bash
git clone https://github.com/deziss/rackmap.git
cd rackmap
pnpm install

cp .env.example .env
# Generate real secrets before starting
sed -i "s|^APP_ENCRYPTION_KEY=.*|APP_ENCRYPTION_KEY=$(openssl rand -base64 32)|" .env
sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$(openssl rand -hex 32)|" .env

pnpm --filter @inv/api db:generate
pnpm --filter @inv/api db:migrate
pnpm --filter @inv/api db:seed

pnpm dev   # API on :3000, web on :5173
```

## Project layout

```
apps/api/         Hono REST API, Prisma schema and migrations, WebSocket SSH
apps/web/         React + Vite SPA (TanStack Router/Query, shadcn/ui)
packages/shared/  Types, constants, and DTOs shared by both apps
e2e/              Playwright end-to-end specs
```

## Before you open a pull request

Run the full local gate — CI runs the same commands:

```bash
pnpm typecheck   # tsc --noEmit across all workspaces
pnpm test        # Vitest unit tests
pnpm build       # production build of every workspace
pnpm e2e         # Playwright (needs a running instance; see playwright.config.ts)
```

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

Common scopes: `api`, `web`, `shared`, `db`, `ssh`, `ssl`, `servers`, `services`, `logs`, `auth`, `ci`, `docker`.

## Pull request checklist

- [ ] `pnpm typecheck`, `pnpm test`, and `pnpm build` all pass
- [ ] New or changed behaviour is covered by a test where practical
- [ ] Database changes include a Prisma migration (`pnpm --filter @inv/api db:migrate`)
- [ ] New environment variables are documented in `.env.example` **and** the README configuration table
- [ ] User-facing changes are reflected in `USER_GUIDE.md`
- [ ] No secrets, real hostnames, internal IP addresses, or customer data in code, fixtures, tests, or screenshots
- [ ] `CHANGELOG.md` updated under `## [Unreleased]`

## Things that will block a merge

- Committing a real `.env`, private key, certificate, or database file
- Screenshots or test fixtures containing production hostnames, IPs, or account names
- Schema changes without a migration
- Disabling a test rather than fixing it

## License

By contributing, you agree that your contributions are licensed under the
[GNU AGPL-3.0](LICENSE), the same license that covers this project.
