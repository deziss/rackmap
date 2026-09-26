# Changelog

All notable changes to RackMap are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] — 2026-09-26

RackMap 1.0 turns the inventory into an operations console: cron editing and monitoring, runbooks across the fleet,
pluggable alerting, systemd control, patch management, drift detection and time-boxed access — on PostgreSQL 18,
with the OS-user management bugs fixed and the security gaps found along the way closed.

**Upgrading from 0.8.x? Read [MIGRATION.md](MIGRATION.md) first** — see *Breaking changes* below.

### Breaking changes
- **PostgreSQL 18 is the only database.** SQLite support is gone. Copy an existing SQLite database across with
  `pnpm --filter @inv/api db:migrate:postgres` (see MIGRATION.md).
- **Docker Compose runs PostgreSQL and requires `POSTGRES_PASSWORD`** (URL-safe). Set `POSTGRES_HOST_PORT` if 5432 is
  already taken on the host.
- **The API image runs as the non-root `node` user.** Volumes written by older root-run images must be re-owned
  (`chown -R node:node /data`) or SSH keys under `/data` become unreadable.
- **Editing and deleting OS users now needs the `remote_os_users` license feature**, like creating them.
- **Checkout and license activation are admin-only**; completing a checkout requires `BILLING_MODE=simulated`, and
  unverified license keys are refused in production.
- **`POST /servers/:id/test-alert` needs `alertChannel:manage`** (admin) and only sends a test event.
- **Rebuild the web image**: nginx changes fix an empty Servers page on 0.8.0 images and add long timeouts for host
  actions.

### Added
- **Cron job editor** on each server page (editor+). Lists user crontabs from the spool directory,
  `/etc/crontab`, `/etc/cron.d/*`, and systemd timers (read-only). Schedule builder with a plain-English
  description and the next run times in the host's time zone, raw editor, diff preview, and "run now".
  Saves are compare-and-set on the file's hash (409 if it changed on the host) and back the previous
  version up to `/var/backups/rackmap-cron` on the host. Root, system files, and users that are
  root-equivalent on the host (sudo/wheel/docker/… membership or a sudoers rule) need admin.
- **Cron heartbeat monitoring.** "Monitor this job" wraps a crontab entry so the host checks in at
  `PUBLIC_BASE_URL/api/v1/ping/<token>` with the job's exit code; missed, late, and failing runs raise
  alerts and recover automatically. Heartbeats can also be created by hand for any job that can call a URL.
- **Runbooks.** Saved, parameterised scripts run against servers chosen by tag, environment, location, or
  name, with target preview, dry run, per-host output, cancel/rerun, and schedules. Parameters reach the
  script as exported environment variables, never string-substituted. Authoring is admin-only; root runs
  requested by editors wait for an admin, and nobody can approve their own run.
- **Alert channels** (Settings → Alerts): Slack, Microsoft Teams, Discord, PagerDuty (incidents open and
  resolve), Telegram, email, and HMAC-signed webhooks, each subscribed to chosen events. Delivery goes
  through a database outbox with retries, backoff, `Retry-After` handling, and a delivery log. Outbound
  requests are pinned to the resolved IP, never follow redirects, and refuse private, link-local, and
  metadata addresses unless allowed. `NOTIFY_WEBHOOK_URL` / `NOTIFY_TELEGRAM_*` keep working and appear as
  read-only channels (the webhook body is unchanged).
- SSL certificates are scanned daily (`SSL_SCAN_CRON`) and alert at 30, 14, 7, and 1 days before expiry.
- **systemd Services tab** — list units, view details and the journal, and start/stop/restart/reload/enable/disable
  them. Protected units (SSH, networking, D-Bus, Docker, `systemd-*`, targets, mounts) need an admin; aliases are
  resolved on the host so a protected unit cannot be acted on under another name.
- **Patch management** — nightly fleet scan of pending and security updates, reboot-required hosts, and kernels for
  apt/dnf/yum/zypper (`PATCH_SCAN_CRON`), with a fleet page, per-server card, and admin-only apply.
