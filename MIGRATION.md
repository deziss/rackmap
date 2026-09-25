# RackMap (Server Inventory) — PostgreSQL 18 Migration Guide

A minimal, production-grade guide for migrating **RackMap** to another server and deploying with **PostgreSQL 18**.

---

## 0. Upgrading an Existing Install — Read First

### Docker now runs PostgreSQL and requires `POSTGRES_PASSWORD`
- The `postgres` service in `docker-compose.yml` always starts (no more `--profile postgres`), and the API waits for it to be healthy.
- The API's `DATABASE_URL` is built from `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`. **`POSTGRES_PASSWORD` is required** — there is no default, and `docker compose up` stops with `set POSTGRES_PASSWORD in .env` until you set it. It is embedded in a URL, so generate a URL-safe one: `openssl rand -hex 24`.
- `DOCKER_DATABASE_URL` still overrides the whole URL (e.g. for an external PostgreSQL 18).
- The Postgres volume is now mounted at `/var/lib/postgresql`. PostgreSQL 18 images keep their data in `/var/lib/postgresql/18/docker` and refuse to start with a volume at the old `/var/lib/postgresql/data`, so the previous mount could not have held any data.
- The `sqlite_data` volume keeps its name and stays mounted at `/data`: it holds your SSH keys (and the old `inventory.db` if you are coming from SQLite — see Scenario B below).
- If the host already runs PostgreSQL on 5432, set `POSTGRES_HOST_PORT` to publish the container on another loopback port.

### `migrate deploy` failed on `20260921000000_postgres_baseline`
A development build shipped a truncated baseline migration. If your deploy failed on it (`P3009` / "migrate found failed migrations"), PostgreSQL rejected the whole script before running any of it, so nothing was created. Check, then mark it rolled back and deploy again:

```bash
# Only _prisma_migrations should be listed:
docker compose exec postgres psql -U rackmap -d rackmap -c '\dt'

docker compose run --rm api pnpm exec prisma migrate resolve --rolled-back 20260921000000_postgres_baseline
docker compose up -d        # the api container runs migrate deploy on start

# Bare metal:
pnpm --filter @inv/api exec prisma migrate resolve --rolled-back 20260921000000_postgres_baseline
pnpm --filter @inv/api db:deploy
```

If `\dt` lists application tables as well (the database was built with `prisma db push`), do **not** roll back: start the new image and its `ensure-baseline` step reconciles the schema and records every migration as applied.

