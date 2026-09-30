# RackMap — Configuration Reference

Every RackMap setting is an environment variable. This document is the exhaustive
list. The README's [Configuration](../README.md#%EF%B8%8F-configuration) section is
the same information as quick-reference tables; this one carries the long-form
notes, the migration paths, and the reasoning.

If you just want RackMap running, you do not need this file: `make up` generates a
`.env` with working values.

- [1. Which file goes where](#1-which-file-goes-where)
- [2. How Docker Compose passes variables through](#2-how-docker-compose-passes-variables-through)
- [3. Every setting](#3-every-setting)

---

## 1. Which file goes where

There are two environment files, they have the same variable names, and they are
read by **different programs**. Putting a value in the wrong one is the single
most common configuration mistake.

| File | Read by | Use it for |
|------|---------|-----------|
| `.env` (repository root) | **Docker Compose**, for `${VAR}` interpolation in `docker-compose.yml` | Every Docker deployment. Start from [`.env.example`](../.env.example), or let `make up` generate it |
| `apps/api/.env` | **The API process and the Prisma CLI**, from their working directory | Bare metal, VPS, and local development. Start from [`apps/api/.env.example`](../apps/api/.env.example) |

The systemd unit (`server-inventory.service`) and the PM2 config
(`ecosystem.config.cjs`) in this repository both run the API from the checkout, so
they both pick up `apps/api/.env`.

In Docker the API container has **no** `apps/api/.env`. Everything it sees is
passed in by Compose from the root `.env`, so a variable Compose does not forward
never reaches it — see [section 2](#2-how-docker-compose-passes-variables-through).

### `.env` beats your shell — the `override: true` gotcha

The top of `apps/api/src/env.ts` loads the file with dotenv's `override` flag on:

```ts
// Load .env with override so shell's empty exported vars don't shadow file values
configDotenv({ override: process.env.NODE_ENV !== "test" });
```

That means **a value in `apps/api/.env` wins over the same variable exported in
your shell**, which is the opposite of the usual dotenv behaviour. This trips
people up in exactly one way:

```bash
export DATABASE_URL="postgresql://…/other_db"
pnpm --filter @inv/api dev      # still uses the DATABASE_URL from apps/api/.env
```

To point a run at something else, edit `apps/api/.env` or delete the line from it.
The one exception is `NODE_ENV=test`, where override is off so the test harness's
`TEST_DATABASE_URL` and friends work as you would expect.

### Secrets hygiene

- `.env` and `apps/api/.env` are gitignored. Only the two `.env.example` files are
  committed. `scripts/setup-env.sh` writes `.env` with `umask 077` and `chmod 600`;
  `make doctor` warns if the mode has drifted.
- `APP_ENCRYPTION_KEY` is the **only** copy of the key that decrypts stored server
  credentials. Back it up somewhere other than the backup volume. Losing it makes
  every stored credential permanently unreadable — there is no recovery path.
- `setup-env.sh` never merges into or overwrites an existing `.env`, for that
  reason: silently rotating the key would orphan your data.

---

## 2. How Docker Compose passes variables through

Compose does not hand the API container your whole `.env`. It builds the
container's environment from the `services.api.environment` list in
`docker-compose.yml`, and nothing else. A variable you set in `.env` that is not
listed there is read by Compose, used for interpolation, and then dropped.

Two styles appear in that list:

```yaml
    environment:
      NODE_ENV: ${NODE_ENV:-production}   # explicit, with a default
      …
      # ── Passed through from .env only when set ────────────────────────────
      # A bare key (no value) forwards the variable if .env or the shell sets
      # it, and otherwise leaves it unset in the container so the default in
      # apps/api/src/env.ts applies. Do not write `${VAR:-}` for these: an
      # empty string fails validation for the numeric and URL variables and the
      # API refuses to start.
      PUBLIC_BASE_URL:
      BACKUP_CRON:
```

The bare-key form matters. `${VAR:-}` resolves to an empty string when `VAR` is
unset, and an empty string is not a valid number or URL — `PUBLIC_BASE_URL=` fails
Zod validation and the API will not boot. A bare key leaves the variable out of the
container entirely, so `apps/api/src/env.ts` applies its own default.

**To make Compose forward a variable it does not currently forward,** add it as a
bare key under `services.api.environment` and set the value in `.env`:

```yaml
      STATUS_MAX_ROWS:
```

### What the entrypoint assembles

`DATABASE_URL` is **not** in that list, and any `DATABASE_URL` you put in the root
`.env` is ignored in Docker. `apps/api/entrypoint.sh` builds it before handing off
to the command:

1. `DOCKER_DATABASE_URL` if set — passed through untouched, so you own the
   encoding of a URL you wrote yourself.
2. Otherwise `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` /
   `POSTGRES_HOST` / `POSTGRES_PORT`, percent-encoded into a URL.
3. Otherwise it exits with an error naming both options.

This used to be done by string interpolation in `docker-compose.yml`. Compose
cannot percent-encode, so a password containing `/`, `?` or `#` produced a corrupt
URL: `/` terminates the authority early, so
`postgresql://user:ab/cd@postgres:5432/db` parses host `user` and port `ab`, and
Prisma reports *"invalid port number in database URL"*. `openssl rand -base64 32`
emits `/` in roughly 70% of draws, so this was easy to hit and hard to diagnose —
PostgreSQL itself never parses the password as a URL, so the database container
stayed green while the API crash-looped.

Two consequences:

- **Any `POSTGRES_PASSWORD` is now safe** — the entrypoint percent-encodes it.
  `make setup` still generates hex, because a URL-safe value is one less thing
  to reason about when reading a connection string by eye.
- **One-off commands must use `docker compose run --rm api …`, not `exec`.**
  `exec` starts a process inside the running container without the entrypoint, so
  it has no `DATABASE_URL`.

### Compose-only variables

These are read by `docker-compose.yml` itself and never reach the API:

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_BIND` | `127.0.0.1` | Host address the bundled PostgreSQL port is bound to. Keep it on loopback: the API reaches PostgreSQL over the internal network, so publishing it wider only adds exposure |
| `POSTGRES_HOST_PORT` | `5432` | Host port PostgreSQL is published on. Change it if the host already runs its own |
| `PORT` | `8080` | **Host port for the web UI.** Unlike bare metal, this is not the API's port — the API listens on 3001 inside the network |
| `VITE_SECURITY_LOCK` | `false` | Build argument for the web image. `true` disables copy and right-click in the UI |

`TRUST_PROXY` is a third case: Compose sets it to `true` by default
(`${TRUST_PROXY:-true}`), because the bundled nginx terminates in front of the API
and its forwarding headers can be trusted. The API's own default is `false`. Do not
copy `TRUST_PROXY=false` into a Docker `.env` unless you have removed the web
container.

---

## 3. Every setting

Defaults below are the API's built-in defaults from `apps/api/src/env.ts`, with the
Docker Compose value noted where Compose overrides it.

### Database

RackMap requires PostgreSQL 18. SQLite is no longer supported — to move an old
SQLite install over, see [MIGRATION.md](../MIGRATION.md) (`db:migrate:postgres`).

```ini
# Local / bare-metal: the API connects with DATABASE_URL. Percent-encode any
# special characters in the password.
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/server_inventory?schema=public
```

In Docker the bundled `postgres` service always runs, and the API's `DATABASE_URL`
is built from the parts below by `apps/api/entrypoint.sh`. `POSTGRES_PASSWORD` is
**required**: `docker compose up` refuses to start without it. It is embedded in a
URL, but the entrypoint percent-encodes it, so any characters are safe. `make setup` uses `openssl rand -hex 24`.

```ini
POSTGRES_USER=rackmap
POSTGRES_PASSWORD=
POSTGRES_DB=rackmap

# Postgres is published on the host's loopback only. Change the host port if the
# host already runs its own PostgreSQL on 5432.
# POSTGRES_BIND=127.0.0.1
# POSTGRES_HOST_PORT=5432

# Use an external PostgreSQL 18 instead of the bundled one:
# DOCKER_DATABASE_URL=postgresql://rackmap:<password>@db.example.com:5432/rackmap
```

`DOCKER_DATABASE_URL` is used verbatim, so percent-encode its password yourself.
The bundled `postgres` service still starts and still needs `POSTGRES_PASSWORD`,
but the API does not use it.

### Core & web

```ini
PORT=3000
NODE_ENV=development
BETTER_AUTH_URL=http://localhost:5173
WEB_ORIGIN=http://localhost:5173
```

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` (Compose: `8080`) | Bare metal: the port the API listens on. In Compose it is the **host port for the web UI**; the API listens on 3001 inside the network |
| `NODE_ENV` | `development` (Compose: `production`) | `production` enables the seed's password check, skips demo data, and refuses unverified license keys |
| `WEB_ORIGIN` | `http://localhost:5173` (Compose: `http://localhost:8080`) | URL the web app is reached at, used for CORS and auth cookies. It must agree with `PORT`, or sign-in is rejected |
| `BETTER_AUTH_URL` | `http://localhost:5173` (Compose: `http://api:3001`) | Base URL Better Auth uses. Compose sets it; bare metal usually matches `WEB_ORIGIN` |

### Public URL

Externally reachable base URL of this instance. Managed hosts use it for heartbeat
check-ins and alert messages use it for links. In Docker, `BETTER_AUTH_URL` is the
internal `http://api:3001`, so it cannot stand in. **Leave it commented out rather
than empty: an empty value fails validation.**

```ini
# PUBLIC_BASE_URL=https://rackmap.example.com
```

### Origins and proxies

```ini
# Comma-separated list of origins allowed to call the API (CORS + Better Auth origin checks).
# Leave unset and it defaults to WEB_ORIGIN. Set it explicitly when the web app is served from
# a different host/port than WEB_ORIGIN, e.g.
#   TRUSTED_ORIGINS=https://rackmap.example.com,https://rackmap.internal.example.com
#
# A loopback origin covers its aliases: WEB_ORIGIN=http://localhost:8080 also accepts
# http://127.0.0.1:8080, http://[::1]:8080 and http://0.0.0.0:8080, because they are four
# names for the same interface and a browser sends whichever one is in the address bar. This
# expansion applies to loopback only — a LAN IP, a hostname or a domain still has to be listed
# here in full, scheme and port included, or sign-in returns 403 "Invalid origin".
# "*" is an opt-in wildcard that reflects ANY origin back with credentials enabled and disables
# Better Auth origin validation (CSRF). Only for a trusted private network; it warns at boot.
TRUSTED_ORIGINS=

# Trust X-Forwarded-For / X-Real-IP for the client IP (audit log, rate-limit buckets).
# false (default) = the headers are ignored and the real socket address is used. Leave it
# false whenever the API is directly reachable: otherwise any client can forge its own
# audit-log IP and mint an unlimited rate-limit bucket by rotating the header.
# Set true ONLY when a reverse proxy you control sits in front and overwrites the header.
# The bundled docker-compose.yml puts nginx in front of the API, so a standard Docker
# deployment wants TRUST_PROXY=true — and Compose already defaults it to true.
TRUST_PROXY=false

# CIDRs of the proxies in front of RackMap (comma-separated). Only used when
# TRUST_PROXY=true. Defaults to loopback + RFC1918, which covers the bundled
# nginx and a typical ingress. Set explicitly when a CDN with public egress
# (Cloudflare, Fastly) is in front, otherwise its address is treated as the
# client and every caller shares one rate-limit bucket.
TRUSTED_PROXY_CIDRS=
```

### Authentication & rate limiting

```ini
AUTH_RATE_LIMIT_ENABLED=true
AUTH_RATE_LIMIT_MAX=200
AUTH_RATE_LIMIT_WINDOW=60

# Sign-in, per client IP. Generous so an office behind one NAT is not locked out.
AUTH_LOGIN_RATE_LIMIT_MAX=60
AUTH_LOGIN_RATE_LIMIT_WINDOW=60

# Sign-in, per ACCOUNT (email), whatever the source address. This is what bounds
# password guessing against one user. Window in seconds.
AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX=10
AUTH_LOGIN_ACCOUNT_RATE_LIMIT_WINDOW=60

# Allow visitors to create their own account (assigned the "viewer" role).
# false (default) = signup endpoint disabled; an admin invites/creates users instead.
ALLOW_SELF_SIGNUP=false
```

### Encryption & passphrases

**Tier 1 — database at-rest encryption.** Accepts either a 32-byte base64 key
(`openssl rand -base64 32`) **or** any human-readable passphrase (minimum 8
characters).

```ini
APP_ENCRYPTION_KEY=
# Alternatively, specify a passphrase directly:
# APP_ENCRYPTION_PASSPHRASE=MySuperSecretAppPassphrase123!
```

**Tier 2 — zero-knowledge credential vault.** Master vault passphrase (minimum 8
characters), optional in `.env`:

- If **set**: the server auto-initializes and unlocks the vault at startup,
  enabling background auto-discovery and SSH jobs.
- If **unset**: unlocked interactively per session in the web UI via the Credential
  Vault dialog (auto-locks after 30 minutes).

```ini
VAULT_PASSPHRASE=

# Min 16 chars — generate: openssl rand -hex 32
BETTER_AUTH_SECRET=
```

`BETTER_AUTH_SECRET` never enters a URL, so base64 would also be safe here — hex is
recommended anyway so that there is one generator idiom to copy, and it is what
`scripts/setup-env.sh` writes.

### Scheduler & status history

```ini
SCHEDULER_ENABLED=true
PING_INTERVAL_MS=60000
PING_TIMEOUT_MS=3000
PING_CONCURRENCY=10
STATUS_RETENTION_DAYS=30

# Probe history is sampled: one row per status change, otherwise one per interval
# (0 = store every probe). STATUS_MAX_ROWS caps the table (0 = no cap).
STATUS_SAMPLE_INTERVAL_MS=900000
STATUS_MAX_ROWS=10000
STATUS_FLIP_THRESHOLD=2
```

### Distributed job locking (multi-replica deployments)

The background loops (ping sweep, metrics alerts, nightly backup) take a lease row
in the database before running, so only one replica runs each job per tick. Run
more than one API instance without this and every server is probed twice, every
alert fires twice, and two replicas dump the database at the same time.

`JOB_LOCK_TTL_MS` is the TTL of that lease in milliseconds. It is renewed every
TTL/3 while a job is running, so it only really expires when the holding process
dies — at which point another replica picks the job up at most this long
afterwards. No setting is needed to run a single instance; the lease is simply
always won by that one process.

```ini
JOB_LOCK_TTL_MS=120000
```

### Notifications (optional)

```ini
NOTIFY_WEBHOOK_URL=
NOTIFY_TELEGRAM_BOT_TOKEN=
NOTIFY_TELEGRAM_CHAT_ID=

SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=rackmap@example.com
```

### Live metrics & alert thresholds

```ini
METRICS_ENABLED=true
METRICS_SSH_TIMEOUT_MS=10000

METRICS_ALERT_ENABLED=true
METRICS_ALERT_INTERVAL_MS=300000
ALERT_THRESHOLD_CPU=90
ALERT_THRESHOLD_RAM=95
ALERT_THRESHOLD_DISK=90
```

### Alert channels

Deliveries go through a database outbox and are retried with backoff. Outbound
request policy: link-local and cloud-metadata addresses are always refused; private
ranges and plain `http` are refused unless enabled here or the host/CIDR is on the
comma-separated allowlist.

```ini
ALERT_DISPATCH_ENABLED=true
ALERT_DISPATCH_INTERVAL_MS=5000
ALERT_OUTBOUND_TIMEOUT_MS=10000
ALERT_OUTBOUND_ALLOW_PRIVATE=false
ALERT_OUTBOUND_ALLOW_HTTP=false
ALERT_OUTBOUND_ALLOWLIST=
ALERT_DELIVERY_RETENTION_DAYS=30
# Events older than this (ms) are marked expired instead of being sent late.
ALERT_MAX_EVENT_AGE_MS=21600000
```

### Browser SSH terminal (admin-only)

`SSH_ENABLED` gates **only** the interactive terminal; other features still run
commands over SSH when it is `false`.

```ini
SSH_ENABLED=false
SSH_CONNECT_TIMEOUT_MS=10000
SSH_IDLE_TIMEOUT_MS=300000
SSH_MAX_SESSION_MS=3600000
SSH_MAX_CONCURRENT=5

# How often a live browser-terminal WebSocket re-checks that the operator is still
# authorized (session valid, not banned, role still grants SSH, approved access request
# not expired). Without this the check only ran once, at connection upgrade.
SSH_REAUTH_INTERVAL_MS=60000
```

### SSH keys

```ini
# Absolute path to a private key tried FIRST when connecting to managed servers.
# If unset, well-known locations are probed (/data, /root/.ssh, then the API user's ~/.ssh).
SSH_PRIVATE_KEY_PATH=
```

### SSH host-key verification

`SSH_HOST_POLICY` is the host-key verification policy for **every** outbound SSH
connection (metrics, logs, atop, os-users, discovery, auto-update, key testing and
the browser terminal all share one connect path). Host keys are pinned per
(host, port) endpoint in the `ssh_host_key` table using the real OpenSSH SHA-256
fingerprint — the same string `ssh-keygen -lf` prints — so you can diff them
against the hosts directly.

| Value | Behaviour |
|-------|-----------|
| `accept-any` (default) | Record and log, never refuse. A first sighting is pinned with a warning; a CHANGED key logs a loud error and the connection is still allowed. Use this to populate and review the store |
| `tofu` | Trust on first use. A first sighting is pinned and accepted; a later mismatch aborts the handshake during key exchange, BEFORE any authentication method is offered — so the stored password is never sent to the impostor. (The auth chain falls back to keyboard-interactive and answers every prompt with that password, so a spoofed host would otherwise harvest it once per prompt) |

**Migration path** — do not flip straight to `tofu` on an existing fleet; you have
no pinned keys yet and every connection would be a "first sighting" of whatever
answers.

1. Deploy with `accept-any` (the default). Leave it running until every server has
   been contacted at least once — a full metrics/ping cycle plus one manual
   terminal or "test connection" per server that is not polled.
2. Review what got pinned:

   ```sql
   SELECT host, port, key_type, fingerprint, first_seen_at, last_seen_at
   FROM ssh_host_key ORDER BY first_seen_at;
   ```

   Compare each fingerprint against the host itself:

   ```bash
   ssh <host> 'for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf $f; done'
   ```

   Anything you cannot account for is exactly what this feature exists to catch —
   resolve it before step 4.
3. Confirm coverage: any server missing from the table has never been reached, and
   will TOFU-pin on its first connection after the switch. Reach it first if you can.
4. Set `SSH_HOST_POLICY=tofu` and restart.

Review and manage pins through the API rather than the database:

```
GET    /api/v1/ssh-host-keys       (editor+)
DELETE /api/v1/ssh-host-keys/:id   (admin, audited) — after a legitimate reimage
```

After a legitimate rebuild or reimage, delete that endpoint's row so the next
connection re-pins it:

```sql
DELETE FROM ssh_host_key WHERE host='192.0.2.10' AND port=22;
```

A mismatch never rewrites the stored row — not even `last_seen_at` — so the
evidence survives until you clear it deliberately.

```ini
SSH_HOST_POLICY=accept-any
```

### Backups

`pg_dump` (custom format — restore with `pg_restore`) into `BACKUP_DIR` on
`BACKUP_CRON`. Unset `BACKUP_DIR` = no backups. Docker sets `BACKUP_DIR=/backups`
(the `backups` volume) and ships `pg_dump`; bare metal needs a PostgreSQL client
whose major version is >= the server's (`postgresql-client-18`). The password is
passed to `pg_dump` through `PGPASSWORD`, never on its command line.

```ini
BACKUP_DIR=
# 5-field cron, in the API process's local time zone (UTC in the Docker image).
BACKUP_CRON=0 2 * * *
# Number of newest rackmap-*.dump files kept; older ones are deleted after each
# successful dump. Other files in BACKUP_DIR are never touched.
BACKUP_KEEP=14
```

### Cron heartbeat monitoring

```ini
HEARTBEAT_SWEEP_INTERVAL_MS=30000
HEARTBEAT_PING_KEEP=200
HEARTBEAT_PING_RETENTION_DAYS=30
HEARTBEAT_PING_MAX_BODY_BYTES=10240
```

### Runbooks / fleet command execution

```ini
RUNBOOK_WORKER_ENABLED=true
RUNBOOK_MAX_CONCURRENT_RUNS=2
RUNBOOK_MAX_SSH_SESSIONS=20
RUNBOOK_MAX_TARGETS=500
RUNBOOK_OUTPUT_MAX_BYTES=262144
# Pending approvals expire after this many hours.
RUNBOOK_APPROVAL_TTL_HOURS=24
```

### SSL certificate scan

```ini
# 5-field cron, API process local time.
SSL_SCAN_CRON=0 6 * * *
```

### Ops automation

```ini
# Fleet patch scan (pending / security updates, reboot-required), N hosts at a time.
PATCH_SCAN_CRON=0 3 * * *
PATCH_SCAN_CONCURRENCY=5
# Nightly configuration snapshot for drift detection; snapshots kept per server.
DRIFT_SCAN_CRON=30 3 * * *
DRIFT_SNAPSHOT_KEEP=30
# How often expired temporary accounts / SSH keys are revoked on their hosts.
ACCESS_EXPIRY_SWEEP_INTERVAL_MS=60000
# Scrape port advertised by GET /api/v1/prometheus/sd (node_exporter default).
PROMETHEUS_SD_DEFAULT_PORT=9100
```

### Seed (`prisma/seed.ts` only)

```ini
SEED_ADMIN_EMAIL=admin@example.com
SEED_ADMIN_PASSWORD=Change-Me-Now-123!
```

The seed only acts on an empty database. With `NODE_ENV=production` it refuses a
published default (such as `Change-Me-Now-123!` or `Admin123!`) or anything shorter
than 12 characters, and the API container stops.

`SEED_DEMO_DATA` creates demo accounts (`editor@`/`viewer@`) and sample servers.
Never in production — the credentials are published in this repository. Outside
production, demo data is always seeded.

```ini
# SEED_DEMO_DATA=false
```

### Bare-metal static serving

```ini
# Single-process bare-metal: serve web dist from api
SERVE_STATIC_DIR=
```

Point it at `<repo>/apps/web/dist` to let the API process serve the built web app,
instead of running a separate web server.

### apps/web (Vite build-time only)

```ini
# Leave empty for same-origin via proxy
VITE_API_URL=
```

### Licencia licensing & subscription

```ini
# Licencia Server URL (e.g. http://host.docker.internal:3003 in Docker or https://licencia.example.com)
LICENCIA_URL=
LICENCIA_API_KEY=
LICENCIA_LICENSE_KEY=
LICENCIA_PUBLIC_KEY=
```

Checkout / billing — there is no payment gateway integration. Checkout is
admin-only in both modes.

| `BILLING_MODE` | Behaviour |
|----------------|-----------|
| `disabled` (default) | `POST /checkout/complete` returns 501, and in production a license key is only accepted when Licencia (`LICENCIA_URL` or `LICENCIA_PUBLIC_KEY`) can verify it |
| `simulated` | Marks orders paid without taking payment and accepts any key string. Local demos only — never on a reachable instance |

```ini
BILLING_MODE=disabled
```

### Advanced

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCKER_HOST_OVERRIDE` / `HOST_GATEWAY` | — | The address used when a server's IP is loopback and the API runs in a container. By default it is detected from `host.docker.internal` or the default route |

---

## Checking your configuration

```bash
make doctor          # host-side checks: Docker, compose, .env mode, ports, WEB_ORIGIN
docker compose config -q   # what `make doctor` runs to validate interpolation
make credentials     # the URL and the seeded admin login from .env
```

`make doctor` warns about the failure modes that are invisible until sign-in: a
`.env` that is not mode 600, a `PORT` or `POSTGRES_HOST_PORT` already taken by
something else, a `WEB_ORIGIN` that disagrees with `PORT`, and a `NODE_ENV` that is
not `production` (which seeds demo accounts with published credentials).