- **Drift detection** — nightly configuration snapshots (`DRIFT_SCAN_CRON`) compared with an accepted baseline, with
  severity-ranked events, acknowledgement, and `drift_detected` alerts.
- **Time-boxed access grants** — temporary OS accounts and SSH keys revoked automatically at expiry, with host-side
  expiry as a backstop and alerts when a revoke keeps failing.
- **Prometheus service discovery** (`GET /api/v1/prometheus/sd`), new exporter series (heartbeats, runbooks, alert
  deliveries, patches, drift, access grants), and an example scrape config plus Grafana dashboard in `contrib/`.
- Scheduled PostgreSQL backups with `pg_dump` (`BACKUP_CRON`, `BACKUP_KEEP`); `/health/ready` reports the
  last backup.
- **Status probe history stores far less.** A row is written only when a server's status changes, or once
  per `STATUS_SAMPLE_INTERVAL_MS` (default 15 min) otherwise — about 96 rows per server per day instead of
  about 1,440. The table is capped at `STATUS_MAX_ROWS` (default 10,000) on top of the retention days, and
  admins can see its size and clean it (older than N days, or keep the newest N rows) under
  **Settings → Maintenance**. On upgrade the first prune trims existing history to the cap.
- A per-account sign-in limit (`AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX`, default 10/min) alongside the per-IP one.
- CI runs the test suite against PostgreSQL 18 and fails when migrations drift from the schema.

### Fixed
- **Creating, editing, or deleting an OS user hung forever.** The request never returned and leaked the SSH
  connection. The commands also ignored the server's SSH password, so they only worked with passwordless
  sudo.
- **Deleting an OS user always failed with 400.** The query-string booleans were rejected.
- When sudo rejects the stored server password (RackMap usually logs in with a key, so a stale password only shows up
  on root actions), the OS-user dialogs ask for the sudo password once and retry; it is sent as `X-Sudo-Password`
  for that request only and never stored.
- The Servers page showed no servers on 0.8.0 images (nginx 301-redirected the list to a URL the API does not route),
  and the web container always reported unhealthy.
- **The committed PostgreSQL baseline migration was truncated.** It was missing two tables and every foreign
  key and index, and was not valid SQL, so fresh installs could not migrate. If `migrate deploy` already
  failed on it, see [MIGRATION.md](MIGRATION.md).
- `docker compose up` could not start: the defaults still pointed at SQLite, and the PostgreSQL volume was
  mounted where the PostgreSQL 18 image refuses to start.
- Nightly backups silently did nothing on PostgreSQL.
- `ensure-baseline.mjs` queried SQLite system tables and silently skipped on PostgreSQL.
- SSL-expiry emails were never sent (`lib/mail.ts` only logged). Telegram alerts failed for hostnames
  containing `_`.
- The test suite no longer reuses rows across runs, and refuses to run against a database whose name does
  not end in `_test`.

### Security
- The server's SSH password is no longer placed in the remote command line (it was visible in `ps` on the
  host). Remote scripts are uploaded over stdin into a private temp file, and sudo is probed before any
  password is sent.
- Editors can no longer grant sudo or privileged group membership (sudo, wheel, docker, …), change or delete
  root-equivalent accounts, or set a password containing a newline (which injected extra `chpasswd` lines).
  Password changes are no longer written to the audit log.
- Creating or editing an OS user without `server:sudo` is also refused, on the host, when a requested supplementary
  group is root-equivalent there — a group with its own sudoers rule (`%deploy ALL=…`) or gid 0 — even if it is not on
  the static privileged list.
- Checkout and license activation are admin-only. Checkout completes only with `BILLING_MODE=simulated`,
  and in production any-key license activation is refused without a license server.
- `POST /servers/:id/test-alert` requires `alertChannel:manage` and sends a test event only.

