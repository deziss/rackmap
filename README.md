# Server Inventory

> **Status: Complete** — All planned phases shipped and production-ready.

Full-stack infrastructure inventory and monitoring platform. Track bare-metal and cloud servers, monitor live metrics via agentless SSH, manage access, and maintain a complete audit trail — no agents installed on target servers.

---

## Project Status

| Phase | Description | Status |
|-------|-------------|--------|
| P1 | Server CRUD, tags, lookup tables, RBAC | ✅ Done |
| P2 | TCP ping monitoring, up/down history, scheduler | ✅ Done |
| P3 | Audit log, notifications (webhook + Telegram), UX | ✅ Done |
| P4 | Agentless SSH metrics (CPU/mem/disk/net/GPU) | ✅ Done |
| P5 | Browser SSH terminal (xterm.js, WebSocket, kill-switch) | ✅ Done |
| P6 | Excel + JSON export, server detail modal | ✅ Done |
| P7 | Access request system (SSH + password reveal approval) | ✅ Done |
| P8 | Multi-vendor GPU metrics (NVIDIA, AMD, Intel) | ✅ Done |

---

## Features

- **Server CRUD** — hostname, IP, SSH port, credentials (AES-256 encrypted at rest), tags, metadata
- **Live status monitoring** — TCP ping probe on a configurable interval; up/down history; webhook + Telegram alerts
- **Live metrics** — CPU load, memory, disk, network I/O, per-process tables — collected via one SSH exec command (no agent install)
- **Multi-vendor GPU metrics** — NVIDIA (nvidia-smi), AMD sysfs (amdgpu kernel driver), AMD ROCm, Intel (xpu-smi)
- **Browser SSH terminal** — full xterm.js terminal over WebSocket; admin-only with kill-switch
- **RBAC** — admin / editor / viewer roles via Better Auth; access requests for SSH and password reveal
- **Audit log** — every data mutation and auth event recorded with before/after diffs
- **Export** — Excel (.xlsx) and JSON export with search filter
- **Lookup tables** — Cloud Provider, GPU Type, Allocated To, Location, Server Type dropdowns
- **Docker deploy** — single `docker compose up` for production; SQLite with volume persistence

---

## Architecture

```
apps/
  api/       Hono (Node.js) — REST API + WebSocket SSH
  web/       React (Vite) — SPA served by Nginx in Docker
packages/
  shared/    Types, constants, DTOs shared between apps
```

**Data flow (metrics)**
```
Browser → GET /api/v1/servers/:id/metrics
  → API SSHs into target server
  → Runs one compound shell command (~1s with sleep for net sampling)
  → Parses output → returns typed JSON
  → Browser polls every 5s
```

**Data flow (SSH terminal)**
```
Browser WebSocket → API WS upgrade (validates session + RBAC)
  → API opens SSH connection to target
  → Bidirectional pipe (browser PTY ↔ remote shell)
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| API framework | [Hono](https://hono.dev) |
| ORM | [Prisma](https://prisma.io) |
| Database | SQLite (via Prisma; Postgres-ready) |
| Auth | [Better Auth](https://better-auth.com) with RBAC |
| SSH | `ssh2` library |
| Frontend | React 18 + Vite |
| Routing | TanStack Router |
| Data fetching | TanStack Query |
| UI components | shadcn/ui + Tailwind CSS |
| Terminal | xterm.js |
| Containerization | Docker + Nginx |

---

## Quick Start (Docker)

```bash
# 1. Clone
git clone <repo-url>
cd server-inventory

# 2. Create .env (never commit this file)
cat > .env << 'EOF'
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
APP_ENCRYPTION_KEY=$(openssl rand -base64 32)
WEB_ORIGIN=http://localhost:8080
SEED_ADMIN_EMAIL=admin@example.com
SEED_ADMIN_PASSWORD=changeme123
EOF

# 3. Start
docker compose up -d

# 4. Open
open http://localhost:8080
```

Default admin credentials are set by `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`. Change them after first login.

---

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `BETTER_AUTH_SECRET` | Random secret for session signing (≥32 chars). Generate: `openssl rand -base64 32` |
| `APP_ENCRYPTION_KEY` | 32-byte base64 key for encrypting SSH passwords. Generate: `openssl rand -base64 32` |

### Optional — Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Host port for the web UI |
| `DATABASE_URL` | `file:./dev.db` | Prisma DB URL. Use `file:/data/inventory.db` in Docker |
| `WEB_ORIGIN` | `http://localhost:5173` | URL of the web app (used for CORS + auth cookies) |
| `SEED_ADMIN_EMAIL` | `admin@example.com` | First-run admin account email |
| `SEED_ADMIN_PASSWORD` | `changeme123` | First-run admin account password |

### Optional — Scheduler / Probing

| Variable | Default | Description |
|----------|---------|-------------|
| `SCHEDULER_ENABLED` | `true` | Enable background ping scheduler |
| `PING_INTERVAL_MS` | `60000` | Probe frequency in milliseconds |
| `PING_TIMEOUT_MS` | `3000` | Per-server TCP probe timeout |
| `PING_CONCURRENCY` | `10` | Max simultaneous probes |
| `STATUS_RETENTION_DAYS` | `30` | Days to keep probe history |
| `STATUS_FLIP_THRESHOLD` | `2` | Consecutive failures before status change |

### Optional — Notifications

| Variable | Default | Description |
|----------|---------|-------------|
| `NOTIFY_WEBHOOK_URL` | — | HTTP POST URL for up/down alerts |
| `NOTIFY_TELEGRAM_BOT_TOKEN` | — | Telegram bot token |
| `NOTIFY_TELEGRAM_CHAT_ID` | — | Telegram chat/group ID |

