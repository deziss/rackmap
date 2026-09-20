<div align="center">

# RackMap

**Agentless infrastructure inventory, monitoring, and access control — for bare metal, cloud, and everything in between.**

Track every server, service, and certificate you own. Watch live CPU, memory, disk, network, and GPU metrics over plain SSH.
Manage Linux accounts, open a browser terminal, and keep a complete audit trail — **without installing a single agent on a target host.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![CI](https://github.com/deziss/rackmap/actions/workflows/ci.yml/badge.svg)](https://github.com/deziss/rackmap/actions/workflows/ci.yml)
[![Docker Publish](https://github.com/deziss/rackmap/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/deziss/rackmap/actions/workflows/docker-publish.yml)
[![GHCR](https://img.shields.io/badge/GHCR-ghcr.io%2Fdeziss%2Frackmap-24292e?logo=github)](https://github.com/deziss/rackmap/pkgs/container/rackmap%2Fapi)
[![Self-hosted](https://img.shields.io/badge/deploy-self--hosted-0db7ed?logo=docker&logoColor=white)](#-quick-start)

[Quick Start](#-quick-start) · [Features](#-features) · [User Guide](USER_GUIDE.md) · [Configuration](#%EF%B8%8F-configuration) · [Deployment](#-deployment) · [API](#-api-overview) · [Contributing](CONTRIBUTING.md)

![RackMap dashboard — fleet overview with live status, environment split, project allocation, and GPU inventory](docs/screenshots/dashboard.png)

</div>

---

## Why RackMap?

Most infrastructure tools want an agent on every box. That means a rollout, a package to maintain, a daemon to
patch, and a security review before you can see a single CPU graph.

RackMap takes the opposite approach. **It connects over SSH, runs one command, parses the output, and disconnects.**
Nothing is installed on the machines you monitor. That makes it a good fit for:

- **Mixed fleets** — bare metal, VMs, and cloud instances side by side, on standard or non-standard SSH ports
- **GPU and AI infrastructure** — NVIDIA, AMD, and Intel accelerators, plus vLLM / Ollama / llama.cpp endpoints as first-class inventory
- **Environments you don't fully control** — customer hardware, colo racks, or hosts where installing an agent is not an option
- **Teams that need an audit trail** — every mutation and auth event is recorded with before/after state

| | |
|---|---|
| **No agents** | One SSH exec per poll. Nothing to install, patch, or roll back on target hosts. |
| **Credentials encrypted at rest** | AES-256-GCM, plus an optional zero-knowledge vault whose passphrase never touches disk. |
| **RBAC + access requests** | admin / editor / viewer, with a request-and-approve flow for SSH and password reveal. |
| **Self-hosted, AGPL-3.0** | Your inventory stays on your infrastructure. One `docker compose up`. |

---

## ⚡ Quick Start

**Requirements:** Docker and Docker Compose. Nothing else.

```bash
# 1. Clone
git clone https://github.com/deziss/rackmap.git
cd rackmap

# 2. Create .env with generated secrets (never commit this file)
cp .env.example .env
sed -i "s|^APP_ENCRYPTION_KEY=.*|APP_ENCRYPTION_KEY=$(openssl rand -base64 32)|" .env
sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$(openssl rand -hex 32)|" .env

# 3. Start (build on first run and after pulling updates)
docker compose up -d --build

# 4. Open http://localhost:8080
```

Sign in with the credentials from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` in your `.env`
(defaults: `admin@example.com` / `Change-Me-Now-123!`).

> **Change the seeded admin password immediately after your first login.**

Change the published port by setting `PORT` in `.env`. Next steps: [add your first server](USER_GUIDE.md),
[enable the SSH terminal](#optional--ssh-terminal), or [configure alerts](#optional--notifications).

---

## 📚 Documentation

| Document | What's in it |
|----------|--------------|
| **[User Guide](USER_GUIDE.md)** | Day-to-day usage: every page, every feature, roles, troubleshooting |
| **[Configuration](#%EF%B8%8F-configuration)** | Every environment variable, with defaults |
| **[Encryption Guide](#-encryption--credential-vault)** | At-rest encryption, the zero-knowledge vault, passphrase recovery |
| **[Deployment](#-deployment)** | Docker Compose, bare metal / PM2 / systemd, PostgreSQL |
| **[API Overview](#-api-overview)** | REST endpoints and required roles |
| **[Contributing](CONTRIBUTING.md)** | Dev setup, branch and commit conventions, PR checklist |
| **[Security Policy](SECURITY.md)** | How to report a vulnerability |
| **[Changelog](CHANGELOG.md)** | What changed in each release |

---

## ✨ Features

<details open>
<summary><b>Inventory & topology</b></summary>

- **Server CRUD & specifications** — hostname, IP, SSH port (standard and non-standard, e.g. 7722), credentials (AES-256-GCM encrypted at rest), tags, and metadata with dedicated columns for CPU, RAM, storage, OS, and hardware accelerators (H100, H200, RTX PRO 6000, RTX 4090)
- **Service-first multi-hosting model** — track microservices and applications by runtime environment: `server` (host-native systemd services such as Mattermost, Jenkins, GitLab, Zabbix), `docker` (containerized workloads), and `k8s` (Kubernetes deployments with NodePort tracking)
- **AI model & inference topology** — first-class tracking for vLLM, Ollama, and llama.cpp deployments with designated ports, host bindings, and AES-256-GCM encrypted API bearer tokens
- **Backup policy tracking** — backup script paths, destination storage (NVMe, central NFS), cron schedules, retention windows, and data categories
- **Lookup tables** — Cloud Provider, GPU Type, Allocated To, Location, and Server Type dropdowns, all admin-managed
- **Hardware auto-discovery** — detect and persist CPU, RAM, storage, and OS over SSH in one click

</details>

<details open>
<summary><b>Monitoring & observability</b></summary>

- **Live status monitoring** — TCP probe on a configurable interval, up/down history, and webhook + Telegram alerts
- **Agentless live metrics** — CPU load, memory, disk, network I/O, and per-process tables, collected via a single SSH exec
- **Multi-vendor GPU metrics** — NVIDIA (`nvidia-smi`), AMD sysfs (`amdgpu`), AMD ROCm (`rocm-smi`), and Intel (`xpu-smi`)
- **Forensic logs & storage footprint** — query `journalctl`, syslog, `auth.log`, and kernel `dmesg` with live `/var/log` size and journal disk usage badges, evidence search, auto-refresh (5s / 10s / 30s / 60s / manual), and `.log` export
- **ATOP historical replay** — browse historical activity dates and interval snapshots, and extract top CPU / memory / disk processes per interval
- **SSL certificate monitoring** — auto-discovered and manual domains, wildcard support, expiry badges, and automated email warnings

</details>

<details open>
<summary><b>Access & security</b></summary>

- **RBAC** — admin / editor / viewer roles via Better Auth
- **Access requests** — viewers request SSH access or password reveal; admins approve with an expiry window
- **Zero-knowledge credential vault** — envelope encryption (PBKDF2, 100k iterations, SHA-512) where the master passphrase is never written to disk
- **SSH dual-mode auth** — public key first, with automatic fallback to password and PAM keyboard-interactive
- **Browser SSH terminal** — full xterm.js terminal over WebSocket, admin-only, off by default behind a kill-switch
- **OS user & sudoers management** — create, update, lock/unlock, and delete Linux accounts with full options (`-m`, `-r`, custom shells, secondary groups, custom UID/GID, sudoers rules) and root/SSH safeguards
- **Audit log** — every data mutation and auth event with actor, IP, and a before/after JSON diff viewer

</details>

<details open>
<summary><b>Workflow & UX</b></summary>

- **Universal pagination** — rows-per-page selector (10 / 25 / 50 / 100), range display, and numbered pages across every table
- **Export** — Excel (`.xlsx`), JSON, and PDF export that respects the active search filter
- **Customer portal** — a public dark-mode product showcase at `/portal` with an interactive mock console and pricing comparison
- **Single-command deploy** — `docker compose up` for production, with SQLite volume persistence and an optional PostgreSQL profile

</details>

---

## 🏗️ Architecture

```
apps/
  api/       Hono (Node.js) — REST API + WebSocket SSH
  web/       React (Vite) — SPA served by Nginx in Docker
packages/
  shared/    Types, constants, and DTOs shared between apps
```

**Data flow — metrics**

```
Browser → GET /api/v1/servers/:id/metrics
  → API SSHs into the target server
  → Runs one compound shell command (~1s, includes a sleep for network sampling)
  → Parses output → returns typed JSON
  → Browser polls every 5s while the detail view is open
```

**Data flow — SSH terminal**

```
Browser WebSocket → API WS upgrade (validates session + RBAC)
  → API opens an SSH connection to the target
  → Bidirectional pipe (browser PTY ↔ remote shell)
```

### Tech stack

| Layer | Technology |
|-------|-----------|
| API framework | [Hono](https://hono.dev) |
| ORM | [Prisma](https://prisma.io) |
| Database | SQLite by default (PostgreSQL-ready) |
| Auth | [Better Auth](https://better-auth.com) with RBAC |
| SSH | [`ssh2`](https://github.com/mscdex/ssh2) |
| Frontend | React 19 + Vite |
| Routing | [TanStack Router](https://tanstack.com/router) |
| Data fetching | [TanStack Query](https://tanstack.com/query) |
| UI components | [shadcn/ui](https://ui.shadcn.com) + Tailwind CSS |
| Charts | [Recharts](https://recharts.org) |
| Terminal | [xterm.js](https://xtermjs.org) |
| Containerization | Docker + Nginx |

---

## ⚙️ Configuration

All configuration is environment-driven. Copy [`.env.example`](.env.example) to `.env` and edit.

### Required

| Variable | Description |
|----------|-------------|
| `BETTER_AUTH_SECRET` | Random secret for session signing (≥32 chars). Generate with `openssl rand -hex 32` |
| `APP_ENCRYPTION_KEY` *or* `APP_ENCRYPTION_PASSPHRASE` | Master key or passphrase for at-rest encryption (AES-256-GCM). Accepts a 32-byte base64 value or any human-readable passphrase (min 8 chars) |

### Optional — core

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Host port for the web UI |
| `DATABASE_URL` | `file:./dev.db` | Prisma database URL. Use `file:/data/inventory.db` in Docker |
| `WEB_ORIGIN` | `http://localhost:5173` | URL of the web app, used for CORS and auth cookies |
| `SEED_ADMIN_EMAIL` | `admin@example.com` | First-run admin account email |
| `SEED_ADMIN_PASSWORD` | `Change-Me-Now-123!` | First-run admin account password — **change it after first login** |
| `VAULT_PASSPHRASE` | — | Master credential-vault passphrase. When set, the vault auto-unlocks at startup so background jobs can run |

### Optional — scheduler & probing

| Variable | Default | Description |
|----------|---------|-------------|
| `SCHEDULER_ENABLED` | `true` | Enable the background ping scheduler |
| `PING_INTERVAL_MS` | `60000` | Probe frequency in milliseconds |
| `PING_TIMEOUT_MS` | `3000` | Per-server TCP probe timeout |
| `PING_CONCURRENCY` | `10` | Maximum simultaneous probes |
| `STATUS_RETENTION_DAYS` | `30` | Days of probe history to keep |
| `STATUS_FLIP_THRESHOLD` | `2` | Consecutive failures before the status changes |

### Optional — notifications

| Variable | Default | Description |
|----------|---------|-------------|
| `NOTIFY_WEBHOOK_URL` | — | HTTP POST target for up/down alerts |
| `NOTIFY_TELEGRAM_BOT_TOKEN` | — | Telegram bot token |
| `NOTIFY_TELEGRAM_CHAT_ID` | — | Telegram chat or group ID |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | — | SMTP settings for certificate-expiry and threshold emails |

### Optional — live metrics

| Variable | Default | Description |
|----------|---------|-------------|
| `METRICS_ENABLED` | `true` | Enable agentless SSH metrics collection |
| `METRICS_SSH_TIMEOUT_MS` | `10000` | SSH exec timeout for metrics collection |
| `METRICS_ALERT_ENABLED` | `true` | Send alerts when a threshold is crossed |
| `METRICS_ALERT_INTERVAL_MS` | `300000` | Minimum interval between repeat alerts |
| `ALERT_THRESHOLD_CPU` / `ALERT_THRESHOLD_RAM` / `ALERT_THRESHOLD_DISK` | `90` / `95` / `90` | Alert thresholds, in percent |

### Optional — SSH terminal

| Variable | Default | Description |
|----------|---------|-------------|
| `SSH_ENABLED` | `false` | **Kill-switch.** Set to `true` to enable the browser SSH terminal (admin-only) |
| `SSH_CONNECT_TIMEOUT_MS` | `10000` | SSH connection timeout |
| `SSH_IDLE_TIMEOUT_MS` | `300000` | Idle session timeout (5 minutes) |
| `SSH_MAX_SESSION_MS` | `3600000` | Maximum session duration (1 hour) |
| `SSH_MAX_CONCURRENT` | `5` | Maximum simultaneous SSH terminal sessions |

### Optional — licensing (Licencia)

| Variable | Default | Description |
|----------|---------|-------------|
| `LICENCIA_URL` | — | Base URL of the Licencia server |
| `LICENCIA_API_KEY` | — | Tenant API key (`lic_live_...`) |
| `LICENCIA_LICENSE_KEY` | — | Master license key (`LIC-PRO-...`), activated on container startup |
| `LICENCIA_PUBLIC_KEY` | — | Ed25519 SPKI public key for offline, air-gapped token verification |

### SSH dual-mode authentication

RackMap supports hybrid fleets where some hosts require key pairs and others enforce password or PAM authentication.

- **Automatic fallback** — public key first (`/data/id_ed25519` plus custom uploaded keys). If the target rejects the key, it falls back to password and PAM keyboard-interactive without failing.
- **Server detail controls** (`/servers/:id`) — *Test Key Login* (reports round-trip latency), *Test Password Login*, and *Set / Change Password*, which stores the credential encrypted in the vault.
- **Auto-prompt on auth failure** — if discovery, ATOP, logs, or metrics hit an unauthorized host, a password dialog appears and the operation retries.

---

## 🔐 Encryption & Credential Vault

RackMap uses a two-tier cryptographic architecture to protect infrastructure credentials.

### Tier 1 — application at-rest encryption

Set `APP_ENCRYPTION_KEY` (or `APP_ENCRYPTION_PASSPHRASE`) in `.env`. It encrypts sensitive database fields —
server passwords, tokens, secrets — with AES-256-GCM, stored as `v1.<iv>.<tag>.<cipher>`.

```bash
# Recommended: maximum entropy
APP_ENCRYPTION_KEY=$(openssl rand -base64 32)

# Or a human-readable passphrase (a 32-byte AES key is derived via SHA-256)
APP_ENCRYPTION_PASSPHRASE="YourSecurePassphraseHere123!"
```

### Tier 2 — zero-knowledge credential vault

Envelope encryption (`v2.<iv>.<tag>.<cipher>`) using PBKDF2 (100,000 iterations, SHA-512) to derive a 256-bit
key-encryption key that wraps an ephemeral 256-bit data-encryption key. **The master passphrase is never stored on disk.**

Three ways to unlock it:

| Option | Where | Best for |
|--------|-------|----------|
| **A — automated unlock** | `VAULT_PASSPHRASE` in `.env` | Production. Auto-unlocks at API startup so auto-discovery, metrics polling, and log queries can decrypt credentials unattended |
| **B — global unlock via UI** | **Settings → Credential Vault** | Admins unlocking for the whole instance. Optionally tick *Persist to .env file* to survive restarts |
| **C — ephemeral session** | Header of any server detail page | Per-operator, time-boxed unlock (30 minutes) |

### Resetting a forgotten passphrase

1. Go to **Security** (`/security`), or click the **Vault** badge in any server header.
2. If locked: click **Forgot passphrase? Reset vault** (admin only).
3. If unlocked: click **Manage / Reset Passphrase → Reset / Re-key**.
4. Enter and confirm a new master passphrase (minimum 8 characters).

Or via the API:

```bash
curl -X POST http://localhost:3001/api/v1/vault/reset \
  -H "Content-Type: application/json" \
  -H "Cookie: better-auth.session_token=<admin-session>" \
  -d '{"passphrase":"NewSecureMasterPassphrase!"}'
```

> **Resetting generates a brand-new master data-encryption key.** Any server passwords encrypted under the old
> passphrase become unrecoverable and must be re-entered.

---

## 🛡️ Security

- **Passwords encrypted at rest** — AES-256-GCM, keyed by `APP_ENCRYPTION_KEY`
- **Passwords never sent to the client** — `passwordEnc` fields are stripped from every API response
- **SSH terminal off by default** — requires `SSH_ENABLED=true` *and* admin role (or an approved access request)
- **WebSocket auth** — the WS upgrade validates the Better Auth session, ban status, and RBAC before opening SSH
- **Audit trail** — every write and auth event recorded with actor, IP, and before/after state
- **CORS** — configurable via `TRUSTED_ORIGINS`; set it explicitly in production

Found a vulnerability? Please follow our [Security Policy](SECURITY.md) — do not open a public issue.

---

## 👥 RBAC

| Permission | admin | editor | viewer |
|-----------|:-----:|:------:|:------:|
| View servers | ✓ | ✓ | ✓ |
| Create / update / delete servers | ✓ | ✓ | — |
| Reveal SSH password | ✓ | ✓ | request |
| Live metrics | ✓ | ✓ | — |
| SSH terminal | ✓ | request | request |
| Manage users | ✓ | — | — |
| Manage lookups | ✓ | — | — |
| View audit log | ✓ | — | — |

Viewers submit access requests for the SSH terminal and password reveal; admins approve or reject with an expiry window.

---

## 📡 Agentless Metrics

Nothing is installed on monitored servers. Each poll:

1. SSHs into the target using the stored (encrypted) credentials
2. Runs a single compound shell command reading from `/proc`, `ps`, `df`, and GPU tools
3. Parses the output server-side and returns typed JSON
4. The browser polls every 5 seconds while the detail view is open

### GPU vendor support

Detection runs in priority order:

| Priority | Vendor | Detection | Tools required |
|:--------:|--------|-----------|----------------|
| 1 | NVIDIA | `nvidia-smi -L` | `nvidia-smi` |
| 2 | AMD (sysfs) | `/sys/class/drm/card*/device/gpu_busy_percent` exists | Kernel `amdgpu` driver — no extra tools |
| 3 | AMD (ROCm) | `rocm-smi` on `PATH` | `rocm-smi` |
| 4 | Intel | `xpu-smi` on `PATH` | `xpu-smi` |
| — | None | fallback | — |

All vendors normalize to the same shape: utilization %, VRAM used/total (MiB), and temperature (°C, or `null` when unavailable).

---

## 🔌 API Overview

Every endpoint requires an authenticated Better Auth session cookie.

```
# Auth
POST   /api/auth/sign-in/email
POST   /api/auth/sign-out

# Servers
GET    /api/v1/servers                     List + search + paginate (page, limit)
POST   /api/v1/servers                     Create (editor+)
GET    /api/v1/servers/:id                 Detail
PATCH  /api/v1/servers/:id                 Update (editor+)
DELETE /api/v1/servers/:id                 Soft-delete (editor+)
GET    /api/v1/servers/:id/metrics         Live SSH metrics (editor+)
POST   /api/v1/servers/:id/auto-discover   Detect and persist CPU, RAM, storage, OS
GET    /api/v1/servers/export.xlsx         Export to Excel
GET    /api/v1/servers/export.json         Export to JSON

# OS users & sudoers (editor+)
GET    /api/v1/servers/:id/os-users              List accounts, UIDs, shells, groups, sudo privileges
POST   /api/v1/servers/:id/os-users              Create a Linux user
PATCH  /api/v1/servers/:id/os-users/:username    Update shell, home, groups, password, lock state, sudo rules
DELETE /api/v1/servers/:id/os-users/:username    Delete a user (root/SSH safeguards apply)
PATCH  /api/v1/servers/:id/sudo-permission       Atomic sudoers update (/etc/sudoers.d/rackmap_*)

# Logs & ATOP forensics
POST   /api/v1/servers/:id/logs                  Query journalctl/syslog by priority and unit
GET    /api/v1/servers/:id/atop/dates            List historical ATOP activity dates
GET    /api/v1/servers/:id/atop/snapshots        Query ATOP interval snapshots
GET    /api/v1/servers/:id/atop/top-processes    Top CPU/memory/disk processes per interval

# Lookup tables (admin)
GET|POST|PATCH|DELETE /api/v1/lookups/{cloud-providers,gpu-types,allocated-to,locations,server-types}

# Users (admin)
GET    /api/v1/users
PATCH  /api/v1/users/:id
DELETE /api/v1/users/:id
POST   /api/v1/users/:id/ban
POST   /api/v1/users/:id/unban
PATCH  /api/v1/users/:id/role

# Access requests
POST   /api/v1/access-requests
GET    /api/v1/access-requests
PATCH  /api/v1/access-requests/:id    Approve or reject (admin)

# Audit
GET    /api/v1/audit                  Paginated audit log (cursor-based)

# Health
GET    /health/live
GET    /health/ready
```

---

## 🚀 Deployment

### Docker Compose (recommended)

1. **Prepare the environment.** Create `.env` from `.env.example` and generate real secrets:

   ```bash
   cp .env.example .env
   sed -i "s|^APP_ENCRYPTION_KEY=.*|APP_ENCRYPTION_KEY=\"$(openssl rand -base64 32)\"|" .env
   sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=\"$(openssl rand -hex 32)\"|" .env
   ```

2. **Pick a port.** The web UI is published on `8080` by default; override with `PORT` in `.env`.

3. **Start:**

   ```bash
   docker compose up -d --build
   ```

4. **Volumes and backups.** The SQLite database lives in a Docker volume named `sqlite_data`; backups land in
   `backups`. Map either to host directories by editing the `volumes` section of `docker-compose.yml`.

5. **Reverse proxy (recommended).** Put RackMap behind Nginx, Caddy, or Traefik with TLS termination. The API and
   web UI are already combined behind the web container's Nginx config, so one upstream is enough.

### Bare metal / VPS

```bash
# Build
pnpm build

# Option A — PM2
pm2 start ecosystem.config.cjs

# Option B — systemd
sudo cp server-inventory.service /etc/systemd/system/
sudo systemctl enable --now server-inventory
```

Set `DATABASE_URL=file:/var/lib/rackmap/inventory.db` and make sure the directory exists and is writable by the service user.

### Using PostgreSQL instead of SQLite

1. In `apps/api/prisma/schema.prisma`, change `provider = "sqlite"` to `provider = "postgresql"`.
2. Set the connection string in `.env`:

   ```env
   DATABASE_URL="postgresql://rackmap:rackmap123@localhost:5432/rackmap?schema=public"
   ```

3. Run migrations:

   ```bash
   pnpm --filter @inv/api prisma migrate dev --name baseline
   ```

4. With Docker Compose, start the optional `postgres` profile:

   ```bash
   docker compose --profile postgres up -d --build
   ```

### Backups

Set `BACKUP_DIR` to enable automatic SQLite backups (mounted at `/backups` in Docker). Manual backup:

```bash
sqlite3 /data/inventory.db ".backup '/backups/inventory-$(date +%Y%m%d).db'"
```

---

## 🧑‍💻 Development

**Prerequisites:** Node.js 22+, pnpm 10+

```bash
# Install dependencies
pnpm install

# Generate the Prisma client and apply migrations
pnpm --filter @inv/api db:generate
pnpm --filter @inv/api db:migrate

# Start API and web together
pnpm dev
#   API → http://localhost:3000
#   Web → http://localhost:5173
```

| Command | What it does |
|---------|--------------|
| `pnpm dev` | Run API and web in watch mode |
| `pnpm build` | Build every workspace for production |
| `pnpm typecheck` | `tsc --noEmit` across all workspaces |
| `pnpm test` | Run unit tests (Vitest) |
| `pnpm e2e` | Run Playwright end-to-end tests |
| `pnpm e2e:ui` | Playwright in interactive UI mode |
| `pnpm db:studio` | Open Prisma Studio |

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, commit conventions, and the PR checklist.

---

## 🧭 Customer Portal (`/portal`)

RackMap ships with a public product portal at `/portal`:

- **Product showcase** — agentless SSH architecture, zero-knowledge vault, kernel-level ATOP analysis
- **Interactive mock console** — simulated server fleet, ATOP replay, vault unlock, and remote OS user audit
- **Pricing matrix** — monthly vs. annual toggle across Free, Professional, and Enterprise tiers
- **Self-hosting quickstart** — a copyable `docker-compose.yml` snippet
- **FAQ** — zero-knowledge encryption, air-gapped activation, supported Linux distributions

## 💳 Licensing Tiers (Licencia)

Subscription entitlements are backed by [Licencia](https://github.com/deziss/licencia). RackMap runs fully
functional without it — the Free Community Edition is the default when no license is configured.

| Feature / limit | Free Community | Pro | Enterprise |
|---|:---:|:---:|:---:|
| Max managed servers | 10 | 100 | Unlimited |
| Server & service inventory | ✓ | ✓ | ✓ |
| SSH terminal | ✓ | ✓ | ✓ |
| Hardware auto-discovery | — | ✓ | ✓ |
| ATOP historical replay | — | ✓ | ✓ |
| Remote OS user & sudoers fleet | — | ✓ | ✓ |
| Automated system updates | — | ✓ | ✓ |
| Multi-channel alert dispatchers | — | ✓ | ✓ |

Manage licenses in **Settings → Subscription & Licensing**: view node quota usage, activate an online key, or paste
an offline signed Ed25519 lease token.

---

## 🔄 CI/CD & Container Images

Two GitHub Actions workflows ship with the repository:

- **[`ci.yml`](.github/workflows/ci.yml)** — typecheck, test, and build on every push to `main` and every PR
- **[`docker-publish.yml`](.github/workflows/docker-publish.yml)** — build and publish multi-stage production images

| Trigger | Result |
|---------|--------|
| Push to `main` | Images tagged `latest` and `sha-<commit>` |
| Git tag `v*.*.*` | Images tagged with the semantic version (`1.0.0`, `1.0`) |
| Pull request | Test build of both containers, nothing pushed |
| Manual dispatch | Choose target registries via `push_to_dockerhub` / `push_to_ghcr` |

**Registries**

- **GHCR** — zero configuration via `GITHUB_TOKEN`. Images: `ghcr.io/<owner>/rackmap/api` and `ghcr.io/<owner>/rackmap/web`
- **Docker Hub** — enabled when `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository secrets are set

---

## 🤝 Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and please read our
[Code of Conduct](CODE_OF_CONDUCT.md).

- 🐛 [Report a bug](https://github.com/deziss/rackmap/issues/new?template=bug_report.yml)
- 💡 [Request a feature](https://github.com/deziss/rackmap/issues/new?template=feature_request.yml)
- 🔒 [Report a vulnerability](SECURITY.md) — privately, please

---

## 📄 License

RackMap is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.
See [LICENSE](LICENSE) for the full text.

In short: you may use, modify, and self-host RackMap freely. If you run a modified version as a
network service, you must make your source available to its users under the same license.