### Dependencies
- Resolved the open Dependabot alerts: vitest 4.1 (test runner config migrated), `deepmerge-ts` 8 via a pnpm override
  (Prisma 6.19 pins 7.x), and a single zod 4.6 across packages; better-auth, nodemailer, hono, postcss, browserslist
  and nanoid were already on patched versions.
- Radix UI, TanStack Router, `@vitejs/plugin-react` and `jspdf-autotable` 5 (PDF export moved to the functional API).
- GitHub Actions: `actions/checkout` v7, `docker/metadata-action` v6, `docker/setup-qemu-action` v4,
  `docker/setup-buildx-action` v4, `docker/build-push-action` v7.
- Docker images stay on Node.js 24 LTS; Dependabot now skips Node majors until the next even release reaches LTS.

### Changed
- PostgreSQL 18 is the only supported database. Compose runs it by default and requires `POSTGRES_PASSWORD`.
- New `server:cron`, `alertChannel`, `heartbeat`, and `runbook` permissions; license features
  `remote_cron` and `runbooks` (Pro and Enterprise).

## [0.8.0] — 2026-09-21

Closes out the three items left open by 0.7.0, and fixes two problems found while doing it.

### Added
- **Multi-replica support.** Background jobs now take a database-backed lease before running, so the
  scheduler, the metrics alert sweep and the nightly backup execute on exactly one replica. Previously the
  only thing preventing double-probing and duplicate notifications was `instances: 1` in the PM2 config —
  `docker compose up --scale api=2` broke it immediately. A holder killed mid-job recovers automatically
  once the lease expires (`JOB_LOCK_TTL_MS`, default 120s); the lease is renewed on a heartbeat so a long
  sweep cannot lose it mid-run.
- **Host-key administration** — `GET /api/v1/ssh-host-keys` (editor+) and `DELETE /api/v1/ssh-host-keys/:id`
  (admin, audited). Migrating to `SSH_HOST_POLICY=tofu` previously meant reading the pin store with
  `sqlite3`, and every legitimate reimage meant deleting a row by hand. The listing also flags a
  fingerprint presented by more than one endpoint.
- `TRUSTED_PROXY_CIDRS` for deployments behind more than one proxy hop.

### Changed
- **Legacy credentials are upgraded opportunistically.** A secret still sealed in the pre-0.7 `v1` envelope
  is re-encrypted to `v3` when its row is written for another reason — never on read, never over a value the
  request is itself supplying, and never for a vault-wrapped `v2` blob. A failed upgrade leaves the stored
  credential untouched.
- Dependency updates clearing 24 of 27 Dependabot alerts: `hono` 4.12.25 → 4.13.8 (six advisories),
  `better-auth` 1.6.18 → 1.6.22 (high), `nodemailer` 9.0.1 → 9.1.1 (high), `@hono/node-server` → 1.19.17,
  and transitively `nanoid` → 3.3.19, `postcss` → 8.5.28, `browserslist` → 4.29.0.
- nginx: the 24-hour read timeout is now scoped to the SSH WebSocket path instead of applying to every API
  request, `Connection: upgrade` is only sent when the client asks for it (it was breaking keep-alive on
  every ordinary request), and `client_max_body_size` is raised to 25 MB so XLSX inventory imports are not
  silently rejected at nginx's 1 MB default.
- Compose: the API healthcheck targets `/health/ready` instead of `/health/live`, which returned a literal
  `ok` and could never fail; added a `start_period` so first-boot migrations do not exhaust the retries; the
  web container has a healthcheck; both have log rotation; Postgres binds to loopback rather than every
  interface.

### Fixed
- **2FA verification would have failed at runtime.** better-auth 1.6.21 added an account lockout that is
  enabled by default and writes `failedVerificationCount`, `lockedUntil` and `verified` on every
  verification. The `TwoFactor` model had none of those columns. Added, with a migration.
- **Container start would have aborted on upgrade.** The 0.7.0 schema-adoption step reconciles a
  pre-existing database with `db push` — which creates every table, including ones belonging to later
  migrations — but then recorded only the baseline as applied. `migrate deploy` then failed trying to create
  a table that already existed, and the container's start chain never reached the application. Adoption now
  records the full migration history.
