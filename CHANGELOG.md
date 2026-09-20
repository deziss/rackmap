# Changelog

All notable changes to RackMap are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/deziss/rackmap/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/deziss/rackmap/releases/tag/v0.6.0
[0.5.0]: https://github.com/deziss/rackmap/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/deziss/rackmap/compare/v0.2.0...v0.4.0
[0.2.0]: https://github.com/deziss/rackmap/releases/tag/v0.2.0
