# RackMap — Upgrade & Migration Guide

- **[Upgrading 0.8.x → 1.0.0](#upgrading-08x--100)**: breaking changes, the SQLite → PostgreSQL 18 data move, and new
  settings. Read this before pulling 1.0.
- **[Moving RackMap to another server](#moving-rackmap-to-another-server-postgresql-18)**: a full server-to-server
  migration onto PostgreSQL 18, plus [backups & restore](#9-backups--restore).

---

## Upgrading 0.8.x → 1.0.0

1.0.0 is a major release. RackMap 0.8 stored everything in **SQLite** (in Docker, `/data/inventory.db` in the
`sqlite_data` volume). **RackMap 1.0 runs on PostgreSQL 18 only.** The upgrade creates a fresh PostgreSQL database
and copies your SQLite data into it with a bundled script. Plan a short maintenance window. Your 0.8 SQLite file is not
modified, so you can roll back by starting 0.8 again.

### Breaking changes checklist

- [ ] **PostgreSQL 18 only.** SQLite support is removed. Existing data must be copied with
      `pnpm --filter @inv/api db:migrate:postgres` (steps below). The script runs on a host with Node.js 24, pnpm, and
      `python3`, because the API image does not ship Python.
- [ ] **`POSTGRES_PASSWORD` is required** (Docker). Compose refuses to start with `set POSTGRES_PASSWORD in .env` until
      it is set. It is embedded in a connection URL, so use URL-safe characters: `openssl rand -hex 24`.
      `POSTGRES_USER` and `POSTGRES_DB` default to `rackmap`.
- [ ] **Remove SQLite URLs from `.env`.** Delete any `DATABASE_URL=file:…` and, above all, any
      `DOCKER_DATABASE_URL=file:…`. `DOCKER_DATABASE_URL` overrides the PostgreSQL URL Compose builds, so a leftover
      value breaks startup.
- [ ] **The `postgres` service always runs.** There is no `--profile postgres` any more. The image is
      `pgvector/pgvector:pg18` and its volume is mounted at `/var/lib/postgresql`. PostgreSQL is published on
      `127.0.0.1:5432`; set `POSTGRES_HOST_PORT` if the host already uses 5432. If you once started 0.8's optional
      `postgres` profile, its `pgdata` volume holds a PostgreSQL 16 cluster that RackMap 0.8 never used, because 0.8
      was SQLite-only. Check that nothing else stored data there, then remove it before the first 1.0 start:
      `docker volume rm <project>_pgdata`.
- [ ] **Non-root API image: volume ownership.** The API runs as `node` (uid 1000), as it has since 0.7. If your
      `sqlite_data` volume was created by an older root-run image, or you copied SSH keys into it as root, hand it
      over once:
      `docker run --rm --user root -v <project>_sqlite_data:/data <api-image> chown -R node:node /data`
      (`<project>` is the Compose project name, by default the directory name; `<api-image>` is shown by
      `docker compose images api`). The new `backups` volume is created with the right owner.
- [ ] **A strong `SEED_ADMIN_PASSWORD` is needed for the first start.** 1.0 starts against an empty PostgreSQL
      database, so the seed runs. In production it refuses a published default (such as `Change-Me-Now-123!`) or
      anything shorter than 12 characters, and the API container stops. The SQLite import afterwards replaces the
      seeded admin with your existing accounts.
- [ ] **Rebuild both images.** The v0.8.0 web image's nginx 301-redirected `GET /api/v1/servers`, leaving the Servers
      page empty. It also lacks the 30-minute timeout that long host actions (patch apply and scan, drift scan, systemd
      actions, access grants) need. Use `docker compose up -d --build`, not just a restart.
- [ ] **Your own reverse proxy**, if you run one in front of RackMap:
      - Allow reads of at least 30 minutes on `/api/v1/servers/<id>/patches/{apply,scan}`,
        `/api/v1/servers/<id>/drift/scan`, `/api/v1/servers/<id>/systemd/units/<unit>/action`, and
        `/api/v1/access-grants/…`.
      - Keep WebSocket upgrade headers on `/api/v1/servers/<id>/ssh`.
- [ ] **CORS.** The API now accepts the `X-SSH-Password` and `X-Sudo-Password` request headers and the `PUT` method
      (the cron editor saves with PUT). A proxy or CDN that answers CORS preflights itself must allow them too.
- [ ] **OS users: edit and delete are now Pro-gated** (`remote_os_users`), like create. Listing stays free.
- [ ] **Editors lost some OS-user powers.** They can no longer:
      - grant sudo or privileged groups (`sudo`, `wheel`, `admin`, `docker`, `lxd`, `disk`, `root`, `adm`, `shadow`,
        plus groups made root-equivalent by `%group` sudoers rules or gid 0);
      - change or delete root-equivalent accounts;
      - set passwords containing line breaks.
      Password changes are no longer written to the audit log.
- [ ] **Checkout and licensing.** License activation and checkout are admin-only. Completing a checkout returns 501
      unless `BILLING_MODE=simulated`. In production (`NODE_ENV=production`), a license key is only accepted when
      Licencia can verify it (`LICENCIA_URL` or `LICENCIA_PUBLIC_KEY`).
- [ ] **Server test alert.** `POST /api/v1/servers/:id/test-alert` now needs `alertChannel:manage` (admin; it was
      `server:update`, editor). It sends a `test` event instead of a fake status flip, so it no longer pages
      PagerDuty. Update any automation that called it with an editor key.
- [ ] **Per-account sign-in limit.** Ten attempts per account per minute (`AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX`), on top
      of the per-IP limit.
- [ ] **Status history is trimmed.** Probe history is now sampled and capped at 10,000 rows (`STATUS_MAX_ROWS`). The
      first prune after the upgrade deletes history beyond the cap. To keep more, raise `STATUS_MAX_ROWS` before
      upgrading (in Docker, also add it to the api service's `environment` list — see
      [New settings](#new-settings-in-100)).
- [ ] **Backups are `pg_dump`.** With `BACKUP_DIR` set (Docker: `/backups`), the API dumps PostgreSQL nightly. Old
      SQLite file copies are not touched or rotated.
- [ ] **Bare metal needs Node.js 24**, PostgreSQL 18, and `postgresql-client-18` for backups.

### Before you start

On the running 0.8 install:

```bash
# Docker: copy the SQLite database and your configuration out
docker compose cp api:/data/inventory.db ./inventory-0.8.db
cp .env .env.backup-0.8

# Bare metal: the file named by DATABASE_URL=file:… in apps/api/.env (often apps/api/prisma/dev.db)
cp apps/api/prisma/dev.db ./inventory-0.8.db
cp apps/api/.env ./env.backup-0.8
```

Keep `APP_ENCRYPTION_KEY` (or `APP_ENCRYPTION_PASSPHRASE`), `VAULT_PASSPHRASE`, and `BETTER_AUTH_SECRET` exactly as
they are. Every stored credential is encrypted with them.

### Docker Compose upgrade

```bash
# 1. Stop 0.8 (volumes are kept)
docker compose down

# 2. Get 1.0
git fetch --tags && git checkout v1.0.0

# 3. Edit .env
#    - remove DATABASE_URL=file:… and DOCKER_DATABASE_URL=file:…
#    - add POSTGRES_PASSWORD=<openssl rand -hex 24>
#    - set SEED_ADMIN_PASSWORD to 12+ characters (not a published default)
#    - check NODE_ENV=production, PORT (web UI port), WEB_ORIGIN
#    - optional: POSTGRES_HOST_PORT (if 5432 is taken), PUBLIC_BASE_URL (heartbeats)

# 4. Only if needed: fix volume ownership (see the checklist)

# 5. Build and start — the API creates the schema with `migrate deploy` and seeds an admin
docker compose up -d --build
docker compose ps                 # wait for postgres, api and web to be healthy

# 6. Copy the SQLite data into PostgreSQL, from a checkout on the host (Node.js 24, pnpm, python3)
pnpm install --frozen-lockfile
pnpm --filter @inv/api db:generate
cp inventory-0.8.db apps/api/prisma/dev.db        # the script reads prisma/dev.db inside apps/api
DATABASE_URL="postgresql://rackmap:<POSTGRES_PASSWORD>@127.0.0.1:5432/rackmap" \
  pnpm --filter @inv/api db:migrate:postgres        # 5432 = POSTGRES_HOST_PORT if you changed it

# 7. Restart the API so it picks up the imported data
docker compose restart api
```

The import script backs up `dev.db` next to itself, **truncates** the RackMap tables in PostgreSQL, copies every table
in dependency order, resets the ID sequences, and prints a row-count reconciliation. You can rerun it safely if
something goes wrong. Sign in with your existing 0.8 account afterwards.

### Bare-metal upgrade

```bash
# 1. Stop the service
sudo systemctl stop server-inventory          # or: pm2 stop server-inventory-api

# 2. Install PostgreSQL 18 and create the database (see Option B below for the apt repository)
sudo -u postgres psql -c "CREATE ROLE rackmap WITH LOGIN PASSWORD '<strong-password>';"
sudo -u postgres psql -c "CREATE DATABASE rackmap OWNER rackmap;"

# 3. Get 1.0 and build it (Node.js 24)
git fetch --tags && git checkout v1.0.0
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm build

# 4. Point apps/api/.env at PostgreSQL
#    DATABASE_URL=postgresql://rackmap:<strong-password>@127.0.0.1:5432/rackmap?schema=public
#    optional: BACKUP_DIR=/backups (writable by the service user; needs postgresql-client-18)

# 5. Create the schema, then import the SQLite data
pnpm --filter @inv/api db:deploy
cp inventory-0.8.db apps/api/prisma/dev.db
pnpm --filter @inv/api db:migrate:postgres

# 6. Start again
sudo systemctl start server-inventory
```

### New settings in 1.0.0

Everything below is optional; the defaults apply when a variable is unset. Descriptions are in the
[README configuration section](README.md#%EF%B8%8F-configuration) and [`.env.example`](.env.example).

| Area | Variables (default) |
|------|---------------------|
| Docker database | `POSTGRES_PASSWORD` (**required**, no longer defaults to `rackmap123`), `POSTGRES_HOST_PORT` (`5432`), `DOCKER_DATABASE_URL` (now a PostgreSQL URL). Unchanged: `POSTGRES_USER` (`rackmap`), `POSTGRES_DB` (`rackmap`), `POSTGRES_BIND` (`127.0.0.1`) |
| Public URL | `PUBLIC_BASE_URL` (unset; needed for cron heartbeats) |
| Sign-in limits | `AUTH_RATE_LIMIT_ENABLED` (`true`), `AUTH_RATE_LIMIT_MAX` (`200`), `AUTH_RATE_LIMIT_WINDOW` (`60`), `AUTH_LOGIN_RATE_LIMIT_MAX` (`60`), `AUTH_LOGIN_RATE_LIMIT_WINDOW` (`60`), `AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX` (`10`), `AUTH_LOGIN_ACCOUNT_RATE_LIMIT_WINDOW` (`60`) |
| Billing | `BILLING_MODE` (`disabled`) |
| Backups | `BACKUP_CRON` (`0 2 * * *`), `BACKUP_KEEP` (`14`) |
| Status history | `STATUS_SAMPLE_INTERVAL_MS` ‡ (`900000`), `STATUS_MAX_ROWS` ‡ (`10000`) |
| Alert channels | `ALERT_DISPATCH_ENABLED` (`true`), `ALERT_DISPATCH_INTERVAL_MS` (`5000`), `ALERT_OUTBOUND_TIMEOUT_MS` (`10000`), `ALERT_OUTBOUND_ALLOW_PRIVATE` (`false`), `ALERT_OUTBOUND_ALLOW_HTTP` (`false`), `ALERT_OUTBOUND_ALLOWLIST` (empty), `ALERT_DELIVERY_RETENTION_DAYS` (`30`), `ALERT_MAX_EVENT_AGE_MS` (`21600000`), `SSL_SCAN_CRON` (`0 6 * * *`) |
| Heartbeats | `HEARTBEAT_SWEEP_INTERVAL_MS` (`30000`), `HEARTBEAT_PING_KEEP` (`200`), `HEARTBEAT_PING_RETENTION_DAYS` (`30`), `HEARTBEAT_PING_MAX_BODY_BYTES` (`10240`) |
| Runbooks | `RUNBOOK_WORKER_ENABLED` (`true`), `RUNBOOK_MAX_CONCURRENT_RUNS` (`2`), `RUNBOOK_MAX_SSH_SESSIONS` (`20`), `RUNBOOK_MAX_TARGETS` (`500`), `RUNBOOK_OUTPUT_MAX_BYTES` (`262144`), `RUNBOOK_APPROVAL_TTL_HOURS` (`24`) |
| Ops automation | `PATCH_SCAN_CRON` ‡ (`0 3 * * *`), `PATCH_SCAN_CONCURRENCY` ‡ (`5`), `DRIFT_SCAN_CRON` ‡ (`30 3 * * *`), `DRIFT_SNAPSHOT_KEEP` ‡ (`30`), `ACCESS_EXPIRY_SWEEP_INTERVAL_MS` ‡ (`60000`), `PROMETHEUS_SD_DEFAULT_PORT` ‡ (`9100`) |

‡ Not forwarded by 1.0.0's `docker-compose.yml`. To override one in Docker, add it as a bare key (for example
`STATUS_MAX_ROWS:`) under `services.api.environment`, then set the value in `.env`.

### If `migrate deploy` failed on `20260921000000_postgres_baseline`
A development build (between 0.8 and 1.0) shipped a truncated baseline migration. If a deploy failed on it (`P3009` /
"migrate found failed migrations"), PostgreSQL rejected the whole script before running any of it, so nothing was
created. Check, then mark it rolled back and deploy again:

```bash
# Only _prisma_migrations should be listed:
docker compose exec postgres psql -U rackmap -d rackmap -c '\dt'

docker compose run --rm api pnpm exec prisma migrate resolve --rolled-back 20260921000000_postgres_baseline
docker compose up -d        # the api container runs migrate deploy on start

# Bare metal:
pnpm --filter @inv/api exec prisma migrate resolve --rolled-back 20260921000000_postgres_baseline
pnpm --filter @inv/api db:deploy
```

If `\dt` lists application tables as well (the database was built with `prisma db push`), do **not** roll back: start
the new image and its `ensure-baseline` step reconciles the schema and records every migration as applied.

### After the upgrade

1. `curl -s http://localhost:8080/health/ready` (Docker, through the web container) returns
   `{"status":"ok","db":"ok","backup":{…}}`.
2. Sign in with an existing account. The **Servers** page lists your servers. If it is empty while the dashboard
   shows servers, the web image was not rebuilt.
3. Unlock the vault (or confirm `VAULT_PASSPHRASE` auto-unlocked it) and open a server's **Live Metrics** to confirm
   credentials still decrypt.
4. Review the new features' settings: **Settings → Alerts** (your `NOTIFY_*` settings appear as read-only channels),
   **Settings → Maintenance**, and `PUBLIC_BASE_URL` if you plan to use heartbeats.
5. Once you are satisfied, the `sqlite_data` volume's `inventory.db` is no longer used. Keep the volume itself: it
   still holds your SSH keys.

---

## Moving RackMap to another server (PostgreSQL 18)

A production-grade guide for moving **RackMap** to another server and deploying with **PostgreSQL 18**. Examples use
`192.0.2.10` for the target server and `rackmap.example.com` for its DNS name.

### Upgrading an existing Docker install — notes
- The `postgres` service in `docker-compose.yml` always starts, and the API waits for it to be healthy.
- The API's `DATABASE_URL` is built from `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`. **`POSTGRES_PASSWORD` is required** — there is no default. `DOCKER_DATABASE_URL` overrides the whole URL (e.g. for an external PostgreSQL 18).
- The Postgres volume is mounted at `/var/lib/postgresql`. PostgreSQL 18 images keep their data in `/var/lib/postgresql/18/docker` and refuse to start with a volume at the old `/var/lib/postgresql/data`.
- The `sqlite_data` volume keeps its name and stays mounted at `/data`: it holds your SSH keys (and the old `inventory.db` if you are coming from SQLite).
- If the host already runs PostgreSQL on 5432, set `POSTGRES_HOST_PORT` to publish the container on another loopback port.

---

## 1. Architecture & Overview

```
[ Source Server ]                                      [ Target Server ]
  RackMap Instance                                       RackMap Instance
  • Database:                                            • Database: PostgreSQL 18
    - PostgreSQL 18 (dump)  ────── rsync / scp ──────►     - Docker: pgvector/pgvector:pg18
      OR SQLite dev.db (ETL)                               OR Host Native PostgreSQL 18
  • Critical Secrets (.env) ─────────────────────────►   • Identical Keys (.env)
```

### Supported Target Deployments
- **Option A (Recommended)**: **Docker Compose** — isolated containers for PostgreSQL 18, API, and Web UI.
- **Option B**: **Native Host / Systemd** — host-level PostgreSQL 18 with a systemd service and an Nginx reverse proxy.

---

## 2. Pre-Migration Checklist & Critical Secrets

> [!CAUTION]
> **ENCRYPTION KEYS MUST BE PRESERVED EXACTLY**
> Stored server passwords, SSH keys, and vault credentials are encrypted at rest with **AES-256-GCM** and **PBKDF2** using `APP_ENCRYPTION_KEY` and `VAULT_PASSPHRASE`.
> If these secrets are lost or regenerated on the new server, **all existing server credentials will fail authentication and become permanently unreadable**.

Collect these exact values from your source `.env` file before proceeding:
```bash
APP_ENCRYPTION_KEY="..."       # Or APP_ENCRYPTION_PASSPHRASE
VAULT_PASSPHRASE="..."         # Master Credential Vault passphrase
BETTER_AUTH_SECRET="..."       # User session and auth signing secret
```

Also copy the SSH keys RackMap uses (the `sqlite_data` volume's `/data` in Docker, or `SSH_PRIVATE_KEY_PATH`).

---

## 3. Step 1: Backup & Export on Source Server

### Scenario A: Current Database is on PostgreSQL 18

Bundled Docker PostgreSQL:
```bash
docker compose exec -T postgres pg_dump -U rackmap -d rackmap --no-owner --no-privileges -F p > /tmp/rackmap_pg18_backup.sql
```

Native PostgreSQL 18 on the host:
```bash
pg_dump -h 127.0.0.1 -U rackmap -d rackmap --no-owner --no-privileges -F p > /tmp/rackmap_pg18_backup.sql
```

Verify the backup file is valid and not empty:
```bash
head -n 25 /tmp/rackmap_pg18_backup.sql
ls -lh /tmp/rackmap_pg18_backup.sql
```

(A `rackmap-<timestamp>.dump` from the scheduled backups works too — restore it with `pg_restore` as in
[§9](#9-backups--restore).)

### Scenario B: Current Database is SQLite (0.8 and earlier)

Copy the SQLite file — `/data/inventory.db` in the Docker `sqlite_data` volume, or the file named by
`DATABASE_URL=file:…` on bare metal:
```bash
docker compose cp api:/data/inventory.db /tmp/dev.db     # Docker
cp apps/api/prisma/dev.db /tmp/dev.db                    # bare metal
```
The target imports it with `pnpm --filter @inv/api db:migrate:postgres` — see
[Upgrading 0.8.x → 1.0.0](#upgrading-08x--100).

---

## 4. Step 2: Transfer Data to Target Server

Transfer the project files, database dump, and environment secrets to the target server:

```bash
TARGET_USER="deploy"
TARGET_HOST="192.0.2.10"
TARGET_DIR="/opt/server-inventory"

# 1. Prepare target directory
ssh ${TARGET_USER}@${TARGET_HOST} "sudo mkdir -p ${TARGET_DIR} && sudo chown -R \$(whoami):\$(whoami) ${TARGET_DIR}"

# 2. Transfer application repository (excluding build artifacts and node_modules)
rsync -avz --progress --exclude 'node_modules' --exclude '.git' --exclude 'dist' --exclude '.turbo' ./ ${TARGET_USER}@${TARGET_HOST}:${TARGET_DIR}/

# 3. Transfer database dump and production .env
scp /tmp/rackmap_pg18_backup.sql ${TARGET_USER}@${TARGET_HOST}:${TARGET_DIR}/
scp .env ${TARGET_USER}@${TARGET_HOST}:${TARGET_DIR}/.env
```

---

## 5. Step 3: Deploy on Target Server (PostgreSQL 18)

Log in to the target server:
```bash
ssh deploy@192.0.2.10
cd /opt/server-inventory
```

Choose your deployment method:

---

### Option A: Docker Compose Deployment (Recommended)

#### 1. Configure `.env` on Target Server
Edit `/opt/server-inventory/.env`. Do not copy `.env.example` wholesale; its `PORT`, `NODE_ENV`, and `WEB_ORIGIN` are
development values.
```ini
# Database credentials — the API's DATABASE_URL is derived from these.
# Required; URL-safe: openssl rand -hex 24
POSTGRES_USER=rackmap
POSTGRES_PASSWORD=<generated-password>
POSTGRES_DB=rackmap

# Web UI port & the URL users reach it at
PORT=8080
WEB_ORIGIN="http://192.0.2.10:8080"

# CRITICAL: identical secrets from the source server
APP_ENCRYPTION_KEY="<SOURCE_APP_ENCRYPTION_KEY>"
VAULT_PASSPHRASE="<SOURCE_VAULT_PASSPHRASE>"
BETTER_AUTH_SECRET="<SOURCE_BETTER_AUTH_SECRET>"

# First admin (only used when the database is empty); 12+ characters
SEED_ADMIN_EMAIL=admin@example.com
SEED_ADMIN_PASSWORD=<strong-password>

# Runtime settings
NODE_ENV=production
SCHEDULER_ENABLED=true
METRICS_ENABLED=true
# SSH_ENABLED=true                      # only if you want the browser terminal
# PUBLIC_BASE_URL=https://rackmap.example.com
```

#### 2. Start PostgreSQL 18 First
```bash
docker compose up -d postgres
docker compose ps postgres        # wait for "healthy"
```

#### 3. Ingest Database Backup into PostgreSQL 18
```bash
docker compose exec -T postgres psql -U rackmap -d rackmap < rackmap_pg18_backup.sql
```

Coming from SQLite instead? Skip this step, start the stack (step 4) so the API creates the schema, then run the
import as in [Upgrading 0.8.x → 1.0.0](#docker-compose-upgrade), step 6.

#### 4. Build and Launch API & Web Frontend
```bash
docker compose up -d --build
```

#### 5. Confirm Container Health
```bash
docker compose ps
```
All three services (`postgres`, `api`, and `web`) should show `Up (healthy)`.

---

### Option B: Bare-Metal / Systemd Deployment (Host PostgreSQL 18)

#### 1. Install PostgreSQL 18 on Host (Ubuntu/Debian)
```bash
sudo apt-get update && sudo apt-get install -y curl ca-certificates gnupg lsb-release

# Add official PostgreSQL repository
sudo install -d /etc/apt/keyrings
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/keyrings/postgresql.gpg
echo "deb [signed-by=/etc/apt/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list

sudo apt-get update
sudo apt-get install -y postgresql-18 postgresql-client-18
```

#### 2. Create PostgreSQL 18 Database & Role
```bash
sudo -u postgres psql <<EOF
CREATE ROLE rackmap WITH LOGIN PASSWORD '<strong-password>';
CREATE DATABASE rackmap OWNER rackmap;
GRANT ALL PRIVILEGES ON DATABASE rackmap TO rackmap;
\c rackmap
GRANT ALL ON SCHEMA public TO rackmap;
EOF
```

#### 3. Ingest Backup
```bash
psql -U rackmap -d rackmap -h 127.0.0.1 -W < rackmap_pg18_backup.sql
```

#### 4. Configure Application Environment
The API reads `.env` from its working directory, `apps/api`. The bundled systemd unit and PM2 config both use
`/opt/server-inventory/apps/api/.env`:
```ini
NODE_ENV=production
DATABASE_URL="postgresql://rackmap:<strong-password>@127.0.0.1:5432/rackmap?schema=public"
BACKUP_DIR=/backups               # optional: nightly pg_dump (needs postgresql-client-18, writable by the service user)
PORT=3001
WEB_ORIGIN="https://rackmap.example.com"
BETTER_AUTH_URL="https://rackmap.example.com"
APP_ENCRYPTION_KEY="<SOURCE_APP_ENCRYPTION_KEY>"
VAULT_PASSPHRASE="<SOURCE_VAULT_PASSPHRASE>"
BETTER_AUTH_SECRET="<SOURCE_BETTER_AUTH_SECRET>"
# Serve the built web app from the API process instead of a separate web server:
# SERVE_STATIC_DIR=/opt/server-inventory/apps/web/dist
```

#### 5. Install Dependencies, Build & Run Prisma Deploy
Node.js 24 is required.
```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @inv/api db:deploy
```

#### 6. Enable & Start Systemd Service
Review `server-inventory.service` first: it runs as `www-data` from `/opt/server-inventory/apps/api` and may write
only to that directory, `/data`, and `/backups`.
```bash
sudo cp server-inventory.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now server-inventory
```

---

## 6. Step 4: Verification & Integrity Audit

Run the following checks on the target server:

### 1. API Health Check
```bash
# Docker (through the web container's nginx):
curl -s http://localhost:8080/health/live
curl -s http://localhost:8080/health/ready

# Bare metal (API port):
curl -s http://localhost:3001/health/ready
```
Expected output:
```json
{"status":"ok"}
{"status":"ok","db":"ok","backup":{"status":"ok","lastSuccessAt":"…"}}
```
`/health/ready` returns 503 with `"db":"unreachable"` when PostgreSQL cannot be reached. `backup.status` is `ok`,
`disabled` (no `BACKUP_DIR`), or `degraded` with a `reason`.

### 2. Database Row Count Verification
Verify table counts match the source server:

```bash
# Docker Compose:
docker compose exec postgres psql -U rackmap -d rackmap -c "
SELECT 'Server' AS tbl, (SELECT count(*) FROM \"Server\") AS count
UNION ALL SELECT 'services', (SELECT count(*) FROM services)
UNION ALL SELECT 'user', (SELECT count(*) FROM \"user\")
UNION ALL SELECT 'AuditLog', (SELECT count(*) FROM \"AuditLog\")
UNION ALL SELECT 'system_vault', (SELECT count(*) FROM system_vault);"
```

### 3. Application Sanity Checklist
1. **Web Dashboard**: Open `http://192.0.2.10:8080` and sign in with your existing admin credentials.
2. **Fleet Inventory**: Confirm all servers, tags, IP addresses, and custom attributes render accurately.
3. **Credential Vault**: Go to **Settings → Vault Security**, enter your `VAULT_PASSPHRASE`, and verify it unlocks and credentials decrypt.
4. **Agentless Polling**: Trigger a manual probe or "Test Key Login" on a server to verify SSH connectivity.

---

## 7. Step 5: Reverse Proxy (Nginx) & SSL Cutover

Place Nginx in front of RackMap for TLS and WebSocket forwarding (the SSH terminal), with long timeouts for host
actions:

```nginx
# /etc/nginx/sites-available/rackmap.conf
server {
    listen 80;
    server_name rackmap.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080; # Port published by the web container (PORT)
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

With two proxies in front of the API (this Nginx plus the web container's), set `TRUSTED_PROXY_CIDRS` if this Nginx
is not on loopback or an RFC 1918 address.

Enable site and acquire SSL:
```bash
sudo ln -s /etc/nginx/sites-available/rackmap.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d rackmap.example.com
```

Update `.env` URLs to HTTPS and recreate the API container:
```ini
WEB_ORIGIN="https://rackmap.example.com"
PUBLIC_BASE_URL="https://rackmap.example.com"
```
```bash
docker compose up -d
```

---

## 8. Rollback Contingency Plan

If any critical issue arises during migration:
1. **Source Server Untouched**: Keep the source server running during migration.
2. **Instant Rollback**: If DNS was changed, revert the DNS A/CNAME record to the source server.
3. **Audit**: Because the source server remained unmodified, service resumes with zero loss or corruption.

---

## 9. Backups & Restore

Backups run inside the API process (one replica per run, under a database lease) whenever `BACKUP_DIR` is set:

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_DIR` | unset (Docker: `/backups`) | Where dumps are written. Unset disables backups. |
| `BACKUP_CRON` | `0 2 * * *` | 5-field cron, process-local time (UTC in the Docker image). |
| `BACKUP_KEEP` | `14` | Newest `rackmap-*.dump` files kept; older ones are deleted after each successful dump. |

Each run writes `rackmap-<ISO-timestamp>.dump` (pg_dump custom format, mode `0600`). A failed dump leaves no file and never rotates out a good one; the error is logged and `/health/ready` reports `"backup": {"status": "degraded", "reason": "last_run_failed"}` (readiness itself stays `200`). Other reasons are `invalid_schedule` and `pg_dump_missing`. The database password reaches `pg_dump` only through the `PGPASSWORD` environment variable, never its command line. The Docker image ships `postgresql18-client`; on bare metal install a client at least as new as the server (`postgresql-client-18`).

Restore into the bundled Postgres (stop the API first so nothing writes during the restore):

```bash
docker compose cp api:/backups/rackmap-2026-09-25T02-00-00-000Z.dump ./restore.dump
docker compose stop api
docker compose exec -T postgres pg_restore -U rackmap -d rackmap --clean --if-exists --no-owner < restore.dump
docker compose start api
```

Bare metal: `pg_restore -h 127.0.0.1 -U rackmap -d rackmap --clean --if-exists --no-owner rackmap-<timestamp>.dump`.

A backup is only as good as the secrets that decrypt it: keep `APP_ENCRYPTION_KEY` and `VAULT_PASSPHRASE` somewhere other than the backup volume.