- **A service's auth token could never be updated.** `updateService` did not destructure `authToken`, so it
  reached Prisma as an unknown field and the update threw, despite the schema accepting it.
- **Rate limiting collapsed to a single shared bucket behind multiple proxies.** better-auth 1.6.21 refuses
  to guess which hop is the client and returns no IP for a multi-value `X-Forwarded-For`, after which every
  caller shares one rate-limit key. `trustedProxies` now defaults to loopback plus the RFC1918 ranges.
- The test suite was tripping better-auth's own sign-in limiter — 15 logins in one shared process against a
  cap of 10 per minute — so suites intermittently failed to collect with 429, hitting a different victim
  each run. Sessions are now memoized per role.

### Still open
- `deepmerge-ts` (high) is pinned exactly by `@prisma/config@6.19.3`; reaching the fixed version needs a
  Prisma major upgrade.
- `vitest` 3 → 4 (medium, devDependency) removes `poolOptions`, which this project relies on to keep every
  spec in one process against a shared SQLite test database. Deferred rather than destabilise the suite.

## [0.7.0] — 2026-09-21

Completes the remediation started in 0.6.1 and makes RackMap usable as a source of truth for automation.
**Read "Action required" before upgrading** — the container now runs real migrations, and one default changed.

### Added
- **API keys that actually authenticate.** `Authorization: Bearer sk_...` works on every `/api/v1` route. The
  middleware existed since 0.5 but was never mounted, so keys authenticated nothing. Keys now carry a role
  ceiling (`scopeRole`, defaulting to `viewer`) and an optional expiry. A key can never exceed its creator's
  role, and it is re-capped at request time against the owner's *current* role — demoting or banning a user
  immediately demotes their keys.
- **SSH host-key verification.** Keys are pinned on first contact and compared on every connection, during key
  exchange and therefore *before* any credential is offered. `SSH_HOST_POLICY=tofu` refuses a changed key;
  the `accept-any` default pins and warns loudly so an existing fleet can populate the store without an outage.
  A mismatch never overwrites the stored key.
- **Prometheus exporter** at `/api/v1/metrics`: server, service and certificate counts by status, per-host
  up/down and probe latency, probe staleness, GPU counts, and days remaining on every tracked certificate.
- **Ansible dynamic inventory** — [`contrib/rackmap-inventory.py`](contrib/rackmap-inventory.py), grouping hosts
  by environment, provider, location, type, owning team, tag, probe status and GPU presence.
- **Brute-force protection** on password reveal (5 per record, 20 per user per 5 minutes) and the SSH credential
  test (10 per host, 30 per user). The SSH terminal now caps password attempts per socket instead of allowing
  unlimited retries for an hour.
- Live terminals re-check authorization every `SSH_REAUTH_INTERVAL_MS` and close on ban, role downgrade,
  session revocation or access-request expiry. Previously authorization was checked once at connect.
- `TRUST_PROXY`, `ALLOW_SELF_SIGNUP`, `SSH_REAUTH_INTERVAL_MS` and `SSH_PRIVATE_KEY_PATH` are now documented,
  validated settings.

### Changed
- **Vault passphrase rotation no longer destroys data.** `POST /api/v1/vault/reset` takes
  `{ currentPassphrase, newPassphrase }` and re-wraps the existing key, preserving every stored credential.
  The old behaviour — mint a new key and orphan everything — is now only reachable via an explicit
  `forceDestroy: true`, and the UI puts it behind a separate checkbox.
- **New encryption envelope.** Secrets are now sealed as `v3.` with a random per-secret salt and a scrypt-derived
  key, replacing an unsalted single-round SHA-256 derivation. Existing `v1.` data still decrypts unchanged —
  **no migration or re-encryption is required** — and the derived key is cached so the SSH path does not pay the
  KDF cost per connection.
