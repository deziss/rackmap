# RackMap

> **Status: Complete** — All planned phases shipped and production-ready.
>
> **[User Guide →](USER_GUIDE.md)** — Setup, features, roles, troubleshooting

Full-stack infrastructure inventory and monitoring platform. Track bare-metal and cloud servers, monitor live metrics via agentless SSH, manage access, and maintain a complete audit trail — no agents installed on target servers.

---

## Features

- **Server CRUD & Specifications** — hostname, IP, SSH port, credentials (AES-256 encrypted at rest), tags, metadata with dedicated columns for CPU, RAM, Storage, and OS
- **OS User & Sudoers Management** — create, update, lock/unlock, and delete Linux accounts with full Linux options (-m, -r, custom shells, secondary groups, custom UID/GID, sudoers rules) and root/SSH safeguards
- **Universal Numbered Pagination** — rows-per-page selector (10, 25, 50, 100), range display, and numbered page buttons across Servers, Services, SSL, Audit, Users, and OS Users tables
- **Forensic Logs & Auto-Query** — query systemd journalctl and syslog with selectable auto-refresh intervals (5s, 10s, 30s, 60s, manual) and live indicators
- **Visual Audit Inspection** — before/after JSON diff inspection dialogs for all audit events
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
cd rackmap

# 2. Create .env (never commit this file)
cat > .env << 'EOF'
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
APP_ENCRYPTION_KEY=$(openssl rand -base64 32)
WEB_ORIGIN=http://localhost:8080
SEED_ADMIN_EMAIL=admin@example.com
SEED_ADMIN_PASSWORD=changeme123
EOF

# 3. Start
# Note: On first run or after fetching updates, it's recommended to build:
docker compose up -d --build

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
| `APP_ENCRYPTION_KEY` or `APP_ENCRYPTION_PASSPHRASE` | Master key or passphrase for database at-rest encryption (AES-256-GCM). Accepts 32-byte base64 or any human-readable passphrase (min 8 chars). |

### Optional — Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Host port for the web UI |
| `DATABASE_URL` | `file:./dev.db` | Prisma DB URL. Use `file:/data/inventory.db` in Docker |
| `WEB_ORIGIN` | `http://localhost:5173` | URL of the web app (used for CORS + auth cookies) |
| `SEED_ADMIN_EMAIL` | `admin@example.com` | First-run admin account email |
| `SEED_ADMIN_PASSWORD` | `changeme123` | First-run admin account password |
| `VAULT_PASSPHRASE` | — | Master Zero-Knowledge Credential Vault passphrase. When set in `.env`, automatically initializes/unlocks the vault at startup for background auto-discovery & SSH jobs. |

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

### Optional — Licensing & Subscription (Licencia)

| Variable | Default | Description |
|----------|---------|-------------|
| `LICENCIA_URL` | — | Base URL of Licencia server (e.g. `http://host.docker.internal:3003` or `https://licencia.example.com`) |
| `LICENCIA_API_KEY` | — | Tenant API Key for Licencia API (`lic_live_...`) |
| `LICENCIA_LICENSE_KEY` | — | Master License Key (`LIC-PRO-...`) to auto-activate on container startup |
| `LICENCIA_PUBLIC_KEY` | — | Ed25519 SPKI Public Key for zero-network air-gapped license token verification |

### Optional — Live Metrics

| Variable | Default | Description |
|----------|---------|-------------|
| `METRICS_ENABLED` | `true` | Enable agentless SSH metrics collection |
| `METRICS_SSH_TIMEOUT_MS` | `10000` | SSH exec timeout for metrics collection |

### SSH Dual-Mode Authentication & Password Fallback

RackMap supports diverse hybrid infrastructure environments where some servers require SSH key pairs while others enforce password or PAM authentication:
- **Automatic Multi-Method Fallback**: The SSH client automatically attempts public key authentication first (`/data/id_ed25519` and custom uploaded keys). If the remote target host rejects the key, it automatically falls back to password authentication and PAM keyboard-interactive prompts without failing.
- **Server Detail SSH Controls (`/servers/:id`)**:
  - **Test Key Login**: Runs an immediate SSH handshake test using keys and reports round-trip latency.
  - **Test Password Login**: Tests password authentication against the host in real time.
  - **Set / Change Password**: Secure dialog allowing operators to test and store passwords encrypted in the Credential Vault.
  - **Auto-Prompt on Auth Failure**: If automated discovery, ATOP, logs, or metrics encounter an unauthorized remote server, a password dialog prompts for the credential and auto-retries.
- **SSH Terminal Host Filter (`/ssh`)**: Search input in the sidebar allows filtering hosts in real-time by hostname or IP address.
- **SSL Certificate Multi-Field Search (`/ssl`)**: Search bar filters across domains, services, issuers, teams, projects, and server hostnames.

### Optional — SSH Terminal

| Variable | Default | Description |
|----------|---------|-------------|
| `SSH_ENABLED` | `false` | **Kill-switch.** Set `true` to enable browser SSH terminal (admin-only) |
| `SSH_CONNECT_TIMEOUT_MS` | `10000` | SSH connection timeout |
| `SSH_IDLE_TIMEOUT_MS` | `300000` | Idle session timeout (5 min) |
| `SSH_MAX_SESSION_MS` | `3600000` | Max session duration (1 hour) |
| `SSH_MAX_CONCURRENT` | `5` | Max simultaneous SSH terminal sessions |
---

