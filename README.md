<div align="center">

# RackMap

**Agentless infrastructure inventory, monitoring, automation, and access control — for bare metal, cloud, and everything in between.**

Track every server, service, and certificate you own. Watch live CPU, memory, disk, network, and GPU metrics over plain SSH.
Edit crontabs, run runbooks across the fleet, manage Linux accounts and systemd units, catch configuration drift, and keep a
complete audit trail — **without installing a single agent on a target host.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/deziss/rackmap?sort=semver)](https://github.com/deziss/rackmap/releases)
[![CI](https://github.com/deziss/rackmap/actions/workflows/ci.yml/badge.svg)](https://github.com/deziss/rackmap/actions/workflows/ci.yml)
[![Docker Publish](https://github.com/deziss/rackmap/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/deziss/rackmap/actions/workflows/docker-publish.yml)
[![GHCR](https://img.shields.io/badge/GHCR-ghcr.io%2Fdeziss%2Frackmap-24292e?logo=github)](https://github.com/deziss/rackmap/pkgs/container/rackmap%2Fapi)
[![PostgreSQL 18](https://img.shields.io/badge/PostgreSQL-18-336791?logo=postgresql&logoColor=white)](#-deployment)
[![Self-hosted](https://img.shields.io/badge/deploy-self--hosted-0db7ed?logo=docker&logoColor=white)](#-quick-start)

[Quick Start](#-quick-start) · [What's New](#-whats-new-in-10) · [Features](#-features) · [User Guide](USER_GUIDE.md) · [Configuration](#%EF%B8%8F-configuration) · [Deployment](#-deployment) · [API](#-api-overview) · [Upgrading](MIGRATION.md) · [Contributing](CONTRIBUTING.md)

![RackMap dashboard — fleet overview with live status, environment split, project allocation, and GPU inventory](docs/screenshots/dashboard.png)

</div>

---

## Why RackMap?

Most infrastructure tools want an agent on every box. That means a rollout, a package to maintain, a daemon to
patch, and a security review before you can see a single CPU graph.

RackMap takes the opposite approach. **It connects over SSH, runs what it needs, parses the output, and disconnects.**
Nothing is installed on the machines you manage. That makes it a good fit for:

- **Mixed fleets** — bare metal, VMs, and cloud instances side by side, on standard or non-standard SSH ports
- **GPU and AI infrastructure** — NVIDIA, AMD, and Intel accelerators, plus vLLM / Ollama / llama.cpp endpoints as first-class inventory
- **Environments you don't fully control** — customer hardware, colo racks, or hosts where installing an agent is not an option
- **Teams that need an audit trail** — inventory changes, access approvals, credential reveals, root actions and auth events are recorded with before/after state

| | |
|---|---|
| **No agents** | Plain SSH. Nothing to install, patch, or roll back on target hosts. |
| **Credentials encrypted at rest** | AES-256-GCM, plus an optional envelope-encryption vault (PBKDF2 → KEK → DEK) whose passphrase is never stored in the database. |
| **RBAC + approvals** | admin / editor / viewer, request-and-approve for SSH and password reveal, and a second admin to approve sensitive runbook runs. |
| **Self-hosted, AGPL-3.0** | Your inventory stays on your infrastructure. One `docker compose up`, PostgreSQL 18 included. |

---

## 🆕 What's new in 1.0

RackMap 1.0 turns the inventory into an operations console and settles on one database.

- **PostgreSQL 18 only.** SQLite support is gone. Docker Compose runs PostgreSQL for you (set `POSTGRES_PASSWORD`),
  and scheduled `pg_dump` backups are built in. **Upgrading from 0.8.x has breaking changes — read
  [MIGRATION.md](MIGRATION.md) first.**
- **Agentless automation:** a per-server cron editor, cron heartbeat monitoring, runbooks with fleet execution and
  two-person approval, a systemd Services tab, patch management, drift detection, and time-boxed access grants.
- **Alert channels:** Slack, Microsoft Teams, Discord, PagerDuty, Telegram, email, and HMAC-signed webhooks, with
  retries and a delivery log. SSL certificates are scanned daily and alert 30, 14, 7, and 1 days before expiry.
- **Prometheus service discovery** (`/api/v1/prometheus/sd`), more exporter series, and a Grafana dashboard in
  [`contrib/`](contrib/README.md).
- **Fixes and hardening:** creating, editing, and deleting OS users no longer hangs. Editors can no longer grant
  root-equivalent access. OS-user dialogs ask for the sudo password when the stored one is stale. There is a new
  per-account sign-in limit. Status history is lighter and admins can clean it under **Settings → Maintenance**. The
  v0.8.0 nginx bug that left the Servers page empty is fixed.

The full list is in the [Changelog](CHANGELOG.md).

---

## ⚡ Quick Start

**Requirements:** Docker and Docker Compose. Nothing else.

```bash
# 1. Clone
git clone https://github.com/deziss/rackmap.git
cd rackmap

# 2. Create a Docker .env with generated secrets (never commit this file)
cat > .env <<EOF
NODE_ENV=production
PORT=8080
WEB_ORIGIN=http://localhost:8080
POSTGRES_PASSWORD=$(openssl rand -hex 24)
APP_ENCRYPTION_KEY=$(openssl rand -base64 32)
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
SEED_ADMIN_EMAIL=admin@example.com
SEED_ADMIN_PASSWORD=$(openssl rand -hex 12)
EOF
chmod 600 .env

# 3. Start (build on first run and after pulling updates)
docker compose up -d --build

# 4. Open http://localhost:8080
```

Sign in as `admin@example.com` with the generated password (`grep SEED_ADMIN_PASSWORD .env`). In production mode
the first start refuses to create the admin with a published default password or one shorter than 12 characters.
The first start also runs the database migrations, so give it a minute.

> **Don't copy `.env.example` wholesale for Docker.** Its `PORT`, `NODE_ENV`, and `WEB_ORIGIN` are local-development
> values (API on 3000, Vite on 5173). Compose reads `.env` too, so copying them would publish the UI on port 3000, run
> in development mode with demo accounts, and reject sign-ins from the wrong origin. Copy only the settings you need;
> every one is documented in [Configuration](#%EF%B8%8F-configuration).

- **Port 5432 already in use?** The bundled PostgreSQL is published on `127.0.0.1:5432`. Add `POSTGRES_HOST_PORT=5433`
  (or any free port) to `.env`.
- **Reaching RackMap by another name or port?** Set `WEB_ORIGIN` to that URL. If you use several, list them all in
  `TRUSTED_ORIGINS`.
- **Using cron heartbeats?** Set `PUBLIC_BASE_URL` to an address your managed hosts can reach.

Next steps: [add your first server](USER_GUIDE.md#adding-a-server),
[enable the SSH terminal](#optional--ssh), or [set up alert channels](USER_GUIDE.md#alert-channels--notifications).

---

## 📚 Documentation

| Document | What's in it |
|----------|--------------|
| **[User Guide](USER_GUIDE.md)** | Day-to-day usage: every page, every feature, roles, troubleshooting |
| **[Upgrading & migration](MIGRATION.md)** | Upgrading 0.8.x → 1.0.0 (breaking changes), SQLite → PostgreSQL, moving to a new server, backups & restore |
| **[Configuration](#%EF%B8%8F-configuration)** | Every environment variable, with defaults |
| **[Encryption Guide](#-encryption--credential-vault)** | At-rest encryption, the credential vault, passphrase recovery |
| **[Deployment](#-deployment)** | Docker Compose, external PostgreSQL, bare metal / PM2 / systemd, backups |
| **[API Overview](#-api-overview)** | REST endpoints and required roles |
| **[Integrations](contrib/README.md)** | Ansible dynamic inventory, Prometheus scrape config and service discovery, Grafana dashboard |
| **[Contributing](CONTRIBUTING.md)** | Dev setup, tests, migrations, branch and commit conventions, PR checklist |
| **[Security Policy](SECURITY.md)** | Supported versions and how to report a vulnerability |
| **[Changelog](CHANGELOG.md)** | What changed in each release |

---

## ✨ Features

<details open>
<summary><b>Inventory & topology</b></summary>

- **Server CRUD & specifications** — hostname, IP, SSH port (standard and non-standard, e.g. 7722), credentials (AES-256-GCM encrypted at rest), tags, and metadata with dedicated columns for CPU, RAM, storage, OS, and hardware accelerators (H100, H200, RTX PRO 6000, RTX 4090)
- **Service-first multi-hosting model** — track microservices and applications by runtime environment: `server` (host-native systemd services such as Mattermost, Jenkins, GitLab, Zabbix), `docker` (containerized workloads), and `k8s` (Kubernetes deployments with NodePort tracking)
- **AI model & inference topology** — first-class tracking for vLLM, Ollama, and llama.cpp deployments with designated ports, host bindings, and AES-256-GCM encrypted API bearer tokens
- **Backup policy tracking** — backup script paths, destination storage (NVMe, central NFS), cron schedules, retention windows, and data categories
- **Lookup tables** — Cloud Provider, GPU Type, Allocated To, Location, Server Type, and Network Type dropdowns, all admin-managed
- **Hardware auto-discovery** — detect and persist CPU, RAM, storage, and OS over SSH in one click
- **Import / export** — Excel import with column mapping and dry run; Excel and JSON export that respects the active search filter; PDF and JSON reports

</details>

<details open>
<summary><b>Monitoring & observability</b></summary>

- **Live status monitoring** — TCP probe on a configurable interval, with alerts to every configured channel. History is sampled (a row per status change, otherwise one per 15 minutes) and capped, and admins can review and clean it under **Settings → Maintenance**
- **Agentless live metrics** — CPU load, memory, disk, network I/O, and per-process tables, collected via a single SSH exec
- **Multi-vendor GPU metrics** — NVIDIA (`nvidia-smi`), AMD sysfs (`amdgpu`), AMD ROCm (`rocm-smi`), and Intel (`xpu-smi`)
- **Forensic logs & storage footprint** — query `journalctl`, syslog, `auth.log`, and kernel `dmesg` with live `/var/log` size and journal disk usage badges, evidence search, auto-refresh (5s / 10s / 30s / 60s / manual), and `.log` export
- **ATOP historical replay** — browse historical activity dates and interval snapshots, and extract top CPU / memory / disk processes per interval
- **SSL certificate monitoring** — auto-discovered and manual domains, wildcard support, expiry badges, and a daily scan that alerts 30, 14, 7, and 1 days before expiry
- **Prometheus** — a fleet exporter at `/api/v1/metrics`, `http_sd_configs` service discovery at `/api/v1/prometheus/sd`, and a ready-made scrape config and Grafana dashboard

</details>

<details open>
<summary><b>Automation</b></summary>

- **Cron job editor** — view and edit every crontab on a host (user crontabs, `/etc/crontab`, `/etc/cron.d`) from the server page, with a schedule builder, plain-English descriptions, next run times in the host's time zone, a raw editor, diff preview before saving, and "run now". Saves are refused if the file changed on the host since you loaded it, and the previous version is backed up on the host. systemd timers are listed read-only
- **Cron heartbeat monitoring** — one switch wraps a cron job so it checks in with RackMap after every run; a missed, late, or failing run raises an alert. Heartbeats also work for anything that can call a URL (systemd `OnFailure=`, Kubernetes CronJobs, scripts)
- **Runbooks** — saved, parameterised scripts run across a set of servers chosen by tag, environment, location, or name, with a target preview, dry run, per-host live output, cancel/rerun, schedules, and a two-person approval step for root or sensitive runs
- **Alert channels** — Slack, Microsoft Teams, Discord, PagerDuty, Telegram, email, and signed webhooks, each subscribing to the events it cares about, with retries, a delivery log, and a test button. PagerDuty incidents open and resolve automatically
- **systemd services** — a Services tab per server lists units with their state and boot setting, shows details and the journal, and can start/stop/restart/reload/enable/disable them. Protected units (SSH, networking, D-Bus, Docker, systemd-*, targets, mounts) need an admin
- **Patch management** — a nightly fleet scan (apt, dnf, yum, zypper) of pending and security updates, reboot-required hosts, and running vs installed kernel, with "scan now" and admin-only apply (security-only or all; never reboots)
- **Drift detection** — nightly snapshots of accounts, privileged group members, sudoers rules, crontabs, listening ports, enabled units, and authorized SSH keys, compared with an accepted baseline; a new root key, sudoers rule, uid-0 account or privileged member is flagged critical
- **Time-boxed access** — temporary OS accounts and SSH keys that RackMap locks, deletes, or removes at expiry, with the expiry also enforced on the host (`chage`, and `expiry-time` on OpenSSH 8.2+)
- **Automated system updates** — check, enable, disable, or remove `unattended-upgrades` per server

</details>

<details open>
<summary><b>Access & security</b></summary>

- **RBAC** — admin / editor / viewer roles via Better Auth, with two-factor authentication (TOTP) and scoped API keys
- **Access requests** — viewers and editors request SSH access or password reveal; admins approve with an expiry window
- **Credential vault** — envelope encryption (PBKDF2, 100k iterations, SHA-512) where the master passphrase is never stored in the database. Unlocking sends the passphrase to the server, which performs the key derivation, so run RackMap behind TLS. Opting in to auto-unlock writes the passphrase to `.env` on the host
- **SSH dual-mode auth** — public key first, with automatic fallback to password and PAM keyboard-interactive; host keys are pinned per endpoint (`SSH_HOST_POLICY`)
- **Browser SSH terminal** — full xterm.js terminal over WebSocket, admin-only, off by default behind `SSH_ENABLED`
- **OS user & sudoers management** — create, update, lock/unlock, and delete Linux accounts with full options (`-m`, `-r`, custom shells, secondary groups, custom UID/GID, sudoers rules). Root work runs as an uploaded script with sudo probed first, so the password never appears on the remote command line. Editors cannot grant sudo or privileged groups or touch root-equivalent accounts. If sudo rejects the stored password, the dialog asks for it once, and the password is never stored
- **Sign-in protection** — per-IP and per-account sign-in rate limits
- **Audit log** — every data mutation, root action, and auth event with actor, IP, and a before/after JSON diff viewer

</details>

<details open>
<summary><b>Workflow & UX</b></summary>

- **Universal pagination** — rows-per-page selector (10 / 25 / 50 / 100), range display, and numbered pages across every table
- **Saved views** — save and reuse server-list filters
- **Customer portal** — a public dark-mode product showcase at `/portal` with an interactive mock console and pricing comparison
- **Single-command deploy** — `docker compose up` for production, with PostgreSQL 18 and nightly `pg_dump` backups included

</details>

---

## 🏗️ Architecture

```
apps/
  api/       Hono (Node.js 24) — REST API + WebSocket SSH, Prisma schema and migrations
  web/       React (Vite) — SPA served by Nginx in Docker
packages/
  shared/    Types, schemas, permissions, and constants shared between apps
contrib/     Ansible inventory, Prometheus config, Grafana dashboard
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

**Data flow — root actions** (OS users, cron, systemd, patches, drift, access grants, runbooks)

```
API opens SSH → uploads the script over stdin into a private temp file
  → probes `sudo -n` first; sends a password to sudo's stdin only if needed
  → runs the script, captures exit code and output, removes the temp file → audit log
```

### Tech stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 24 |
| API framework | [Hono](https://hono.dev) |
| ORM | [Prisma](https://prisma.io) |
| Database | PostgreSQL 18 |
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

All configuration is environment-driven. The authoritative list, with comments, is [`.env.example`](.env.example);
defaults below are the API's built-in defaults from `apps/api/src/env.ts`, with the Docker Compose value noted where
Compose overrides it.

**Where the file goes.** Docker Compose reads `.env` in the repository root. A bare-metal or development API reads
`apps/api/.env`, from its working directory. The systemd unit and PM2 config in this repository both point there.

**Docker Compose passes through only the variables listed under `services.api.environment` in
`docker-compose.yml`.** Every variable below is listed there except those marked **‡**, which only apply to bare-metal
installs. To pass another variable through, add it to that section as a bare key (e.g. `MY_VAR:`) and set the value
in `.env`.

### Required

| Variable | Description |
|----------|-------------|
| `BETTER_AUTH_SECRET` | Session-signing secret, at least 16 characters. Generate with `openssl rand -hex 32` |
| `APP_ENCRYPTION_KEY` *or* `APP_ENCRYPTION_PASSPHRASE` | Master key or passphrase for at-rest encryption (AES-256-GCM). Accepts a 32-byte base64 value (`openssl rand -base64 32`) or any passphrase of at least 8 characters |
| `POSTGRES_PASSWORD` | **Docker Compose.** Password for the bundled PostgreSQL. Compose refuses to start without it. It is embedded in a URL, so use URL-safe characters (`openssl rand -hex 24`) |
| `DATABASE_URL` | **Bare metal.** PostgreSQL 18 connection URL. Percent-encode special characters in the password |
| `SEED_ADMIN_PASSWORD` | Password for the first admin, created on an empty database only. With `NODE_ENV=production` it must be at least 12 characters and not a published default |

### Database & Docker Compose

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/server_inventory?schema=public` | Connection URL. In Compose it is built from `POSTGRES_*` (or `DOCKER_DATABASE_URL`) and any value in `.env` is ignored |
| `POSTGRES_USER` | `rackmap` | Compose: database role for the bundled PostgreSQL |
| `POSTGRES_DB` | `rackmap` | Compose: database name |
| `POSTGRES_HOST_PORT` | `5432` | Compose: host port the bundled PostgreSQL is published on. Change it if the host already runs PostgreSQL |
| `POSTGRES_BIND` | `127.0.0.1` | Compose: host address the database port is bound to. Keep it on loopback unless you need remote access |
| `DOCKER_DATABASE_URL` | — | Compose: use an external PostgreSQL 18 instead of the bundled one |
| `JOB_LOCK_TTL_MS` | `120000` | Lease TTL for background jobs, so that on multiple replicas each job runs on exactly one of them |

### Core & web

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` (Compose: `8080`) | Bare metal: the port the API listens on. **In Compose it is the host port for the web UI.** The API listens on 3001 inside the network |
| `NODE_ENV` | `development` (Compose: `production`) | `production` enables the seed's password check, skips demo data, and refuses unverified license keys |
| `WEB_ORIGIN` | `http://localhost:5173` (Compose: `http://localhost:8080`) | URL the web app is reached at, used for CORS and auth cookies |
| `TRUSTED_ORIGINS` | = `WEB_ORIGIN` | Comma-separated origins allowed to call the API. `*` reflects any origin and disables origin checks; use it only on a trusted private network |
| `BETTER_AUTH_URL` | `http://localhost:5173` (Compose: `http://api:3001`) | Base URL Better Auth uses. Compose sets it; bare metal usually matches `WEB_ORIGIN` |
| `PUBLIC_BASE_URL` | — | Externally reachable URL of this instance, such as `https://rackmap.example.com`. Managed hosts use it for heartbeat check-ins, and alerts use it for links. Leave it unset rather than empty |
| `SERVE_STATIC_DIR` ‡ | — | Bare metal: serve the built web app (`apps/web/dist`) from the API process |
| `SEED_ADMIN_EMAIL` | `admin@example.com` (Compose and `.env.example`) | First-run admin email |
| `SEED_DEMO_DATA` | `false` | Create demo accounts and sample servers. The demo accounts' credentials are published, so never enable it in production. Outside production, demo data is always seeded |
| `VAULT_PASSPHRASE` | — | Master credential-vault passphrase. When set, the vault unlocks at startup so background jobs can decrypt credentials |
| `VITE_API_URL` | — | Web build-time API base URL. Leave empty for same-origin via the proxy |
| `VITE_SECURITY_LOCK` | `false` | Web build argument (Compose): `true` disables copy and right-click in the UI |

### Authentication & rate limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_RATE_LIMIT_ENABLED` | `true` | Enable Better Auth rate limiting |
| `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW` | `200` / `60` | General auth requests per window (seconds) |
| `AUTH_LOGIN_RATE_LIMIT_MAX` / `AUTH_LOGIN_RATE_LIMIT_WINDOW` | `60` / `60` | Sign-in attempts per client IP per window |
| `AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX` / `AUTH_LOGIN_ACCOUNT_RATE_LIMIT_WINDOW` | `10` / `60` | Sign-in attempts per account (email) per window, whatever the source address |
| `ALLOW_SELF_SIGNUP` | `false` | Let anyone reaching the API create their own `viewer` account |
| `TRUST_PROXY` | `false` (Compose: `true`) | Honour `X-Forwarded-For` / `X-Real-IP`. Enable **only** behind a reverse proxy you control, because these headers set the audit-log IP and the rate-limit bucket |
| `TRUSTED_PROXY_CIDRS` | loopback + RFC 1918 | Comma-separated CIDRs of the proxies in front of RackMap (with `TRUST_PROXY`). Set it when a CDN or more than one proxy hop is in front |

### Scheduler & status history

| Variable | Default | Description |
|----------|---------|-------------|
| `SCHEDULER_ENABLED` | `true` | Enable the background probe scheduler |
| `PING_INTERVAL_MS` | `60000` | Probe frequency (minimum 5000) |
| `PING_TIMEOUT_MS` | `3000` | Per-server TCP probe timeout |
| `PING_CONCURRENCY` | `10` | Maximum simultaneous probes |
| `STATUS_FLIP_THRESHOLD` | `2` | Consecutive failures before the status changes |
| `STATUS_RETENTION_DAYS` | `30` | Days of probe history to keep |
| `STATUS_SAMPLE_INTERVAL_MS` | `900000` | Store a probe result only on a status change or once per interval (`0` = every probe) |
| `STATUS_MAX_ROWS` | `10000` | Cap on stored probe history across all servers; the oldest rows beyond it are pruned (`0` = no cap). Admins can also clean it under **Settings → Maintenance** |

### Backups

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKUP_DIR` | — (Compose: `/backups`) | Where `pg_dump` backups are written. Unset disables backups |
| `BACKUP_CRON` | `0 2 * * *` | 5-field cron, in the API process's local time zone (UTC in the Docker image) |
| `BACKUP_KEEP` | `14` | Number of newest `rackmap-*.dump` files kept |

### Live metrics & thresholds

| Variable | Default | Description |
|----------|---------|-------------|
| `METRICS_ENABLED` | `true` | Enable agentless SSH metrics collection |
| `METRICS_SSH_TIMEOUT_MS` | `10000` | SSH exec timeout for metrics collection |
| `METRICS_ALERT_ENABLED` | `true` | Send alerts when a threshold is crossed |
| `METRICS_ALERT_INTERVAL_MS` | `300000` | Minimum interval between repeat alerts (minimum 60000) |
| `ALERT_THRESHOLD_CPU` / `ALERT_THRESHOLD_RAM` / `ALERT_THRESHOLD_DISK` | `90` / `95` / `90` | Alert thresholds, in percent |

### Alert channels & notifications

Alert channels (Slack, Teams, Discord, PagerDuty, Telegram, email, webhooks) are managed by admins under
**Settings → Alerts**. The `NOTIFY_*` variables are still honoured and appear there as read-only channels.

| Variable | Default | Description |
|----------|---------|-------------|
| `ALERT_DISPATCH_ENABLED` | `true` | Run the alert delivery worker |
| `ALERT_DISPATCH_INTERVAL_MS` | `5000` | How often the delivery outbox is polled |
| `ALERT_OUTBOUND_TIMEOUT_MS` | `10000` | Timeout for each outbound delivery |
| `ALERT_OUTBOUND_ALLOW_PRIVATE` | `false` | Allow webhook targets on private address ranges. Link-local and cloud-metadata addresses are always refused |
| `ALERT_OUTBOUND_ALLOW_HTTP` | `false` | Allow plain-`http` webhook targets |
| `ALERT_OUTBOUND_ALLOWLIST` | — | Comma-separated hosts or CIDRs allowed despite the two rules above |
| `ALERT_DELIVERY_RETENTION_DAYS` | `30` | Days of delivery log to keep |
| `ALERT_MAX_EVENT_AGE_MS` | `21600000` | Events older than this (6 hours) are marked expired instead of being sent late |
| `SSL_SCAN_CRON` | `0 6 * * *` | Daily SSL certificate scan (API process local time) |
| `NOTIFY_WEBHOOK_URL` | — | Legacy HTTP POST target for up/down alerts (read-only channel) |
| `NOTIFY_TELEGRAM_BOT_TOKEN` / `NOTIFY_TELEGRAM_CHAT_ID` | — | Legacy Telegram bot and chat (read-only channel) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | — / `587` / — / — / `rackmap@example.com` | SMTP for email channels, email preferences, and certificate-expiry mail |

### Heartbeats, runbooks & ops automation

| Variable | Default | Description |
|----------|---------|-------------|
| `HEARTBEAT_SWEEP_INTERVAL_MS` | `30000` | How often late and missed heartbeats are detected |
| `HEARTBEAT_PING_KEEP` | `200` | Check-ins kept per heartbeat |
| `HEARTBEAT_PING_RETENTION_DAYS` | `30` | Days of check-ins kept |
| `HEARTBEAT_PING_MAX_BODY_BYTES` | `10240` | Largest check-in body stored (maximum 1 MiB) |
| `RUNBOOK_WORKER_ENABLED` | `true` | Run the runbook worker |
| `RUNBOOK_MAX_CONCURRENT_RUNS` | `2` | Runs executing at the same time |
| `RUNBOOK_MAX_SSH_SESSIONS` | `20` | SSH sessions across all runs |
| `RUNBOOK_MAX_TARGETS` | `500` | Largest target set a run may resolve to |
| `RUNBOOK_OUTPUT_MAX_BYTES` | `262144` | Output kept per host |
| `RUNBOOK_APPROVAL_TTL_HOURS` | `24` | Pending approvals expire after this many hours |
| `PATCH_SCAN_CRON` | `0 3 * * *` | Nightly fleet patch scan |
| `PATCH_SCAN_CONCURRENCY` | `5` | Hosts scanned at a time (1–50) |
| `DRIFT_SCAN_CRON` | `30 3 * * *` | Nightly configuration snapshot for drift detection |
| `DRIFT_SNAPSHOT_KEEP` | `30` | Snapshots kept per server (minimum 2) |
| `ACCESS_EXPIRY_SWEEP_INTERVAL_MS` | `60000` | How often expired access grants are revoked on their hosts |
| `PROMETHEUS_SD_DEFAULT_PORT` | `9100` | Scrape port advertised by `/api/v1/prometheus/sd` (node_exporter) |

### Optional — SSH

| Variable | Default | Description |
|----------|---------|-------------|
| `SSH_ENABLED` | `false` | Set to `true` to enable the browser SSH terminal (admin-only). This gates **only** the interactive terminal. Metrics, discovery, logs, ATOP, OS users, cron, systemd, patches, drift, access grants, and runbooks still run commands over SSH when it is `false` |
| `SSH_CONNECT_TIMEOUT_MS` | `10000` | SSH connection timeout |
| `SSH_IDLE_TIMEOUT_MS` | `300000` | Idle terminal timeout (5 minutes) |
| `SSH_MAX_SESSION_MS` | `3600000` | Maximum terminal session duration (1 hour) |
| `SSH_MAX_CONCURRENT` | `5` | Maximum simultaneous SSH terminal sessions |
| `SSH_REAUTH_INTERVAL_MS` | `60000` | How often a live terminal re-checks that the operator is still authorised |
| `SSH_HOST_POLICY` | `accept-any` | Host-key verification. `accept-any` pins keys and warns loudly on a change but still connects; `tofu` refuses the connection. See below |
| `SSH_PRIVATE_KEY_PATH` | — | Private key tried first. If unset, `/data`, `/root/.ssh`, and the API user's `~/.ssh` are probed |
| `DOCKER_HOST_OVERRIDE` / `HOST_GATEWAY` | — | Advanced: the address used when a server's IP is loopback and the API runs in a container. By default it is detected from `host.docker.internal` or the default route |

### SSH host-key verification

RackMap pins each endpoint's host key on first contact and compares it on every
later connection. Verification runs during key exchange, **before** any
credential is offered, so a changed key cannot harvest your password.

`accept-any` (the default) pins and warns but still connects — it exists so an
existing fleet can populate the store without an outage. `tofu` refuses.

**Migrating an existing fleet:**

1. Run on `accept-any` until every server has been contacted at least once. Servers that are never polled need a
   manual connection test, otherwise they are simply absent from the store.
2. Review what was pinned, and compare against the hosts themselves:
   ```bash
   curl -H "Authorization: Bearer sk_..." https://rackmap.example.com/api/v1/ssh-host-keys
   ssh <host> 'for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf $f; done'
   ```
   Fingerprints are standard OpenSSH `SHA256:` values, so they compare directly.

   Each entry carries `sharedWithOtherEndpoints`. Expected for a cluster built from one image, worth
   investigating otherwise — it means one key is answering for several addresses. Narrow it down with
   `?fingerprint=SHA256:...`.
3. Resolve anything unexpected, then set `SSH_HOST_POLICY=tofu` and restart.

After a legitimate rebuild or reimage, forget the pin so the next connection re-pins it. Admin only,
and audited with the fingerprint being discarded:

```bash
curl -X DELETE -H "Authorization: Bearer sk_..." \
  https://rackmap.example.com/api/v1/ssh-host-keys/<id>
```

A mismatch never overwrites the stored key — self-healing would erase the evidence.

### Optional — licensing & billing

| Variable | Default | Description |
|----------|---------|-------------|
| `LICENCIA_URL` | — (Compose: `http://host.docker.internal:3003`) | Base URL of the Licencia server |
| `LICENCIA_API_KEY` | — | Tenant API key (`lic_live_...`) |
| `LICENCIA_LICENSE_KEY` | — | Master license key (`LIC-PRO-...`), activated on startup |
| `LICENCIA_PUBLIC_KEY` | — | Ed25519 SPKI public key for offline, air-gapped token verification |
| `BILLING_MODE` | `disabled` | `disabled`: completing a checkout returns 501, and in production a license key is accepted only if Licencia can verify it. `simulated` marks orders paid without payment and accepts any key. Use it for local demos only |

### SSH dual-mode authentication

RackMap supports hybrid fleets where some hosts require key pairs and others enforce password or PAM authentication.

- **Automatic fallback** — public key first (`/data/id_ed25519` plus custom uploaded keys). If the target rejects the key, it falls back to password and PAM keyboard-interactive without failing.
- **Server detail controls** (`/servers/:id`) — *Test Key Login* (reports round-trip latency), *Test Password Login*, and *Set / Change Password*, which stores the credential encrypted in the vault.
- **Auto-prompt on auth failure** — if discovery, ATOP, logs, or metrics hit an unauthorized host, a password dialog appears and the operation retries.
- **Sudo password prompt** — root actions (OS users, cron, systemd) use the stored password only for `sudo`. If sudo rejects it, the dialog asks for the sudo password and retries once with an `X-Sudo-Password` header. The password is never stored or logged.

---

## 🔐 Encryption & Credential Vault

RackMap uses a two-tier cryptographic architecture to protect infrastructure credentials.

### Tier 1 — application at-rest encryption

Set `APP_ENCRYPTION_KEY` (or `APP_ENCRYPTION_PASSPHRASE`) in `.env`. It encrypts sensitive database fields —
server passwords, tokens, secrets — with AES-256-GCM.

```bash
# Recommended: maximum entropy
APP_ENCRYPTION_KEY=$(openssl rand -base64 32)

# Or a human-readable passphrase (a 32-byte AES key is derived from it)
APP_ENCRYPTION_PASSPHRASE="YourSecurePassphraseHere123!"
```

### Tier 2 — credential vault (envelope encryption)

Envelope encryption (`v2.<iv>.<tag>.<cipher>`) using PBKDF2 (100,000 iterations, SHA-512) to derive a 256-bit
key-encryption key that wraps an ephemeral 256-bit data-encryption key. **The master passphrase is never stored in the
database** — only a random salt and a verifier. Key derivation happens on the server, so the passphrase travels over
the connection on unlock: terminate TLS in front of RackMap. Option A below deliberately writes it to `.env`.

Three ways to unlock it:

| Option | Where | Best for |
|--------|-------|----------|
| **A — automated unlock** | `VAULT_PASSPHRASE` in `.env` | Production. Unlocks at API startup, so discovery, metrics, scheduled runbooks, patch and drift scans, and access-grant revocation can decrypt credentials unattended |
| **B — global unlock via UI** | **Settings → Vault Security** | Admins unlocking for the whole instance. Optionally tick *Keep unlocked permanently* (saves the passphrase to `.env`) to survive restarts |
| **C — ephemeral session** | Header of any server detail page | Per-operator, time-boxed unlock (30 minutes) |

### Changing or recovering the master passphrase

There are two distinct operations, and only one of them destroys data.

**Change the passphrase (safe).** Requires the current passphrase. The data-encryption key is re-wrapped under
the new passphrase, so every stored credential keeps working.

```bash
curl -X POST https://rackmap.example.com/api/v1/vault/reset \
  -H "Content-Type: application/json" \
  -H "Cookie: better-auth.session_token=<admin-session>" \
  -d '{"currentPassphrase":"OldPassphrase!","newPassphrase":"NewSecureMasterPassphrase!"}'
```

**Recover a forgotten passphrase (destructive).** Only when the current passphrase is genuinely lost. This mints
a brand-new data-encryption key.

```bash
curl -X POST https://rackmap.example.com/api/v1/vault/reset \
  -H "Content-Type: application/json" \
  -H "Cookie: better-auth.session_token=<admin-session>" \
  -d '{"newPassphrase":"NewSecureMasterPassphrase!","forceDestroy":true}'
```

> **`forceDestroy` is irreversible.** Every credential encrypted under the old passphrase becomes permanently
> unreadable and must be re-entered. A request that supplies neither `currentPassphrase` nor `forceDestroy` is
> rejected — the API will not guess which one you meant.

In the UI: **Settings → Vault Security → Reset / Change Passphrase**, **Security → Master Credential Vault**, or the
**Vault** badge in any server header.
The destructive path is behind an explicit checkbox.

---

## 🛡️ Security

- **Passwords encrypted at rest** — AES-256-GCM, keyed by `APP_ENCRYPTION_KEY`
- **Passwords never sent to the client** — `passwordEnc` fields are stripped from every API response
- **No passwords on remote command lines** — root scripts are uploaded over stdin; sudo passwords only reach sudo's stdin
- **SSH terminal off by default** — requires `SSH_ENABLED=true` *and* admin role (or an approved access request)
- **WebSocket auth** — the WS upgrade validates the Better Auth session, ban status, and RBAC before opening SSH
- **Outbound SSRF guard** — alert webhooks are pinned to the DNS-checked address, never follow redirects, and refuse private, link-local, and metadata addresses by default
- **Audit trail** — every write, root action, and auth event recorded with actor, IP, and before/after state
- **CORS** — locked to `WEB_ORIGIN` unless `TRUSTED_ORIGINS` says otherwise; set it explicitly in production
- **Non-root container** — the API image runs as `node` (uid 1000)

Found a vulnerability? Please follow our [Security Policy](SECURITY.md) — do not open a public issue.

---

## 👥 RBAC

Permissions are defined once in [`packages/shared/src/permissions.ts`](packages/shared/src/permissions.ts) and enforced
by the API; the UI hides what you cannot do.

| Permission | admin | editor | viewer |
|-----------|:-----:|:------:|:------:|
| View servers, services, SSL certificates, tags, lookups | ✓ | ✓ | ✓ |
| Create / update servers, services, and SSL entries | ✓ | ✓ | — |
| Delete / restore servers, services, and SSL entries | ✓ | — | — |
| Reveal SSH password | ✓ | ✓ | request |
| Probes, live metrics, logs, ATOP, hardware discovery | ✓ | ✓ | — |
| SSH terminal | ✓ | request | request |
| OS users: list, create, edit, lock, delete | ✓ | ✓ ¹ | — |
| Sudoers rules and privileged groups | ✓ | — | — |
| Cron editor | ✓ | ✓ ² | — |
| systemd services | ✓ | ✓ ³ | — |
| Patch report | ✓ | ✓ | ✓ |
| Patch scan | ✓ | ✓ | — |
| Apply patches | ✓ | — | — |
| Drift: view, scan, acknowledge | ✓ | ✓ | — |
| Drift: accept a new baseline | ✓ | — | — |
| Access grants: create; extend or revoke your own | ✓ | ✓ ¹ | — |
| Access grants: extend or revoke anyone's | ✓ | — | — |
| Heartbeats: view | ✓ | ✓ | ✓ |
| Heartbeats: create, edit, pause, rotate token | ✓ | ✓ | — |
| Heartbeats: delete | ✓ | — | — |
| Runbooks: view, preview targets, run, cancel, rerun | ✓ | ✓ ⁴ | — |
| Runbooks: author, edit, delete | ✓ | — | — |
| Runbooks: approve a run (not your own) | ✓ | — | — |
| Alert channels: view | ✓ | ✓ | — |
| Alert channels: manage, test, delivery log; server test alert | ✓ | — | — |
| Tags: create | ✓ | ✓ | — |
| Tags: delete | ✓ | — | — |
| Lookups: create / edit | ✓ | ✓ | — |
| Lookups: delete | ✓ | — | — |
| Vault: unlock for your session | ✓ | ✓ | — |
| Vault: initialise, global unlock, change passphrase | ✓ | — | — |
| Settings → Maintenance (status history) | ✓ | — | — |
| Users, license, checkout, audit log | ✓ | — | — |
| Approve access requests | ✓ | — | — |

¹ Not root, root-equivalent accounts (uid 0, a privileged group, or any sudoers rule), sudo, or privileged groups
(`sudo`, `wheel`, `admin`, `docker`, `lxd`, `disk`, `root`, `adm`, `shadow`, plus any group a `%group` sudoers rule or
gid 0 makes root-equivalent on that host).
² Ordinary users' crontabs only. Root's crontab, `/etc/crontab`, `/etc/cron.d`, and root-equivalent users need an admin.
³ Not protected units (SSH, networking, D-Bus, Docker, `systemd-*`, targets, mounts).
⁴ Root runs requested by editors, and runbooks marked *requires approval*, wait for a different admin to approve.

Viewers and editors submit access requests for the SSH terminal and password reveal; admins approve or reject with an
expiry window. Several features also need a Pro license — see [Licensing tiers](#-licensing-tiers-licencia).

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

Every endpoint requires an authenticated Better Auth session cookie or an `Authorization: Bearer sk_…` API key,
except `/health/*`, `/api/auth/*`, `/api/v1/public/config`, and the heartbeat check-in `/api/v1/ping/:token`.
Role notes below are the minimum role; "Pro" marks a license feature. Root actions accept an optional
`X-Sudo-Password` header (never stored) when the stored password is rejected by sudo.

```
# Auth
POST   /api/auth/sign-in/email
POST   /api/auth/sign-out

# Servers
GET    /api/v1/servers                     List + search + paginate (page, limit)
POST   /api/v1/servers                     Create (editor+)
GET    /api/v1/servers/:id                 Detail
PATCH  /api/v1/servers/:id                 Update (editor+)
DELETE /api/v1/servers/:id                 Soft-delete (admin)
POST   /api/v1/servers/:id/restore         Restore a soft-deleted server (admin)
POST   /api/v1/servers/:id/reveal-password Reveal the SSH password (editor+, or an approved request; audited)
GET    /api/v1/servers/:id/status-history  Recent probe results
POST   /api/v1/servers/:id/check           Probe now (editor+)
POST   /api/v1/servers/check-all           Probe every server now (editor+)
GET    /api/v1/servers/:id/metrics         Live SSH metrics (editor+)
POST   /api/v1/servers/:id/auto-discover   Detect and persist CPU, RAM, storage, OS (editor+, Pro)
POST   /api/v1/servers/:id/recalculate-storage   (editor+)
GET|POST /api/v1/servers/:id/auto-update   unattended-upgrades status / enable, disable, remove (editor+; POST is Pro)
POST   /api/v1/servers/:id/ssh-keys/test   Test key login (editor+)
GET    /api/v1/servers/:id/alert-channels  Channels routed to this server (editor+)
POST   /api/v1/servers/:id/test-alert      Queue a test event for those channels (admin)
POST   /api/v1/servers/import              Excel import, with dryRun (editor+)
GET    /api/v1/servers/export.xlsx         Export to Excel
GET    /api/v1/servers/export.json         Export to JSON
WS     /api/v1/servers/:id/ssh             Browser terminal (SSH_ENABLED; admin or approved request)

# OS users & sudoers (editor+; create/update/delete are Pro)
GET    /api/v1/servers/:id/os-users              List accounts, UIDs, shells, groups, sudo privileges
POST   /api/v1/servers/:id/os-users              Create a Linux user
PATCH  /api/v1/servers/:id/os-users/:username    Update shell, home, groups, password, lock state, sudo rules
DELETE /api/v1/servers/:id/os-users/:username    Delete a user (root/SSH safeguards apply)
POST   /api/v1/servers/:id/os-users/sudo         Atomic sudoers update (/etc/sudoers.d/rackmap_*) (admin)
# Granting sudo or a privileged group, or touching a root-equivalent account, requires admin.

# Cron (editor+; saving and run-now are Pro; root, /etc/crontab, /etc/cron.d and root-equivalent users need admin)
GET    /api/v1/servers/:id/cron                  All crontabs + systemd timers on the host
PUT    /api/v1/servers/:id/cron                  Replace one crontab (compare-and-set on its hash)
POST   /api/v1/servers/:id/cron/run              Run one entry now as its user
POST   /api/v1/servers/:id/cron/monitor          Wrap an entry with a heartbeat (Pro)
POST   /api/v1/servers/:id/cron/unmonitor        Remove the heartbeat wrapper (Pro)

# Heartbeats
GET|POST       /api/v1/heartbeats                List (all roles) / create (editor+)
GET    /api/v1/heartbeats/config                 Ping base URL (null until PUBLIC_BASE_URL is set)
GET|PATCH|DELETE /api/v1/heartbeats/:id          Detail, update (editor+), delete (admin)
GET    /api/v1/heartbeats/:id/pings              Recent check-ins
POST   /api/v1/heartbeats/:id/{pause,resume,rotate-token}   (editor+)
GET|POST /api/v1/ping/:token[/start|/fail|/log|/<exit code>]   Check-in (no auth — the token is the credential)

# Runbooks (Pro)
GET|POST       /api/v1/runbooks                  List (editor+) / create (admin)
GET|PATCH|DELETE /api/v1/runbooks/:id            Detail (editor+), update, soft-delete (admin)
POST   /api/v1/runbooks/:id/preview-targets      Resolve the target servers first (editor+)
POST   /api/v1/runbooks/:id/runs                 Start a run (editor+; root runs by editors need approval)
GET    /api/v1/runbook-runs[/:id]                Run history and per-host status
GET    /api/v1/runbook-runs/pending-count        Runs awaiting approval (admin)
GET    /api/v1/runbook-runs/:id/hosts/:serverId/output   Incremental output
POST   /api/v1/runbook-runs/:id/{approve,reject}  (admin, not the requester)
POST   /api/v1/runbook-runs/:id/{cancel,rerun}    (editor+)

# Alert channels (admin; editors can list and view)
GET|POST       /api/v1/alert-channels
POST   /api/v1/alert-channels/test               Test an unsaved configuration
GET|PATCH|DELETE /api/v1/alert-channels/:id
POST   /api/v1/alert-channels/:id/test
GET    /api/v1/alert-channels/:id/deliveries     Delivery log (admin)
GET    /api/v1/alert-events                      Alert events (admin)

# systemd (editor+; actions are Pro; protected units need admin)
GET    /api/v1/servers/:id/systemd/units[/:unit[/logs]]
POST   /api/v1/servers/:id/systemd/units/:unit/action   {action: start|stop|restart|reload|enable|disable}

# Patches
GET    /api/v1/patches[/summary]                     Fleet report (all roles)
POST   /api/v1/patches/scan                          Queue scans (editor+, Pro)
GET    /api/v1/servers/:id/patches
POST   /api/v1/servers/:id/patches/scan              (editor+, Pro)
POST   /api/v1/servers/:id/patches/apply             {mode: security|all} (admin, Pro)

# Drift (editor+; scans are Pro; accepting a baseline needs admin)
GET    /api/v1/drift/events | /api/v1/drift/summary
POST   /api/v1/drift/events/:id/acknowledge
GET    /api/v1/servers/:id/drift
POST   /api/v1/servers/:id/drift/{scan,baseline}

# Access grants (editor+, Pro; root or privileged targets need admin)
GET    /api/v1/access-grants[/:id]
POST   /api/v1/access-grants/{users,keys}            Temporary account / SSH key
POST   /api/v1/access-grants/:id/{extend,revoke}     Creator or admin

# Status history (admin)
GET    /api/v1/status-history/stats
POST   /api/v1/status-history/prune                  {olderThanDays?, keepNewest?}

# Prometheus (session or API key; viewer is enough)
GET    /api/v1/metrics                                Exporter
GET    /api/v1/prometheus/sd                          http_sd_configs targets

# Logs & ATOP forensics (editor+; ATOP history is Pro)
POST   /api/v1/servers/:id/logs                  Query journalctl/syslog by priority and unit
GET    /api/v1/servers/:id/atop/dates            List historical ATOP activity dates
POST   /api/v1/servers/:id/atop/snapshots        Query ATOP interval snapshots
POST   /api/v1/servers/:id/atop/interval-processes   Processes in one interval
POST   /api/v1/servers/:id/atop/top-processes    Top CPU/memory/disk processes per interval

# Services (same permission model as servers)
GET|POST       /api/v1/services
GET|PATCH|DELETE /api/v1/services/:id
POST   /api/v1/services/:id/{restore,reveal-password,check}
POST   /api/v1/services/check-all
POST   /api/v1/services/import  ·  GET /api/v1/services/export.{xlsx,json}

# SSL certificates
GET    /api/v1/ssl
POST   /api/v1/ssl                        Add a domain (editor+)
PATCH  /api/v1/ssl/:id                    (editor+)
DELETE /api/v1/ssl/:id                    (admin)
POST   /api/v1/ssl/:id/restore            (admin)
POST   /api/v1/ssl/scan | /api/v1/ssl/:id/scan   Scan now (editor+)

# SSH keys and host keys
GET|POST /api/v1/ssh-keys                 Custom private keys tried before password auth (editor+)
DELETE /api/v1/ssh-keys/:id               (admin)
POST   /api/v1/ssh-keys/test-server/:serverId   (editor+)
GET    /api/v1/ssh-host-keys              Review pinned host keys (editor+); ?serverId= / ?fingerprint=
DELETE /api/v1/ssh-host-keys/:id          Forget a pin so the next connection re-pins (admin, audited)

# Credential vault
GET    /api/v1/vault/status
POST   /api/v1/vault/unlock | /api/v1/vault/lock          Your session (unlock: editor+)
POST   /api/v1/vault/{init,unlock-global,lock-global,reset}   (admin)

# Lookup tables — :type is cloud-providers, gpu-types, allocated-to, locations, server-types, network-types
GET    /api/v1/lookups/:type              (all roles)
POST   /api/v1/lookups/:type              (editor+)
PATCH  /api/v1/lookups/:type/:id          (editor+)
DELETE /api/v1/lookups/:type/:id          (admin)

# Tags
GET    /api/v1/tags  ·  POST /api/v1/tags (editor+)  ·  DELETE /api/v1/tags/:id (admin)

# Users (admin) — listing and creation go through Better Auth's admin API
PATCH  /api/v1/users/:id
POST   /api/v1/users/:id/set-password
POST   /api/v1/users/:id/ban
POST   /api/v1/users/:id/unban
PATCH  /api/v1/users/:id/role
DELETE /api/v1/users/:id

# Access requests
POST   /api/v1/access-requests
GET    /api/v1/access-requests            Admin: all; others: their own
GET    /api/v1/access-requests/check      Does the caller hold an approval for a server/service?
GET    /api/v1/access-requests/pending-count   (admin)
PATCH  /api/v1/access-requests/:id        Approve or reject (admin)
DELETE /api/v1/access-requests/:id        (admin)

# API keys, saved views, current user
GET|POST /api/v1/api-keys  ·  DELETE /api/v1/api-keys/:id
GET|POST /api/v1/views  ·  PATCH|DELETE /api/v1/views/:id
GET    /api/v1/me  ·  GET|PATCH /api/v1/me/preferences

# License & checkout
GET    /api/v1/license
POST   /api/v1/license/{activate,deactivate}     (admin)
GET    /api/v1/checkout/plans
POST   /api/v1/checkout/session                  (admin)
POST   /api/v1/checkout/complete                 (admin; 501 unless BILLING_MODE=simulated)
GET    /api/v1/checkout/orders[/:id]

# Audit
GET    /api/v1/audit                  Paginated audit log (admin, cursor-based)

# Health
GET    /health/live                   {"status":"ok"} while the process is up
GET    /health/ready                  Database check (503 when unreachable) + backup status
```

---

## 🚀 Deployment

### Docker Compose (recommended)

1. **Prepare the environment.** Create `.env` as in the [Quick Start](#-quick-start). `POSTGRES_PASSWORD` is required
   and Compose refuses to start without it. It is embedded in a connection URL, so use URL-safe characters
   (`openssl rand -hex 24` does). For a public deployment also set:

   ```ini
   WEB_ORIGIN=https://rackmap.example.com
   PUBLIC_BASE_URL=https://rackmap.example.com   # needed for cron heartbeats
   ```

2. **Pick ports.** The web UI is published on `8080` by default; override with `PORT`. PostgreSQL is published on
   `127.0.0.1:5432`; override with `POSTGRES_HOST_PORT` if the host already runs PostgreSQL.

3. **Start:**

   ```bash
   docker compose up -d --build
   docker compose ps          # postgres, api and web should become "healthy"
   ```

   The API container runs migrations (`prisma migrate deploy`) and the seed on every start. The seed only acts on an
   empty database.

4. **Volumes.**

   | Volume | Mounted at | Holds |
   |--------|-----------|-------|
   | `pgdata` | `/var/lib/postgresql` (postgres) | The PostgreSQL 18 data directory |
   | `backups` | `/backups` (api) | Nightly `pg_dump` backups |
   | `sqlite_data` | `/data` (api) | SSH keys, plus the old `inventory.db` on installs upgraded from SQLite. The name is kept so an upgrade does not detach your keys |

   The API runs as the non-root `node` user (uid 1000). A volume first created by a root-run image (before 0.7), or
   files copied into it as root, must be handed over once:

   ```bash
   docker run --rm --user root -v <project>_sqlite_data:/data <api-image> chown -R node:node /data
   ```

   `<project>` is the Compose project name (the directory name by default) and `<api-image>` is the image shown by
   `docker compose images api`.

5. **Reverse proxy (recommended).** Put RackMap behind Nginx, Caddy, or Traefik with TLS termination. The API and
   web UI are already combined behind the web container's Nginx, so one upstream (`PORT`) is enough. Give the SSH
   terminal path WebSocket upgrade headers, and allow long reads: RackMap's own Nginx gives the terminal 24 hours and
   host actions such as patch apply 30 minutes.

**External PostgreSQL.** Set `DOCKER_DATABASE_URL=postgresql://rackmap:<password>@db.example.com:5432/rackmap`. The
bundled `postgres` service still starts and still needs `POSTGRES_PASSWORD`, but the API does not use it.

**Updating.** `git pull && docker compose up -d --build`. Always rebuild both images: the web image carries the Nginx
configuration.

### Bare metal / VPS

**Requirements:** Node.js 24, pnpm 10 (`corepack enable pnpm`), PostgreSQL 18, and `postgresql-client-18` if you want
backups.

```bash
# 1. Database
sudo -u postgres psql -c "CREATE ROLE rackmap WITH LOGIN PASSWORD '<strong-password>';"
sudo -u postgres psql -c "CREATE DATABASE rackmap OWNER rackmap;"

# 2. Configuration — the API reads .env from its working directory
cp .env.example apps/api/.env
#    then set at least: NODE_ENV=production, DATABASE_URL, APP_ENCRYPTION_KEY, BETTER_AUTH_SECRET,
#    SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, WEB_ORIGIN, BETTER_AUTH_URL, PORT
#    and optionally BACKUP_DIR=/backups, SERVE_STATIC_DIR=<repo>/apps/web/dist

# 3. Build, migrate, seed
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @inv/api db:deploy
(cd apps/api && node dist/seed.js)

# 4a. PM2
pm2 start ecosystem.config.cjs

# 4b. or systemd (expects the checkout at /opt/server-inventory; edit User= and paths to suit)
sudo cp server-inventory.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now server-inventory
```

A typical `DATABASE_URL` is `postgresql://rackmap:<password>@127.0.0.1:5432/rackmap?schema=public`. Either serve
`apps/web/dist` with your own web server and proxy `/api/` and `/health/` to the API, or set `SERVE_STATIC_DIR` to
let the API serve it. [MIGRATION.md](MIGRATION.md#option-b-bare-metal--systemd-deployment-host-postgresql-18) has a
full walkthrough, including the PostgreSQL 18 apt repository and an Nginx example.

### Upgrading from 0.8.x (and from SQLite)

1.0.0 has breaking changes. SQLite is gone, `POSTGRES_PASSWORD` is now required, and some permissions and license
checks have moved. Follow the checklist in [MIGRATION.md](MIGRATION.md#upgrading-08x--100) before pulling the new
images. It covers copying an existing SQLite database into PostgreSQL with
`pnpm --filter @inv/api db:migrate:postgres`.

### Backups & restore

With `BACKUP_DIR` set (Compose sets it to `/backups`), the API writes `pg_dump --format=custom` backups named
`rackmap-<timestamp>.dump` on `BACKUP_CRON` (default `0 2 * * *`) and keeps the newest `BACKUP_KEEP` (default 14).
The API image includes the PostgreSQL 18 client. `/health/ready` reports the last backup as `backup.status`
(`ok`, `degraded` with a reason, or `disabled`) without failing readiness.

Restore into the bundled database (stop the API first so nothing writes during the restore):

```bash
docker compose cp api:/backups/rackmap-<timestamp>.dump ./restore.dump
docker compose stop api
docker compose exec -T postgres pg_restore -U rackmap -d rackmap --clean --if-exists --no-owner < restore.dump
docker compose start api
```

Bare metal: `pg_restore -h 127.0.0.1 -U rackmap -d rackmap --clean --if-exists --no-owner rackmap-<timestamp>.dump`.

A backup is only as good as the secrets that decrypt it: keep `APP_ENCRYPTION_KEY` and `VAULT_PASSPHRASE` somewhere
other than the backup volume.

### Multiple replicas

Background jobs (probes, alerts, backups, scans, sweeps) take a lease row in the database before running, so each job
runs on exactly one replica. No configuration is needed; `JOB_LOCK_TTL_MS` controls how quickly another replica takes
over from one that died.

---

## 🤖 Automation & API keys

RackMap is meant to be the source of truth for your fleet, so machine clients are
first-class. Create an **API key** under **Security → API Keys** and use it as a
bearer token:

```bash
curl -H "Authorization: Bearer sk_..." https://rackmap.example.com/api/v1/servers
```

Keys carry a **role ceiling** (`scopeRole`) and an optional expiry. A key can never
exceed the role of whoever created it, and it is capped again at request time
against the owner's *current* role — so demoting or banning a user immediately
demotes their keys. Keys default to `viewer`; mint the least privilege that works.

```bash
# A read-only key that expires in 90 days
curl -X POST https://rackmap.example.com/api/v1/api-keys \
  -H "Content-Type: application/json" \
  -H "Cookie: better-auth.session_token=<your session>" \
  -d '{"name":"ansible","scopeRole":"viewer","expiresInDays":90}'
```

The raw key is returned **once**.

### Ansible dynamic inventory

[`contrib/rackmap-inventory.py`](contrib/rackmap-inventory.py) turns your RackMap
inventory into an Ansible one, so you stop maintaining the fleet in two places:

```bash
export RACKMAP_URL=https://rackmap.example.com
export RACKMAP_API_KEY=sk_...
ansible -i contrib/rackmap-inventory.py gpu -m ping
```

Hosts are grouped by environment, cloud provider, location, server type, owning
team, tag, probe status, and whether they have GPUs. See [contrib/README.md](contrib/README.md).

### Prometheus

`GET /api/v1/metrics` exposes fleet state in the Prometheus text format. RackMap
deliberately does not store a time series of its own — Prometheus does that job
better than an inventory database would.

```yaml
scrape_configs:
  - job_name: rackmap
    metrics_path: /api/v1/metrics
    scheme: https
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/rackmap.key
    static_configs:
      - targets: ["rackmap.example.com"]
```

Exports server/service/certificate counts by status, per-host up/down and probe
latency, probe staleness (a rising `rackmap_server_last_probe_age_seconds` means
the scheduler has stopped), GPU counts, days remaining on every tracked
certificate, heartbeats, runbook runs, alert deliveries, pending/security
updates, reboot-required hosts, open drift events, and active access grants.

**Service discovery.** `GET /api/v1/prometheus/sd` returns `http_sd_configs`
targets for every server (default port `PROMETHEUS_SD_DEFAULT_PORT`, 9100 for
node_exporter) with `rackmap_*` labels, filterable by environment, location, tag,
or status. Both endpoints accept a viewer-scoped API key as a Bearer token.
`contrib/prometheus/prometheus.yml` has a ready scrape config and
`contrib/grafana/rackmap-fleet.json` an importable dashboard.

---

## 🧑‍💻 Development

**Prerequisites:** Node.js 24, pnpm 10, and a local PostgreSQL 18.

```bash
pnpm install
cp .env.example apps/api/.env      # the API reads apps/api/.env; set PORT=3001 and DATABASE_URL
pnpm --filter @inv/api db:generate
pnpm --filter @inv/api db:deploy   # apply migrations to your dev database
pnpm --filter @inv/api db:seed     # admin + demo accounts (development only)
pnpm dev
#   API → http://localhost:3001   (the Vite dev server proxies /api and /health here)
#   Web → http://localhost:5173
```

| Command | What it does |
|---------|--------------|
| `pnpm dev` | Run API and web in watch mode |
| `pnpm build` | Build every workspace. Run it before `pnpm typecheck`, because it generates the web route tree |
| `pnpm typecheck` | Type-check every workspace |
| `pnpm test` | Run the Vitest suite against PostgreSQL (`TEST_DATABASE_URL`, a database whose name ends in `_test`) |
| `pnpm e2e` | Run Playwright end-to-end tests against a running instance |
| `pnpm e2e:ui` | Playwright in interactive UI mode |
| `pnpm db:studio` | Open Prisma Studio |

See [CONTRIBUTING.md](CONTRIBUTING.md) for the test database, writing migrations, branch naming, commit conventions,
and the PR checklist.

---

## 🧭 Customer Portal (`/portal`)

RackMap ships with a public product portal at `/portal`:

- **Product showcase** — agentless SSH architecture, encrypted credential vault, kernel-level ATOP analysis
- **Interactive mock console** — simulated server fleet, ATOP replay, vault unlock, and remote OS user audit
- **Pricing matrix** — monthly vs. annual toggle across Free, Professional, and Enterprise tiers
- **Self-hosting quickstart** — a copyable `docker-compose.yml` snippet
- **FAQ** — envelope encryption, air-gapped activation, supported Linux distributions

## 💳 Licensing Tiers (Licencia)

Subscription entitlements are backed by [Licencia](https://github.com/deziss/licencia). RackMap runs fully
functional without it — the Free Community Edition is the default when no license is configured.

| Feature / limit | License feature | Free Community | Pro | Enterprise |
|---|---|:---:|:---:|:---:|
| Max managed servers | `unlimited_servers` | 10 | 100 | Unlimited |
| Server, service & SSL inventory, probes, live metrics, logs | — | ✓ | ✓ | ✓ |
| SSH terminal, access requests, audit log, vault | — | ✓ | ✓ | ✓ |
| Viewing OS users, crontabs, systemd units, patch report | — | ✓ | ✓ | ✓ |
| Heartbeats created by hand | — | ✓ | ✓ | ✓ |
| Alert channels | `multi_channel_alerts` | 1 channel ¹ | Unlimited | Unlimited |
| Hardware auto-discovery | `hardware_discovery` | — | ✓ | ✓ |
| ATOP historical replay | `atop_history` | — | ✓ | ✓ |
| OS users: create, edit, delete | `remote_os_users` | — | ✓ | ✓ |
| Automated system updates | `auto_update` | — | ✓ | ✓ |
| Cron editor: save, run now, heartbeat monitoring | `remote_cron` | — | ✓ | ✓ |
| Runbooks & fleet execution | `runbooks` | — | ✓ | ✓ |
| systemd actions (start/stop/restart/…) | `service_manager` | — | ✓ | ✓ |
| Patch scan now & apply | `patch_management` | — | ✓ | ✓ |
| Drift detection | `drift_detection` | — | ✓ | ✓ |
| Time-boxed access grants | `access_expiry` | — | ✓ | ✓ |

¹ Free allows one channel of type Slack, Discord, Telegram, email, or webhook, without filters or custom templates,
plus the legacy `NOTIFY_*` channels and per-user email preferences. Pro adds unlimited channels, Microsoft Teams,
PagerDuty, filters, and templates. If a license lapses nothing is deleted; deliveries outside the free allowance are
logged as suppressed.

Manage licenses in **Settings → Subscription & Billing** (admin): view node quota usage, activate an online key, or paste
an offline signed Ed25519 lease token. Activating, deactivating, and checkout are admin-only. Completing a checkout
requires `BILLING_MODE=simulated`, because there is no payment gateway. In production, a license key is accepted only
when Licencia can verify it.

---

## 🔄 CI/CD & Container Images

Two GitHub Actions workflows ship with the repository:

- **[`ci.yml`](.github/workflows/ci.yml)** — on every push to `main` and every PR, against a PostgreSQL 18 service: a
  migration drift check (`prisma migrate diff --exit-code`), build, typecheck, and the full test suite
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