- **Migration history squashed to a single baseline.** The previous history was missing seven tables, so the
  Docker path (`db push`) and the systemd path (`migrate deploy`) built *different schemas*. Containers now run
  `migrate deploy`, and existing databases are adopted into the migration history automatically on first start.
- `X-Forwarded-For` is only honoured when `TRUST_PROXY=true`. It previously set the audit-log IP and the
  rate-limit bucket unconditionally, so both were attacker-controlled.
- Bans and role changes take effect on the next request; authenticated routes no longer read a cached session.
- Containers run as a non-root user and install from a frozen lockfile. They still carry devDependencies:
  `pnpm deploy --prod` prunes correctly, but under pnpm's isolated layout the generated Prisma client becomes
  unreachable from the pruned tree, and the Prisma CLI needed for `migrate deploy` is itself a devDependency.
  A larger image beats a broken one; tracked as follow-up.
- Seeding is idempotent: it skips entirely once any user exists, gates demo accounts and sample servers behind
  `SEED_DEMO_DATA`, and refuses to create the first admin with a published default password in production.
- Password reveal now consults the RBAC source of truth instead of comparing role strings inline.

### Fixed
- Soft-deleted servers were still being SSH-polled every five minutes.
- A failure in the server sweep also skipped the service sweep and the history prune for that tick; the three
  jobs are now isolated.
- Metrics-check failures were swallowed entirely, so a server whose credentials had rotated silently stopped
  being checked with nothing in the logs.
- A WebSocket that never reached a shell had no maximum-duration cap at all, and its idle timer was reset by any
  inbound traffic, so a credential-less socket could be held open indefinitely.
- Locking your own vault session no longer stops every background job.
- The test database is reset once per run, so results no longer depend on what a previous run left behind.

### Action required on upgrade
1. **Docker containers now run `prisma migrate deploy`.** Databases created by earlier images are adopted into
   the migration history automatically on first start — no manual step. Take a backup first regardless.
2. **`TRUST_PROXY` defaults to `false`.** Behind a reverse proxy, set `TRUST_PROXY=true` or every audit entry
   records the proxy's address. The bundled `docker-compose.yml` sets it for you.
3. **Existing API keys have no `scopeRole`** and therefore inherit their owner's role. Re-mint any key used for
   automation with `scopeRole: "viewer"`.
4. Fleets wanting strict host-key checking should run on `accept-any` until every host has been contacted, then
   switch to `tofu`. See the README.

## [0.6.1] — 2026-09-21

**Security release. Upgrading is recommended for all deployments.** Several defaults were insecure and several
endpoints were missing authorization checks. A GitHub Security Advisory with full detail follows this release.

**Action required on upgrade — see "Breaking defaults" below.** Two defaults changed in ways that can lock you out
of a working deployment if you do not set the matching environment variables.

### Security
- **Authorization** — added the missing role checks to endpoints that were reachable by any authenticated user,
  including the auto-update status endpoint, the SSH connectivity test, the SSH key listing, the alert-channel
  configuration view, and every SSL mutation. Several of these execute commands on managed hosts or reveal
  configuration, and should never have been viewer-reachable.
- **Input validation** — request fields that are interpolated into shell commands executed on managed servers are
  now strictly validated and shell-escaped: ATOP time windows, OS user shells, home directories, group lists, and
  sudoers command entries. Sudoers rules are written via a base64 payload and a `mktemp` file instead of an
  `echo` redirect, closing both the expansion and the predictable-filename race.
- **CORS and CSRF** — `TRUSTED_ORIGINS` no longer defaults to `*`. It now falls back to `WEB_ORIGIN`, so an
  unconfigured deployment is locked to its own origin instead of reflecting any caller with credentials enabled.
  `*` remains available as an explicit opt-in and logs a warning at boot.
- **Session cookies** — `Secure` is now set explicitly whenever `BETTER_AUTH_URL` or `WEB_ORIGIN` is https, rather
  than being inferred from `BETTER_AUTH_URL` alone.
- **Self-registration** — disabled by default behind the new `ALLOW_SELF_SIGNUP` flag. Previously anyone who could
  reach the API could create a working account.
