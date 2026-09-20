# Changelog

All notable changes to RackMap are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- `SSH_HOST_POLICY` is declared but never read, so setting it has no effect. It is now marked as not implemented;
  real host-key verification is planned for the next release.
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

[Unreleased]: https://github.com/deziss/rackmap/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/deziss/rackmap/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/deziss/rackmap/releases/tag/v0.6.0
[0.5.0]: https://github.com/deziss/rackmap/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/deziss/rackmap/compare/v0.2.0...v0.4.0
[0.2.0]: https://github.com/deziss/rackmap/releases/tag/v0.2.0
