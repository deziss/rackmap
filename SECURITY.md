# Security Policy

RackMap stores SSH credentials and opens shells on production infrastructure. Security reports are taken seriously.

## Supported versions

| Version | Supported |
|---------|:---------:|
| 0.6.x   | ✅ |
| < 0.6   | ❌ |

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

- Authentication and session handling (Better Auth integration, WebSocket upgrade checks)
- RBAC bypass and privilege escalation between the admin / editor / viewer roles
- Credential handling — at-rest encryption, the credential vault, password reveal, access requests
- SSH command construction and the browser terminal (including command injection)
- SQL/ORM injection, XSS, CSRF, SSRF, and path traversal
- Audit-log tampering or omission

Out of scope:

- Vulnerabilities requiring an already-compromised admin account
- Weaknesses caused by running with the default seeded admin password or without `APP_ENCRYPTION_KEY` set
- Denial of service via unauthenticated request flooding against a deployment with no reverse proxy or rate limiting
- Findings in third-party dependencies without a demonstrated exploit path through RackMap

## Hardening checklist for operators

RackMap is self-hosted, so deployment configuration is part of your security posture:

- [ ] Change `SEED_ADMIN_PASSWORD` immediately after first login
- [ ] Set a strong, unique `APP_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` — never reuse the examples
- [ ] Keep `SSH_ENABLED=false` unless the browser terminal is actually needed (note: this gates only the interactive terminal — metrics, discovery, logs, ATOP and OS-user management still run commands over SSH)
- [ ] Set `TRUSTED_ORIGINS` / `WEB_ORIGIN` explicitly rather than leaving CORS open
- [ ] Terminate TLS at a reverse proxy; do not expose the container port directly to the internet
- [ ] Restrict network access to the RackMap host — it holds credentials for your entire fleet
- [ ] Back up the SQLite volume, and store backups encrypted
- [ ] Review the audit log regularly for unexpected access requests and password reveals