- **Credential vault** — global unlock and lock now require admin-level vault permissions rather than the
  server-update permission an editor holds. Persisting the passphrase to `.env` requires a separate permission,
  is recorded in the audit log, and the UI checkbox now defaults to off. The `.env` write itself is atomic,
  `0600`, and no longer rewrites commented-out or similarly-named variables.
- **Audit coverage** — added entries for SSH key add/remove, SSH connectivity tests, API key issue/revoke,
  access-request deletion, remote auto-update changes, storage recalculation, all SSL mutations, and all four
  inventory export endpoints. These were previously unrecorded.
- **Information disclosure** — SSH key listings no longer return on-disk private key paths, and key fingerprints
  are now derived from the public key instead of the private key file. Remote shell stderr and raw exception text
  are no longer returned to clients from the auto-update and SSL scan endpoints.
- Removed a hardcoded developer home directory from the SSH key search path; the current user's home is resolved
  at runtime, and `SSH_PRIVATE_KEY_PATH` is now a documented, validated setting.

### Fixed
- Documentation and product copy described the credential vault as zero-knowledge with client-side WebCrypto
  encryption. No client-side cryptography exists: the vault is server-side envelope encryption (PBKDF2 → KEK →
  DEK, AES-256-GCM), the passphrase is sent to the server on unlock, and opting in to auto-unlock writes it to
  `.env`. All affected copy in the README, user guide, security policy and product portal now describes the
  actual design. **Run RackMap behind TLS.**
- `SSH_ENABLED` was documented as an RCE kill-switch. It gates only the browser SSH terminal — metrics,
  discovery, log viewing, ATOP and OS user management still execute commands over SSH when it is `false`.
  Corrected everywhere it appears.
- `SSH_HOST_POLICY` is declared but never read, so setting it has no effect. It is now marked as not implemented.
  (Implemented in 0.7.0.)
- Malformed numeric route parameters on SSL endpoints returned a server error instead of a 400.

### Breaking defaults
1. **`TRUSTED_ORIGINS` defaults to `WEB_ORIGIN` instead of `*`.** If you reach RackMap at a hostname or IP that
   differs from `WEB_ORIGIN`, sign-in will be rejected. Set `TRUSTED_ORIGINS` to a comma-separated list of every
   origin you use, or set `WEB_ORIGIN` correctly. `TRUSTED_ORIGINS=*` restores the old behaviour.
2. **`ALLOW_SELF_SIGNUP` defaults to `false`.** The registration form and the checkout sign-up step are hidden
   unless it is enabled. Set `ALLOW_SELF_SIGNUP=true` to restore self-registration.
3. Persisting the vault passphrase to `.env` now fails loudly instead of silently succeeding, and requires an
   admin. The `.env` file is forced to mode `0600`.
4. Requesting a **custom** sudo permission with an empty command list is now rejected. It previously fell back to
   `ALL`, silently granting unrestricted passwordless root — the opposite of what selecting "custom" implies.
   Supply explicit absolute command paths, or choose the full-access option deliberately.

## [0.6.0] — 2026-09-21

First release prepared for public distribution. No breaking changes to the API or database schema.