## 🔐 Encryption & Passphrase Guide

RackMap uses a multi-tier cryptographic architecture to protect infrastructure credentials and server passwords.

### Where and How to Set Encryption Passphrase

You can configure encryption through two primary mechanisms:

#### Tier 1: Application At-Rest Encryption (`APP_ENCRYPTION_KEY` / `APP_ENCRYPTION_PASSPHRASE`)
- **Where to set**: In your root `.env` file (or environment variables in `docker-compose.yml`).
- **How it works**: Encrypts sensitive fields in the database (server passwords, secrets) using AES-256-GCM (`v1.<iv>.<tag>.<cipher>`).
- **Configuration Options**:
  1. **Random Base64 (Recommended for maximum entropy)**:
     ```bash
     APP_ENCRYPTION_KEY=$(openssl rand -base64 32)
     ```
  2. **Custom Human-Readable Passphrase**:
     ```bash
     APP_ENCRYPTION_PASSPHRASE="YourSecurePassphraseHere123!"
     # Or directly in APP_ENCRYPTION_KEY:
     APP_ENCRYPTION_KEY="YourSecurePassphraseHere123!"
     ```
     RackMap automatically derives a deterministic 32-byte AES-256 key via SHA-256 when a human-readable passphrase is provided.

#### Tier 2: Zero-Knowledge Credential Vault (`VAULT_PASSPHRASE` / UI)
- **What it does**: Provides envelope encryption (`v2.<iv>.<tag>.<cipher>`) using PBKDF2 (100,000 iterations, SHA-512) to derive a 256-bit Key Encryption Key (KEK) that wraps an ephemeral 256-bit Data Encryption Key (DEK). The master passphrase is never stored on disk.
- **Where to set**:
  - **Option A: Automated Background Unlock (`.env`) — Recommended for Production**
    Add `VAULT_PASSPHRASE` to your `.env` file:
    ```bash
    VAULT_PASSPHRASE="YourMasterVaultPassphraseHere!"
    ```
    When set, RackMap auto-initializes or unlocks the vault on API startup, allowing automated background tasks (hardware auto-discovery, scheduled metrics polling, log querying) to decrypt SSH credentials without operator intervention.
  - **Option B: Global Unlock in Admin Settings UI (`/settings`)**
    Admins can navigate to **Settings** → **Credential Vault & Passphrase Configuration**:
    1. Enter the master passphrase to unlock the vault globally for all server operations.
    2. Optionally check **"Persist to .env file"** to write `VAULT_PASSPHRASE` directly to disk so background jobs and restarts remain unlocked permanently.
  - **Option C: Interactive Ephemeral Session (`/servers/:id`)**
    Operators can also unlock the vault interactively per session from the header of any Server Detail page for 30 minutes.

### Resetting a Forgotten Vault Passphrase

If the master vault passphrase is lost or needs rotation:
1. Navigate to **Security** (`http://localhost:8080/security`) or click the **Vault** badge in any server header.
2. If the vault is locked, click **"Forgot passphrase? Reset vault"** (Admin-only).
3. If the vault is currently unlocked, click **"Manage / Reset Passphrase"** → **"Reset / Re-key"**.
4. Enter and confirm a new master passphrase (minimum 8 characters) and confirm reset.
5. Alternatively, make an authenticated API call:
   ```bash
   curl -X POST http://localhost:3001/api/v1/vault/reset \
     -H "Content-Type: application/json" \
     -H "Cookie: better-auth.session_token=<admin-session>" \
     -d '{"passphrase":"NewSecureMasterPassphrase!"}'
   ```
> **Note**: Resetting the vault generates a brand-new master DEK. Any server passwords previously encrypted under the old forgotten passphrase will need to be re-entered.


---

## Licensing & Subscription Tiers (Powered by Licencia)