### Backups are now `pg_dump`
With `BACKUP_DIR` set (Docker: `/backups`, the `backups` volume), the API runs `pg_dump --format=custom` on `BACKUP_CRON` (default `0 2 * * *`, process-local time — UTC in the image) and keeps the `BACKUP_KEEP` newest (default 14) `rackmap-<timestamp>.dump` files. The old SQLite file copy did nothing on PostgreSQL. The image ships `postgresql18-client`; on bare metal install a client at least as new as the server (`postgresql-client-18`). `/health/ready` reports `backup.status`. See [§9](#9-backups--restore) for restores.

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
- **Option A (Recommended)**: **Docker Compose** — fully isolated containers for PostgreSQL 18, API, and Web UI.
- **Option B**: **Native Host / Systemd** — host-level PostgreSQL 18 with systemd service and Nginx reverse proxy.

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

---

## 3. Step 1: Backup & Export on Source Server

### Scenario A: Current Database is on PostgreSQL 18

If running PostgreSQL 18 in Docker (e.g. `local_postgres` or compose):
```bash
docker exec -t local_postgres pg_dump -U postgres -d server_inventory   --no-owner --no-privileges -F p > /tmp/rackmap_pg18_backup.sql
```

If running native PostgreSQL 18 on the host:
```bash
pg_dump -U postgres -d server_inventory --no-owner --no-privileges -F p > /tmp/rackmap_pg18_backup.sql
```

Verify the backup file is valid and not empty:
```bash
head -n 25 /tmp/rackmap_pg18_backup.sql
ls -lh /tmp/rackmap_pg18_backup.sql
```

### Scenario B: Current Database is SQLite (`dev.db` / `inventory.db`)

If migrating an older SQLite installation directly to PostgreSQL 18:
```bash
# Copy the active SQLite database file
cp apps/api/prisma/dev.db /tmp/dev.db
```
*(The repository includes an automated zero-data-loss ETL script: `pnpm --filter @inv/api db:migrate:postgres` that will ingest `dev.db` directly into PostgreSQL 18 on the new server).*

---

## 4. Step 2: Transfer Data to Target Server

Transfer the project files, database dump, and environment secrets to the target server:

```bash
TARGET_USER="ubuntu"
TARGET_HOST="target-server-ip"
TARGET_DIR="/opt/server-inventory"

# 1. Prepare target directory
ssh ${TARGET_USER}@${TARGET_HOST} "sudo mkdir -p ${TARGET_DIR} && sudo chown -R \$(whoami):\$(whoami) ${TARGET_DIR}"

# 2. Transfer application repository (excluding build artifacts and node_modules)
rsync -avz --progress   --exclude 'node_modules'   --exclude '.git'   --exclude 'dist'   --exclude '.turbo'   ./ ${TARGET_USER}@${TARGET_HOST}:${TARGET_DIR}/

# 3. Transfer database dump and production .env
scp /tmp/rackmap_pg18_backup.sql ${TARGET_USER}@${TARGET_HOST}:${TARGET_DIR}/
scp .env ${TARGET_USER}@${TARGET_HOST}:${TARGET_DIR}/.env
```

---

## 5. Step 3: Deploy on Target Server (PostgreSQL 18)

Log in to the target server:
```bash
ssh ubuntu@<target-server-ip>
cd /opt/server-inventory
```

Choose your deployment method:

---

### Option A: Docker Compose Deployment (Recommended)

#### 1. Configure `.env` on Target Server
Edit `/opt/server-inventory/.env` (start from `.env.example`):
```ini
# Database Credentials — the API's DATABASE_URL is derived from these.
# Required; URL-safe: openssl rand -hex 24
POSTGRES_USER=rackmap
POSTGRES_PASSWORD=<generated-password>
POSTGRES_DB=rackmap

# Port & URLs (Use target IP or domain)
PORT=3123
WEB_ORIGIN="http://<target-server-ip>:3123"
BETTER_AUTH_URL="http://<target-server-ip>:3123"
TRUST_PROXY=true

# CRITICAL: Identical secrets from source server
APP_ENCRYPTION_KEY="<SOURCE_APP_ENCRYPTION_KEY>"
VAULT_PASSPHRASE="<SOURCE_VAULT_PASSPHRASE>"
BETTER_AUTH_SECRET="<SOURCE_BETTER_AUTH_SECRET>"

# Runtime Settings
NODE_ENV=production
SCHEDULER_ENABLED=true
SSH_ENABLED=true
METRICS_ENABLED=true
```

#### 2. Start PostgreSQL 18 First
```bash
# Launch PostgreSQL 18 container (pgvector/pgvector:pg18)
docker compose up -d postgres

# Confirm PostgreSQL 18 is healthy
docker compose ps postgres
```

#### 3. Ingest Database Backup into PostgreSQL 18
```bash
# Restore the SQL dump into PostgreSQL 18
docker compose exec -T postgres psql -U rackmap -d rackmap < rackmap_pg18_backup.sql
```

*(If migrating from SQLite `dev.db`: place `dev.db` into `apps/api/prisma/dev.db` and run `pnpm --filter @inv/api db:migrate:postgres` to execute the automated ETL).*

**Upgrading a Docker install that ran on SQLite:** the old database is still in the `sqlite_data` volume at `/data/inventory.db`. The ETL needs `python3`, which the image does not ship, so run it from a checkout on the host:

```bash
docker compose cp api:/data/inventory.db ./inventory.db   # before or after upgrading
docker compose up -d --build                               # creates the schema via migrate deploy
cp inventory.db apps/api/prisma/dev.db
# 5432 = POSTGRES_HOST_PORT, if you changed it
DATABASE_URL="postgresql://rackmap:<POSTGRES_PASSWORD>@127.0.0.1:5432/rackmap" \
  pnpm --filter @inv/api db:migrate:postgres               # truncates, then copies every table
docker compose restart api
```

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
CREATE DATABASE server_inventory OWNER rackmap;
GRANT ALL PRIVILEGES ON DATABASE server_inventory TO rackmap;
\c server_inventory
GRANT ALL ON SCHEMA public TO rackmap;
EOF
```

#### 3. Ingest Backup
```bash
psql -U rackmap -d server_inventory -h 127.0.0.1 -W < rackmap_pg18_backup.sql
```

#### 4. Configure Application Environment
In `/opt/server-inventory/.env`:
```ini
DATABASE_URL="postgresql://rackmap:<strong-password>@127.0.0.1:5432/server_inventory?schema=public"
BACKUP_DIR=/var/backups/rackmap   # optional: nightly pg_dump (needs postgresql-client-18)
PORT=3001
WEB_ORIGIN="http://localhost:5173"
BETTER_AUTH_URL="http://localhost:5173"
APP_ENCRYPTION_KEY="<SOURCE_APP_ENCRYPTION_KEY>"
VAULT_PASSPHRASE="<SOURCE_VAULT_PASSPHRASE>"
BETTER_AUTH_SECRET="<SOURCE_BETTER_AUTH_SECRET>"
```

#### 5. Install Dependencies, Build & Run Prisma Deploy
```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @inv/api db:deploy
```

#### 6. Enable & Start Systemd Service
```bash
sudo cp server-inventory.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now server-inventory
```

---

## 6. Step 4: Verification & Integrity Audit

Run the following checks on the target server to guarantee a zero-downtime, zero-data-loss cutover:

### 1. API Health Check
```bash
# 1. API process liveness
curl -s http://localhost:3001/health/live

# 2. Database readiness (queries PostgreSQL 18)
curl -s http://localhost:3001/health/ready
```
Expected output:
```json
{"status":"ok","timestamp":"2026-09-21T..."}
```

### 2. Database Row Count Verification
Verify table counts match the source server:

```bash
# Docker Compose:
docker compose exec postgres psql -U rackmap -d rackmap -c "
SELECT 'Server' AS table, (SELECT count(*) FROM \"Server\") AS count
UNION ALL SELECT 'services', (SELECT count(*) FROM services)
UNION ALL SELECT 'user', (SELECT count(*) FROM \"user\")
UNION ALL SELECT 'AuditLog', (SELECT count(*) FROM \"AuditLog\")
UNION ALL SELECT 'system_vault', (SELECT count(*) FROM system_vault);"
```

### 3. Application Sanity Checklist
1. **Web Dashboard**: Navigate to `http://<target-server-ip>:3123` and log in with your existing admin credentials.
2. **Fleet Inventory**: Confirm all servers, tags, IP addresses, and custom attributes render accurately.
3. **Credential Vault**: Go to **Settings -> Credential Vault**, enter your `VAULT_PASSPHRASE`. Verify it unlocks and displays credentials without decryption errors.
4. **Agentless Polling**: Trigger a manual ping sweep or "Test Connection" on a server to verify SSH connectivity.

---

## 7. Step 5: Reverse Proxy (Nginx) & SSL Cutover

Place Nginx in front of RackMap to enable SSL and WebSocket forwarding for the interactive SSH terminal:

```nginx
# /etc/nginx/sites-available/rackmap.conf
server {
    listen 80;
    server_name rackmap.yourcompany.com;

    location / {
        proxy_pass http://127.0.0.1:3123; # Port mapped by web container
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

Enable site and acquire SSL:
```bash
sudo ln -s /etc/nginx/sites-available/rackmap.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d rackmap.yourcompany.com
```

Update `.env` URLs to HTTPS and restart:
```ini
WEB_ORIGIN="https://rackmap.yourcompany.com"
BETTER_AUTH_URL="https://rackmap.yourcompany.com"
```
```bash
docker compose restart api web
```

---

## 8. Rollback Contingency Plan

If any critical issue arises during migration:
1. **Source Server Untouched**: Keep the source server running during migration.
2. **Instant Rollback**: If DNS was changed, revert DNS A/CNAME record to the source server IP.
3. **Audit**: Because the source server remained unmodified, service resumes with zero loss or corruption.

---

## 9. Backups & Restore

Backups run inside the API process (one replica per run, under a database lease) whenever `BACKUP_DIR` is set:

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_DIR` | unset (Docker: `/backups`) | Where dumps are written. Unset disables backups. |
| `BACKUP_CRON` | `0 2 * * *` | 5-field cron, process-local time (UTC in the Docker image). |
| `BACKUP_KEEP` | `14` | Newest `rackmap-*.dump` files kept; older ones are deleted after each successful dump. |

Each run writes `rackmap-<ISO-timestamp>.dump` (pg_dump custom format, mode `0600`). A failed dump leaves no file and never rotates out a good one; the error is logged and `/health/ready` reports `"backup": {"status": "degraded", "reason": "last_run_failed"}` (readiness itself stays `200`). The database password reaches `pg_dump` only through the `PGPASSWORD` environment variable, never its command line.

Restore into the bundled Postgres (stop the API first so nothing writes during the restore):

```bash
docker compose cp api:/backups/rackmap-2026-09-25T02-00-00-000Z.dump ./restore.dump
docker compose stop api
docker compose exec -T postgres pg_restore -U rackmap -d rackmap --clean --if-exists --no-owner < restore.dump
docker compose start api
```

Bare metal: `pg_restore -h 127.0.0.1 -U rackmap -d server_inventory --clean --if-exists --no-owner rackmap-<timestamp>.dump`.

A backup is only as good as the secrets that decrypt it: keep `APP_ENCRYPTION_KEY` and `VAULT_PASSPHRASE` somewhere other than the backup volume.