### Optional — Live Metrics

| Variable | Default | Description |
|----------|---------|-------------|
| `METRICS_ENABLED` | `true` | Enable agentless SSH metrics collection |
| `METRICS_SSH_TIMEOUT_MS` | `10000` | SSH exec timeout for metrics collection |

### Optional — SSH Terminal

| Variable | Default | Description |
|----------|---------|-------------|
| `SSH_ENABLED` | `false` | **Kill-switch.** Set `true` to enable browser SSH terminal (admin-only) |
| `SSH_CONNECT_TIMEOUT_MS` | `10000` | SSH connection timeout |
| `SSH_IDLE_TIMEOUT_MS` | `300000` | Idle session timeout (5 min) |
| `SSH_MAX_SESSION_MS` | `3600000` | Max session duration (1 hour) |
| `SSH_MAX_CONCURRENT` | `5` | Max simultaneous SSH terminal sessions |

---

## Development Setup

**Prerequisites**: Node.js 20+, pnpm 9+

```bash
# Install dependencies
pnpm install

# Generate Prisma client
cd apps/api && pnpm prisma generate && pnpm prisma migrate dev

# Start both apps in dev mode (from repo root)
pnpm dev

# API:  http://localhost:3000
# Web:  http://localhost:5173
```

**Typechecking**
```bash
pnpm typecheck   # runs tsc --noEmit on both apps
```

**E2E tests**
```bash
pnpm test:e2e   # Playwright tests
```

---

## Agentless Metrics

No software is installed on monitored servers. Metrics are collected by:

1. SSH-ing into the target server using the stored (encrypted) credentials
2. Running a single compound shell command that reads from `/proc`, `ps`, `df`, and GPU tools
3. Parsing the output server-side and returning a typed JSON response
4. The browser polls every 5 seconds while the detail modal is open

### GPU Vendor Support

Detection runs in priority order:

| Priority | Vendor | Detection | Tools Required |
|----------|--------|-----------|---------------|
| 1 | NVIDIA | `nvidia-smi -L` | `nvidia-smi` |
| 2 | AMD (sysfs) | `/sys/class/drm/card*/device/gpu_busy_percent` exists | Linux kernel `amdgpu` driver (no extra tools) |
| 3 | AMD (ROCm) | `rocm-smi` in PATH | `rocm-smi` |
| 4 | Intel | `xpu-smi` in PATH | `xpu-smi` |
| — | None | fallback | — |

All vendors normalize to the same output format: utilization %, VRAM used/total (MiB), temperature (°C or null if unavailable).

---

## API Overview

All endpoints require authentication via Better Auth session cookie.

```
# Auth
POST   /api/auth/sign-in/email
POST   /api/auth/sign-out

# Servers
GET    /api/v1/servers              List + search
POST   /api/v1/servers              Create (editor+)
GET    /api/v1/servers/:id          Detail
PATCH  /api/v1/servers/:id          Update (editor+)
DELETE /api/v1/servers/:id          Soft-delete (editor+)
GET    /api/v1/servers/:id/metrics  Live SSH metrics (editor+)
GET    /api/v1/servers/export.xlsx  Export to Excel
GET    /api/v1/servers/export.json  Export to JSON

# Lookup tables (admin)
GET/POST/PATCH/DELETE /api/v1/lookups/{cloud-providers,gpu-types,allocated-to,locations,server-types}

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
PATCH  /api/v1/access-requests/:id   Approve/reject (admin)

# Audit
GET    /api/v1/audit               Paginated audit log (cursor-based)

# Health
GET    /health/live
GET    /health/ready
```

---

## RBAC

| Permission | admin | editor | viewer |
|-----------|-------|--------|--------|
| View servers | ✓ | ✓ | ✓ |
| Create/update/delete servers | ✓ | ✓ | — |
| Reveal SSH password | ✓ | ✓ | request |
| Live metrics | ✓ | ✓ | — |
| SSH terminal | ✓ | request | request |
| Manage users | ✓ | — | — |
| Manage lookups | ✓ | — | — |
| View audit log | ✓ | — | — |

Viewers can submit access requests for SSH terminal and password reveal. Admins approve/reject with an expiry window.

---

## Security

- **Passwords encrypted at rest** — AES-256-GCM with a randomly generated key per server, stored in `APP_ENCRYPTION_KEY`
- **Passwords never sent to the client** — all `passwordEnc` fields are excluded from API responses
- **SSH terminal is off by default** — requires `SSH_ENABLED=true` and admin role (or approved access request)
- **WebSocket auth** — WS upgrade validates Better Auth session, checks ban status and RBAC before opening SSH
- **Audit trail** — every write operation and auth event is recorded with actor, IP, before/after state
- **CORS** — configurable via `TRUSTED_ORIGINS`; defaults to `*` for internal tools; set explicitly in production

---

## Deployment (Bare Metal / VPS)

Using PM2 with the included ecosystem config:

```bash
# Build
pnpm build

# Start with PM2
pm2 start ecosystem.config.cjs

# Or as a systemd service
sudo cp server-inventory.service /etc/systemd/system/
sudo systemctl enable --now server-inventory
```

SQLite database path: set `DATABASE_URL=file:/var/lib/server-inventory/inventory.db` and ensure the directory exists.

---

## Backup

Set `BACKUP_DIR` to enable automatic SQLite backups. In Docker, this is mounted at `/backups`.

Manual backup:
```bash
sqlite3 /data/inventory.db ".backup '/backups/inventory-$(date +%Y%m%d).db'"
```