RackMap includes integrated subscription entitlement management backed by [Licencia](file:///home/anshukushwaha/Desktop/learn/licencia).

### Tiers Matrix

| Feature / Limit | Free Community Edition | Pro Tier | Enterprise Tier |
|---|---|---|---|
| **Max Managed Servers** | Up to **10 servers** | Up to **100 servers** | **Unlimited** |
| **Server & Service Inventory** | Full CRUD, tagging, search | Included | Included |
| **SSH Terminal** | Included | Included | Included |
| **Hardware Auto-Discovery via SSH** | Gated (`PRO`) | Included | Included |
| **ATOP Historical Spikes & Replay** | Gated (`PRO`) | Included | Included |
| **Remote OS User & Sudoers Fleet** | Gated (`PRO`) | Included | Included |
| **Automated System Updates** | Gated (`PRO`) | Included | Included |
| **Multi-Channel Alert Dispatchers** | Gated (`PRO`) | Included | Included |

### Configuration (`.env`)

```bash
# Licencia Server Integration (Optional)
LICENCIA_URL=https://licencia.example.com
LICENCIA_API_KEY=lic_live_your_api_key
LICENCIA_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
LICENCIA_LICENSE_KEY=LIC-PRO-XXXX-XXXX-XXXX-XXXX
```

### Managing Licenses in UI
Admins can navigate to **Settings** (`/settings`) → **Subscription & Licensing**:
- View real-time node quota utilization (`X / 10 servers used`).
- Activate online license keys (`LIC-...`) or paste offline signed Ed25519 lease tokens.
- Instant fallback to Free Community Edition upon deactivation.

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
GET    /api/v1/servers              List + search + paginated (page, limit)
POST   /api/v1/servers              Create (editor+)
GET    /api/v1/servers/:id          Detail
PATCH  /api/v1/servers/:id          Update (editor+)
DELETE /api/v1/servers/:id          Soft-delete (editor+)
GET    /api/v1/servers/:id/metrics  Live SSH metrics (editor+)
POST   /api/v1/servers/:id/auto-discover  Auto-detect hardware and persist CPU, RAM, Storage, OS
GET    /api/v1/servers/export.xlsx  Export to Excel (includes CPU, RAM, Storage, OS)
GET    /api/v1/servers/export.json  Export to JSON (includes CPU, RAM, Storage, OS)

# OS Users & Sudoers Management (editor+)
GET    /api/v1/servers/:id/os-users            List local accounts, UIDs, shells, groups, sudo privileges
POST   /api/v1/servers/:id/os-users            Create Linux user (shell, home, groups, -m, -r, sudo rules)
PATCH  /api/v1/servers/:id/os-users/:username  Update shell, home, groups, password, lock/unlock, sudo rules
DELETE /api/v1/servers/:id/os-users/:username  Delete user (-r remove home, -f force, root/SSH safeguards)
PATCH  /api/v1/servers/:id/sudo-permission     Atomic sudoers rule update (/etc/sudoers.d/rackmap_*)

# Logs & ATOP Forensics
POST   /api/v1/servers/:id/logs                Query journalctl/syslog with priority, unit, and auto-query
GET    /api/v1/servers/:id/atop/dates          List historical ATOP activity dates
GET    /api/v1/servers/:id/atop/snapshots      Query ATOP interval snapshots
GET    /api/v1/servers/:id/atop/top-processes  Extract top CPU/memory/disk processes per interval

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

## Deployment (Docker Production)

The recommended way to deploy RackMap in production is using the provided `docker-compose.yml`.

1. **Prepare Environment:**
   Create a `.env` file based on `.env.example`. You must securely generate `BETTER_AUTH_SECRET` and `APP_ENCRYPTION_KEY`.
   ```bash
   cp .env.example .env
   # Generate a 32-byte base64 key for APP_ENCRYPTION_KEY
   sed -i "s|^APP_ENCRYPTION_KEY=.*|APP_ENCRYPTION_KEY=\"$(openssl rand -base64 32)\"|" .env
   # Generate a secure secret for BETTER_AUTH_SECRET
   sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=\"$(openssl rand -hex 32)\"|" .env
   ```
   
2. **Configure Port:**
   By default, the web UI is exposed on port `8080`. You can change this by setting `PORT` in your `.env`.

3. **Start Services:**
   ```bash
   docker compose up -d --build
   ```

4. **Volumes & Backups:**
   The SQLite database is stored in a Docker volume named `sqlite_data`. Automatic backups (if configured) are stored in `backups`.
   To map these to host directories, modify the `volumes` section in `docker-compose.yml`.

5. **Reverse Proxy (Optional but Recommended):**
   Put RackMap behind a reverse proxy like Nginx, Caddy, or Traefik with SSL termination. The API and Web UI are combined into a single entry point by the web container's Nginx configuration.

---

## Deployment (Bare Metal / VPS)

Using PM2 with the included ecosystem config:

```bash
# Build
pnpm build

# Start with PM2
pm2 start ecosystem.config.cjs

# Or as a systemd service
sudo cp rackmap.service /etc/systemd/system/
sudo systemctl enable --now rackmap
```

SQLite database path: set `DATABASE_URL=file:/var/lib/rackmap/inventory.db` and ensure the directory exists.

---

### Optional: Using PostgreSQL instead of SQLite

RackMap runs on SQLite by default. To use PostgreSQL:

1. In `apps/api/prisma/schema.prisma`, change `provider = "sqlite"` to `provider = "postgresql"`.
2. In `.env`, set your PostgreSQL connection string:
   ```env
   DATABASE_URL="postgresql://rackmap:rackmap123@localhost:5432/rackmap?schema=public"
   ```
3. Run migrations:
   ```bash
   pnpm --filter @inv/api prisma migrate dev --name baseline
   ```
4. If using Docker Compose, run with the optional PostgreSQL profile:
   ```bash
   docker compose --profile postgres up -d --build
   ```

---

## Backup

Set `BACKUP_DIR` to enable automatic SQLite backups. In Docker, this is mounted at `/backups`.

Manual backup:
```bash
sqlite3 /data/inventory.db ".backup '/backups/inventory-$(date +%Y%m%d).db'"
```
