# RackMap (Server Inventory) — PostgreSQL 18 Migration Guide

A minimal, production-grade guide for migrating **RackMap** to another server and deploying with **PostgreSQL 18**.

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
Edit `/opt/server-inventory/.env` (or copy from `.env.docker`):
```ini
# PostgreSQL 18 Connection
DATABASE_URL="postgresql://rackmap:rackmap123@postgres:5432/rackmap?schema=public"
DOCKER_DATABASE_URL="postgresql://rackmap:rackmap123@postgres:5432/rackmap?schema=public"

# Database Credentials
POSTGRES_USER=rackmap
POSTGRES_PASSWORD=rackmap123
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
docker compose --profile postgres up -d postgres

# Confirm PostgreSQL 18 is healthy
docker compose ps postgres
```

#### 3. Ingest Database Backup into PostgreSQL 18
```bash
# Restore the SQL dump into PostgreSQL 18
docker compose exec -T postgres psql -U rackmap -d rackmap < rackmap_pg18_backup.sql
```

*(If migrating from SQLite `dev.db`: place `dev.db` into `apps/api/prisma/dev.db` and run `pnpm --filter @inv/api db:migrate:postgres` to execute the automated ETL).*

#### 4. Build and Launch API & Web Frontend
```bash
docker compose --profile postgres up -d --build
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
CREATE ROLE rackmap WITH LOGIN PASSWORD 'rackmap_secure_pass_2026';
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
DATABASE_URL="postgresql://rackmap:rackmap_secure_pass_2026@127.0.0.1:5432/server_inventory?schema=public"
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
docker compose exec postgres psql -U rackmap -d rackmap -c '
SELECT "Server", (SELECT count(*) FROM "Server") AS count
UNION ALL SELECT "services", (SELECT count(*) FROM services)
UNION ALL SELECT "user", (SELECT count(*) FROM "user")
UNION ALL SELECT "AuditLog", (SELECT count(*) FROM "AuditLog")
UNION ALL SELECT "system_vault", (SELECT count(*) FROM system_vault);'
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
docker compose --profile postgres restart api web
```

---

## 8. Rollback Contingency Plan

If any critical issue arises during migration:
1. **Source Server Untouched**: Keep the source server running during migration.
2. **Instant Rollback**: If DNS was changed, revert DNS A/CNAME record to the source server IP.
3. **Audit**: Because the source server remained unmodified, service resumes with zero loss or corruption.