### Added
- Dashboard screenshot in the README, captured from a live instance with all identifying data masked
- `CONTRIBUTING.md` — development setup, branch and commit conventions, and a PR checklist
- `SECURITY.md` — private vulnerability reporting, disclosure timeline, scope, and an operator hardening checklist
- `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1
- `CHANGELOG.md` — this file
- GitHub issue templates for bug reports and feature requests, plus a pull request template
- Dependabot configuration for npm and GitHub Actions updates

### Changed
- README restructured around a quick start, a documentation index, and collapsible feature sections
- Rewrote the encryption and credential vault documentation as a two-tier guide with an unlock-mode comparison
- Expanded the configuration reference to cover SMTP, metrics alerting, and threshold variables that were previously undocumented

### Fixed
- Documented end-to-end test command corrected from `pnpm test:e2e` to `pnpm e2e`, which is the script that actually exists
- Documented systemd unit filename corrected to `server-inventory.service`
- Documented prerequisites corrected to Node.js 22+ and pnpm 10+, matching CI and the package manifests
- Tech stack table corrected to React 19
- Quick start now uses the real clone URL instead of a `<repo-url>` placeholder
- CI now builds before it typechecks. `apps/web/src/routeTree.gen.ts` is generated by the
  TanStack Router Vite plugin at build time and is intentionally not committed, so `tsc`
  could never resolve it and the typecheck step failed on every run

### Security
- Replaced a real tenant domain with `example.com` in documentation, an SSL checker comment, and a UI placeholder
- Removed internal planning documents containing production IP addresses from the repository and added them to `.gitignore`
- Hardened `.gitignore` to exclude every `.env` variant except `.env.example`, private keys and certificates, database files, and test artifacts

## [0.5.0] — 2026-09-18

### Added
- Licencia subscription integration: tier enforcement, node limits, feature gating, offline signed-token fallback
- Customer-facing product portal and pricing website at `/portal`, with an interactive mock console and checkout flow
- Infrastructure data ingestion pipeline for Grafana, Kubernetes applications, AI models, backups, and AWS inventory
- AI inference topology — vLLM, Ollama, and llama.cpp endpoints modelled as services with encrypted bearer tokens
- Backup policy tracking: script paths, destinations, cron schedules, and retention windows
- SSL wildcard certificate checking, manual wildcard entry, and automatic related-subdomain omission
- SSH password fallback alongside key authentication, plus global vault administration in Settings
- Log storage telemetry — live `/var/log` size and systemd journal disk usage in the log viewer
- Server total-storage calculation and persistence
- Rich authentication metadata on the inventory metadata card and modal
- Host search on the SSH terminal page and multi-field search on the SSL page
- AGPL-3.0 license, CI workflow, and container publishing with OCI metadata

### Changed
- Sticky hostname and action columns on the servers table, with streamlined columns and domain search
- Service action buttons are always visible rather than revealed on hover

## [0.4.0] — 2026-09-18

### Added
- OS user and sudoers management: full CRUD with shells, groups, UID/GID, lock/unlock, and root/SSH safeguards
- Universal numbered pagination across every table
- Field-wise hardware specification columns
- Flexible encryption passphrases, automated vault unlock at startup, and passphrase reset recovery
- ATOP analysis: top 5 processes by CPU, memory, disk, and network, with a date stepper and interval navigation
- Multi-vendor GPU telemetry (NVIDIA, AMD sysfs, AMD ROCm, Intel) and alert channels
- Viewer access requests for SSH and password reveal
- Server detail page with hardware auto-discovery, vault encryption, sudoers panel, forensic logs, SSH keys, and auto-update management

### Changed
- Sidebar navigation grouped into categorized sections
- Upgraded Tailwind CSS to v4.3.3

### Fixed
- Loopback and localhost probes routed to the Docker host, with auto-probe on server creation
- Prisma invocation in the API Dockerfile

## [0.2.0] — 2026-09-17

### Added
- Full service lifecycle management and monitoring, with detail modal and background polling
- Service password access requests for viewers
- Audit reporting dashboard with PDF export
- Dashboard UI and metric enhancements

### Changed
- Project renamed from Server Inventory to RackMap

### Fixed
- Service import 403 errors and UI crashes
- CPU/RAM column handling and GPU field synchronization on update
- Background polling hardened against invalid ports

[Unreleased]: https://github.com/deziss/rackmap/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/deziss/rackmap/compare/v0.8.0...v1.0.0
[0.8.0]: https://github.com/deziss/rackmap/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/deziss/rackmap/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/deziss/rackmap/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/deziss/rackmap/releases/tag/v0.6.0
[0.5.0]: https://github.com/deziss/rackmap/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/deziss/rackmap/compare/v0.2.0...v0.4.0
[0.2.0]: https://github.com/deziss/rackmap/releases/tag/v0.2.0
