# Security Policy

RackMap stores SSH credentials, runs root commands, and opens shells on production infrastructure. Security reports
are taken seriously.

## Supported versions

| Version | Supported |
|---------|:---------:|
| 1.0.x   | ✅ Security fixes and bug fixes |
| 0.8.x   | ⚠️ Critical security fixes only — please plan your [upgrade to 1.0](MIGRATION.md#upgrading-08x--100) |
| < 0.8   | ❌ |

Security fixes land on the latest minor release. Please upgrade before reporting an issue against an older version.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

Report it privately through
[GitHub Security Advisories](https://github.com/deziss/rackmap/security/advisories/new).

Please include:

- The affected version and deployment mode (Docker or bare metal)
- A description of the vulnerability and its impact
- Reproduction steps or a proof of concept
- Any suggested remediation

**What to expect:** an acknowledgement within 72 hours, an assessment and severity rating within 7 days, and
coordinated disclosure once a fix is available. We will credit you in the advisory unless you prefer otherwise.

## Scope

In scope:

- Authentication and session handling (Better Auth integration, API keys, WebSocket upgrade checks, sign-in rate limits)
- RBAC bypass and privilege escalation between the admin / editor / viewer roles — including an editor gaining root
  on a managed host through OS users, sudoers, cron, systemd, access grants, or runbooks
- Runbook approval bypass (running a root or approval-required runbook without a second admin)
- Credential handling — at-rest encryption, the credential vault, password reveal, access requests, the one-time sudo
  password (`X-Sudo-Password`)
- Remote command construction and the browser terminal (including command injection into scripts run on hosts)
- The unauthenticated heartbeat check-in endpoint (`/api/v1/ping/:token`)
- SQL/ORM injection, XSS, CSRF, SSRF (including alert-channel webhooks), and path traversal
- License-feature bypass that also bypasses a security control
- Audit-log tampering or omission

Out of scope:

- Vulnerabilities requiring an already-compromised admin account
- Weaknesses caused by running with a default seeded password, without `APP_ENCRYPTION_KEY` set, with
  `SEED_DEMO_DATA=true` or `BILLING_MODE=simulated` on a reachable instance, or with `TRUSTED_ORIGINS="*"`
- Denial of service via unauthenticated request flooding against a deployment with no reverse proxy or rate limiting
- Findings in third-party dependencies without a demonstrated exploit path through RackMap

## Hardening checklist for operators

RackMap is self-hosted, so deployment configuration is part of your security posture:

- [ ] Set a strong `SEED_ADMIN_PASSWORD` (the production seed refuses weak ones) and change it after first login
- [ ] Enable two-factor authentication for every admin (**Security → Two-Factor Authentication**)
- [ ] Set a strong, unique `APP_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, and `POSTGRES_PASSWORD` — never reuse the examples
- [ ] Keep `POSTGRES_BIND=127.0.0.1` (the default) so the database is not reachable from the network
- [ ] Run with `NODE_ENV=production`, `SEED_DEMO_DATA=false`, and `BILLING_MODE=disabled` (the defaults in Docker)
- [ ] Keep `SSH_ENABLED=false` unless the browser terminal is actually needed (note: this gates only the interactive
      terminal — metrics, discovery, logs, ATOP, OS users, cron, systemd, patches, drift, access grants, and runbooks
      still run commands over SSH)
- [ ] Once every server has been contacted, switch to `SSH_HOST_POLICY=tofu` (see the README)
- [ ] Set `WEB_ORIGIN` (and `TRUSTED_ORIGINS` if needed) explicitly; never use `TRUSTED_ORIGINS="*"` on an untrusted network
- [ ] Enable `TRUST_PROXY` only behind a reverse proxy you control
- [ ] Leave `ALERT_OUTBOUND_ALLOW_PRIVATE` / `ALERT_OUTBOUND_ALLOW_HTTP` off unless a webhook really needs them; prefer
      a narrow `ALERT_OUTBOUND_ALLOWLIST`
- [ ] Terminate TLS at a reverse proxy; do not expose the container port directly to the internet
- [ ] Restrict network access to the RackMap host — it holds credentials for your entire fleet
- [ ] Keep the nightly `pg_dump` backups (`BACKUP_DIR`), store them encrypted, and keep `APP_ENCRYPTION_KEY` and
      `VAULT_PASSPHRASE` somewhere other than the backups
- [ ] Mint API keys with the lowest `scopeRole` that works, and give them an expiry
- [ ] Review the audit log regularly for unexpected access requests, password reveals, root actions, and runbook approvals
