# User Guide — RackMap

This guide covers RackMap **1.0**. For installation and configuration see the [README](README.md); for upgrading an
existing install see [MIGRATION.md](MIGRATION.md).

## Table of Contents

1. [Getting Started & Product Portal](#getting-started--product-portal)
2. [Navigation](#navigation)
3. [Dashboard & Server List](#dashboard--server-list)
4. [Adding a Server](#adding-a-server)
5. [Server Detail Page](#server-detail-page)
6. [OS Users & Sudoers Management](#os-users--sudoers-management)
7. [Forensic Logs & Storage Telemetry](#forensic-logs--storage-telemetry)
8. [Live Metrics & ATOP History](#live-metrics--atop-history)
9. [SSH Terminal](#ssh-terminal)
10. [Services Inventory](#services-inventory)
11. [SSL Certificate Tracking](#ssl-certificate-tracking)
12. [Export & Reports](#export--reports)
13. [Tags](#tags)
14. [Lookup Tables](#lookup-tables)
15. [Audit Log](#audit-log)
16. [User Management](#user-management)
17. [Access Requests](#access-requests)
18. [Cron Jobs](#cron-jobs)
19. [Heartbeats](#heartbeats)
20. [Runbooks](#runbooks)
21. [Services (systemd)](#services-systemd)
22. [Patches](#patches)
23. [Drift](#drift)
24. [Access Grants](#access-grants)
25. [Alert Channels & Notifications](#alert-channels--notifications)
26. [Status History Maintenance](#status-history-maintenance)
27. [Security Settings & Credential Vault](#security-settings--credential-vault)
28. [Database, Backups & Upgrades](#database-backups--upgrades)
29. [Licensing, Subscriptions & Quotas](#licensing-subscriptions--quotas)
30. [Roles & Permissions](#roles--permissions)
31. [FAQ / Troubleshooting](#faq--troubleshooting)

---

## Getting Started & Product Portal

The examples below use `http://localhost:8080`, the Docker Compose default. Replace it with the address your RackMap
is served at.

### Product Landing & Pricing Portal (`/portal`)
Before signing in, or when exploring platform capabilities, visit the customer-facing **Product Portal** at `http://localhost:8080/portal`:
- **Interactive Mock Console**: Test the Server Fleet overview, live ATOP Replay, credential vault unlocking, and Remote Sudoers audits.
- **Licencia Plan Calculator**: Toggle between monthly and annual billing to compare Free Community, Pro ($39/mo or $31/mo billed annually), and Enterprise ($249/mo or $199/mo billed annually).
- **One-Minute Quickstart**: Copyable Docker Compose production configuration.
- **FAQ & Architectural Guides**: Deep-dives into agentless SSH, AES-256-GCM envelope vault security, and air-gapped activation.

### Signing In to the Console
Open `http://localhost:8080/login` and sign in with your email and password. The first start creates an admin account
from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` in `.env`. In production that password must be at least 12
characters and not one of the defaults published in the repository. Change it after your first sign-in (**Security →
Change Password**).

After signing in you land on the **Dashboard**. You can return to the Product Portal at any time via the sidebar item
**Product Portal**.

---

## Navigation

The sidebar is grouped into sections. Items you cannot use are hidden.

| Section | Item | Who sees it |
|---------|------|-------------|
| — | Dashboard | everyone |
| Infrastructure | Servers, Services, SSL Certs | everyone |
| | SSH Terminal | admins, when `SSH_ENABLED=true` |
| Automation | Runbooks | admins and editors (admins see a badge for runs awaiting approval) |
| | Heartbeats | everyone |
| | Patches, Drift, Access Grants | admins and editors |
| Management | Lookups | admins and editors |
| | Access Requests (badge: pending requests), Users | admins |
| Observability | Reports, Audit Log | admins |
| | Security, Settings, Product Portal | everyone |

The footer holds the theme toggle, your name and role, and **Sign out**. The sidebar can be collapsed.

---

## Dashboard & Server List

The **Servers** page (`/servers`) shows every server you have access to.

| Column | Description |
|--------|-------------|
| # | Fixed sticky ID column during horizontal scrolling |
| Hostname | Fixed sticky server hostname & domain with solid opaque background |
| IP | IPv4 address |
| Status | Live status dot (Up / Down / Unknown) |
| User | Configured SSH username |
| Password | Password reveal button (masked with one-click copy) |
| CPU | Dedicated processor column (e.g. `12 Cores`) |
| RAM | Dedicated physical memory column (e.g. `15GB`) |
| GPU | Detected GPU count and model |
| Project / Location | Assigned project and datacenter / rack location |
| Tags | Colored categorical badges |
| Actions | Fixed sticky quick actions: health check, SSH copy, dedicated page, terminal, edit, delete |

### Universal Pagination
Every table in RackMap features an interactive pagination bar:
- **Rows Selector**: Choose `10`, `25`, `50`, or `100` rows displayed at a time.
- **Range Summary**: Real-time counter showing `Showing X–Y of Z items`.
- **Numbered Navigation**: Direct jump to any numbered page `[1] [2] [3] ... [N]`, with `Previous` and `Next` buttons, and `First` / `Last` page shortcuts.

**Search** — Type in the search box to filter by hostname, IP, domain, remark, or username. Filters apply instantly.

**Saved views** — save the current filters under a name and switch back to them later.

**Refresh** — Click the refresh button or wait for the automatic 30-second poll.

---

## Adding a Server

Click **Add Server** (top-right). Fill in:

| Field | Required | Notes |
|-------|----------|-------|
| Hostname | Yes | Human-readable name |
| IP Address | Yes | Used for the TCP probe and SSH. Tick **Is Private IP?** for internal addresses |
| SSH Port | No | Default: 22 |
| Username | Yes | SSH login user |
| Password | No | Stored AES-256-GCM encrypted. Used for password / PAM login when no SSH key works, and for `sudo` |
| Domain | No | e.g. `example.com` |
| Environment | No | e.g. production, staging, on-premise, cloud |
| Cloud Provider, Location, Allocated To, GPU Type, Network Type | No | From the lookup tables |
| GPU Count | No | Number of GPUs |
| CPU / RAM / Total Storage | No | Free text, e.g. "2 × Xeon", "128 GB", "1TB NVMe" |
| OS Type | No | e.g. `Ubuntu 22.04` |
| Purpose / Created By / Remark | No | Free-text notes |

Click **Save**. The server appears in the table and is queued for a TCP probe. Adding a server counts against your
license's server limit (10 on the Free tier).

**Edit a server** — Click the pencil icon. Leave the password blank to keep the existing stored password.

**Delete a server** (admin) — Click the trash icon. Deleted servers are removed from the list but kept in the
database for the audit trail, and an admin can restore them.

**Import** — the import wizard reads an Excel file, lets you map its columns, and offers a dry run before anything
is written.

---

## Server Detail Page

**Quick view** — click a **hostname** in the servers table to open the detail modal: status, badges (domain,
environment, cloud provider, location), copy-SSH-command buttons (plain and with `sudo -i`), the server info grid,
tags, and live metrics. Close it with × or Escape.

**Dedicated page** — the *dedicated page* action opens `/servers/:id`, which has these tabs:

| Tab | What it does | Who |
|-----|--------------|-----|
| Overview & Specs | Specifications, hosted applications, SSH key / password tests, and cards for **Patches**, **Configuration drift**, and **Alert routing** (admins) | everyone |
| Live Metrics (5s) | See [Live Metrics](#live-metrics--atop-history) | editors and admins |
| ATOP History & Spikes | See [ATOP](#atop-history) | editors and admins, Pro |
| Forensic Logs & Evidence | See [Forensic Logs](#forensic-logs--storage-telemetry) | editors and admins |
| OS Users & Sudoers | See [OS Users](#os-users--sudoers-management) | editors and admins |
| Cron Jobs | See [Cron Jobs](#cron-jobs) | editors and admins |
| Services | systemd units — see [Services (systemd)](#services-systemd) | editors and admins |
| Web Terminal | Browser SSH terminal | admins, or an approved access request |

The page also carries the **Vault** badge (unlock the credential vault for your session) and the key / password login
controls: *Test Key Login*, *Test Password Login*, *Set / Change Password*, and adding a custom SSH key.

---

## OS Users & Sudoers Management

Manage Linux accounts directly from the server page under the **OS Users & Sudoers** tab (header *OS Users & Sudoers
Permission Control*). Listing accounts needs the editor role; creating, editing, and deleting accounts also needs a
**Pro license** (`remote_os_users`). Without a license the dialog shows a banner saying the feature requires an active
Pro or Enterprise subscription.

### Inspecting Local Accounts
- Lists all local accounts parsed from `/etc/passwd` and `/etc/group` over SSH.
- Displays **Username**, **UID : GID**, **Home Directory**, **Shell**, **Secondary Groups**, and **Sudo Privileges**.
- Summary tiles show **Total Accounts**, **Sudo Privileged**, and **Human Accounts** (UID ≥ 1000).
- The filter box searches by username, shell, home directory, or group name.
- The buttons above the table are **+ Add User**, **Temporary User** (see [Access Grants](#access-grants)), and
  **Refresh Users**. Each row has **Sudo** (admins), **Key** (grant a temporary SSH key for this account), **Edit**,
  and a delete icon.

### Adding a User (+ Add User)
- **Username**: Validated Linux username (`^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*[$]?$`).
- **Password**: Password input with visibility toggle and a **"Generate Strong Password"** button (16-character secure random string). Line breaks are not allowed.
- **Login Shell**: Select from standard shells (`/bin/bash`, `/bin/sh`, `/bin/zsh`, `/usr/sbin/nologin`, `/bin/false`) or enter a custom path.
- **Home Directory**: Auto-fills `/home/<username>` as you type, with an option to customize it.
- **Account Flags**:
  - `Create home directory (-m)`: Ensures user skeleton files and directory are created.
  - `System account (-r)`: Creates a system user without password aging.
- **Secondary Groups**: Comma-separated input with quick-add chips for `sudo`, `docker`, `adm`, `www-data`, `staff`, and `systemd-journal`.
- **UID / GID**: Optional custom numeric identifiers.
- **Sudoers Rules**: Choose between `None`, `Full Sudo without Password (NOPASSWD: ALL)`, `Full Sudo with Password Required (ALL=(ALL:ALL) ALL)`, or `Custom Restricted Commands`.

Click **Create Account**.

### Editing a User (Edit)
Click **Edit** on any user row to change the login shell and home directory, secondary groups, the password (with the
generator), and the lock state (`usermod -L` / `usermod -U`), which blocks logins without deleting data. Click **Save
Changes**. Password changes are applied on the host but never written to the audit log.

**Sudo** on a row opens *Manage Sudo Privileges* and writes an atomic rule under `/etc/sudoers.d/rackmap_*`. This is
admin-only.

### Deleting a User (Delete)
Click the trash icon to remove an account:
- **Root Protection**: Deleting `root` is blocked (*Root Account Safeguard*).
- **Typed confirmation**: For human accounts (UID ≥ 1000), accounts with sudo, and the SSH user RackMap logs in as,
  you must type the exact username.
- **Options**:
  - `Remove user home directory (-r)`: Deletes the home directory and mail spool.
  - `Force deletion (-f)`: Forces removal even if the user owns running processes.

### What editors cannot do
Editors can manage ordinary accounts. They cannot:
- add anyone to sudo or to a privileged group: `sudo`, `wheel`, `admin`, `docker`, `lxd`, `disk`, `root`, `adm`, or
  `shadow`, plus any group that a `%group` sudoers rule or gid 0 makes root-equivalent on that host (checked on the
  host at save time);
- create, change, or delete a root-equivalent account (uid 0, a member of a privileged group, or anyone with a sudoers
  rule).

The dialog still shows these options, but RackMap refuses the change and explains why. Ask an admin.

### When RackMap asks for the sudo password
RackMap usually logs in with an SSH key, so the password saved for a server is only used for `sudo`, and a stale one
goes unnoticed until a root action fails. When sudo on the host rejects the saved password, or needs one that RackMap
does not have, the Add, Edit, Delete, and Manage Sudo dialogs show a **Sudo password** field (*Enter it and retry*):

1. Type the sudo password for the SSH user and submit again.
2. RackMap sends it with that one retry and feeds it only to `sudo` on the host. It is **used once and not saved**,
   never appears on the remote command line, and is cleared the next time the dialog opens.
3. To stop being asked, update the server's saved password (**Set / Change Password** on the server page), or give
   the SSH user passwordless sudo.

---

## Forensic Logs & Storage Telemetry

The **Forensic Logs & Evidence** tab allows real-time forensic auditing of remote systems over SSH without installing any agent software:

### 1. Real-Time Storage Footprint Telemetry
Every log query probes the remote host's log storage consumption and displays telemetry badges:
- **`/var/log` Total Disk Footprint** (Amber Badge): Measured via `du -sh /var/log`, showing total space consumed by all log files on the host (e.g. `3.7G`, `850M`).
- **`journalctl` Systemd Usage** (Blue Badge): Measured via `journalctl --disk-usage`, showing total archived and active systemd journal volume (e.g. `2.6G`, `500M`).
- **Telemetry Locations**: Displayed in the filter toolbar and in the terminal console header next to active line counts.

### 2. Multi-Source Log Streams
Switch between log sources:
- **`journalctl (systemd)`**: Full systemd journal with unit filtering (`-u <unit>`), priority levels, and short-iso timestamps.
- **`/var/log/auth.log`**: Authentication events, SSH login attempts, sudo invocations, and PAM sessions.
- **`/var/log/syslog`**: General system log stream.
- **`dmesg (kernel)`**: Kernel ring buffer logs, hardware faults, and OOM killer notifications.

### 3. Filters & Auto-Querying
- **Priority Filter**: Emergency (0), Alert (1), Critical (2), Error (3), Warning (4), Notice (5), Info (6), Debug (7).
- **Auto-Query Interval**: Select `Manual (Click)`, `Auto: 5s`, `Auto: 10s`, `Auto: 30s`, or `Auto: 60s` for hands-free live monitoring with a pulsing status badge.
- **Evidence Search & Time Range**: Full-text keyword search and time bounds (e.g. `1 hour ago`, `24 hours ago`).
- **Export & Copy**: Export results to a `.log` text file or copy lines to the clipboard.

---

## Live Metrics & ATOP History

Live metrics are collected by SSH-ing into the server and running a shell command — **no software is installed on the target server**.

**Requirements:**
- RackMap can log in to the server (an SSH key it holds, or a saved password)
- `METRICS_ENABLED=true` (default)
- The API can reach the server on its SSH port
- Editor or admin role

**What is shown:**

### CPU
- Load average (1 min, 5 min, 15 min) vs. core count
- Load bar (load avg 1 min / cores × 100%)
- Top 10 processes by CPU usage

### Memory
- Used / Total in MB
- Utilization bar
- Top 10 processes by memory usage

### GPU
Supports NVIDIA, AMD (sysfs or ROCm), and Intel GPUs. Shows per-card:
- Utilization %
- VRAM used / total
- Temperature (°C)

If no GPU is detected, this section is hidden.

### Disk
Per-mount utilization bars (excludes tmpfs, overlay, /proc, /sys, /run, /dev).

### Network
Per-interface RX / TX bytes per second (sampled over 1 second).

Metrics **refresh every 5 seconds** while the view is open. If the SSH connection fails, an error banner shows the exact reason (e.g. "no credentials configured", "connection refused").

### ATOP History
The **ATOP History & Spikes** tab (Pro, `atop_history`) reads the host's `atop` logs: pick a date, browse interval
snapshots, and list the top CPU, memory, and disk processes for any interval. The host needs `atop` installed and
logging.

---

## SSH Terminal

An in-browser SSH terminal powered by xterm.js.

**Enable it:**
1. Set `SSH_ENABLED=true` in your `.env` and restart the API.
2. Only admins can open terminals by default.
3. Editors and viewers must submit an access request (see [Access Requests](#access-requests)).

**Open a terminal:**
1. Click **SSH Terminal** in the sidebar (`/ssh`, admins) or open the **Web Terminal** tab on a server page.
2. In the host list, use the **"Filter hosts by name or IP..."** search bar to locate a server by hostname or IP address.
3. Online hosts display a green status dot with current latency; offline hosts display a red dot.
4. Click a host (or press **Enter**) to open a dedicated terminal session tab.
5. The terminal connects using configured SSH keys or saved passwords, with automatic PAM keyboard-interactive fallback.

**Limits:**
- Idle sessions close after 5 minutes (`SSH_IDLE_TIMEOUT_MS`)
- Sessions close after 1 hour maximum (`SSH_MAX_SESSION_MS`)
- Max 5 concurrent sessions (`SSH_MAX_CONCURRENT`)
- A live session re-checks every minute that you are still allowed to hold it (`SSH_REAUTH_INTERVAL_MS`); a ban, a
  role change, or an expired access request closes it

All SSH open/close events are recorded in the audit log.

---

## Services Inventory

The **Services** page (`/services`, titled *Services Inventory*) tracks microservices, internal applications, AI model
endpoints, and daemons by runtime environment. (Not to be confused with the **Services** tab on a server page, which
manages systemd units — see [Services (systemd)](#services-systemd).)

### 1. Multi-Hosting Runtime Environments
Services are categorized by their hosting model:
- **`server` (Host-Native)**: Applications running directly on bare-metal or cloud hosts (e.g. Mattermost, Jenkins, GitLab, Zabbix, and system daemons).
- **`docker` (Containerized)**: Standalone Docker containers or Docker Compose deployments (e.g. Uptime Kuma, SonarQube, PostHog, MinIO).
- **`k8s` (Kubernetes)**: Kubernetes services and operators with **NodePort** allocation tracking (e.g. Keycloak, RabbitMQ, Redis, Elasticsearch on their NodePorts).

### 2. AI Model & Inference Topology
AI deployments on vLLM, Ollama, and llama.cpp are tracked as first-class services bound to their host server:
- **Hosted Models**: Individual model endpoints (e.g. `llama3.3:latest`, `nomic-embed-text:latest`) are registered with their host server IP and listening port.
- **API Bearer Tokens**: Authenticated endpoints store their bearer tokens encrypted at rest with AES-256-GCM, accessible only to authorized operators.
- **Automatic Server Mapping**: On a server page (`/servers/:id`), all associated AI models and hosted services populate the **Hosted Applications & Services** table.

### 3. Server Backup Automation & Disaster Recovery Tracking
Servers track backup policies and disaster-recovery state:
- **Backup Script Path**: Scripts executed for backups (e.g. `/opt/scripts/docker_dump.sh`, `/opt/scripts/k8s_backup.sh`).
- **Destination Storage**: Where dumps go (local NVMe, or central NFS storage such as `/mnt/nfs/backup/`).
- **Cron Schedules**: When backups run (e.g. `05 21 * * 1-6`, `Every night 11 PM`).
- **Retention Durability**: How long backups are kept (e.g. `60 days`, `30 days`).
- **Data Categories**: Whether the backup holds database volumes, Kubernetes manifests, or full system state.

Services follow the same permission model as servers: editors create and edit, admins delete and restore, and viewers
request access to reveal a stored password.

---

## SSL Certificate Tracking

The **SSL Certs** page (`/ssl`, titled *SSL Status*) monitors domain certificates for upcoming expiration.

- **Search & Filtering**: Filter certificates by domain name, team, project, issuer (e.g. Let's Encrypt, Sectigo), or linked server hostname.
- **Status Indicators**: Badges indicate Valid, Expiring Soon (≤30 days), Expired, or Error.
- **Auto-Discovery**: Extracts domains configured on servers and services.
- **Manual Domains**: Add standalone external domains to monitor (editors and admins).
- **Scanner**: Probes port 443, reads the peer certificate, and records the issuer, validity window, and days remaining. **Scan** runs one now.
- **Daily scan & alerts**: Every certificate is scanned daily (`SSL_SCAN_CRON`, default 06:00) and raises an alert to your [alert channels](#alert-channels--notifications) 30, 14, 7, and 1 days before expiry.
- **Wildcard Domain Monitoring**: Track wildcard certificates (e.g. `*.example.com`). The scanner probes active subdomains or apex hosts on port 443 with SNI to retrieve the authoritative certificate.
- **Automatic Subdomain Omission**: When a wildcard domain is tracked, related subdomains are grouped and hidden from the default table, with a summary banner showing the omission count.
- **Show Wildcard Subdomains Toggle**: Use the **Show wildcard subdomains** checkbox to reveal all covered subdomains.

---

## Export & Reports

On the **Servers** page, click the **Export** dropdown (top-right area):

- **Export Excel (.xlsx)** — Downloads an Excel file with all currently filtered servers
- **Export JSON** — Downloads a JSON file with all currently filtered servers

The **Services** page offers the same. Exports respect the current search filter. Sensitive fields (passwords) are
never included.

**Reports** (admins, sidebar → Observability) summarises the audit trail and can be saved as JSON or PDF.

---

## Tags

Tags are colored labels attached to servers. They show as badges in the server list and drive targeting elsewhere:
runbook target selection, alert channel filters, Prometheus service discovery (`?tag=`), and Ansible `tag_<name>`
groups.

RackMap 1.0 has no tag-management page. Manage tags through the API:

```bash
# Create a tag (editor+); delete with DELETE /api/v1/tags/:id (admin)
curl -X POST https://rackmap.example.com/api/v1/tags \
  -H "Authorization: Bearer sk_..." -H "Content-Type: application/json" \
  -d '{"name":"web","color":"#22c55e"}'

# Attach tags to a server (editor+); tagIds replaces the server's tag list
curl -X PATCH https://rackmap.example.com/api/v1/servers/12 \
  -H "Authorization: Bearer sk_..." -H "Content-Type: application/json" \
  -d '{"tagIds":[1,4]}'
```

Use the search box on the Servers page to filter by tag name.

---

## Lookup Tables

Lookup tables provide dropdown options for:

- **Cloud Providers** — AWS, GCP, Azure, Hetzner, etc.
- **GPU Types** — NVIDIA A100, RTX 3090, etc.
- **Allocated To** — teams or people servers are assigned to
- **Locations** — data centers, regions, racks
- **Server Types** — bare-metal, VM, container host, etc.
- **Network Types** — public, private, VPN, etc.

**Manage lookups** (admins and editors):
1. Go to **Lookups** in the sidebar (*Lookup Management*).
2. Select a category.
3. Click **Add** to create a new entry, or use the edit icon. Only admins can delete entries.

Lookup values appear in server forms and as badges in the server list.

---

## Audit Log

The audit log records every action in the system.

**Access:** Sidebar → **Audit Log** (admin only)

**What is logged:**
- Server and service create / update / delete / restore, import, and export
- Password reveal, metrics view, SSH open/close
- Root actions on hosts: OS users and sudoers, crontab saves and run-now, systemd actions, patch apply, drift
  baseline acceptance, access grants and their revocation, runbook runs and approvals — including actions whose
  outcome on the host is unknown
- Lookup and tag changes
- User create / update / role change / ban / unban / remove, and password reset by an admin
- Access request create / approve / reject / delete
- Alert channel changes and test alerts
- License activation, checkout, vault operations, status-history cleanup
- Sign in / sign in failure / sign out

**Each entry shows:**
- Action badge (color-coded)
- Entity + ID
- Actor email
- IP address
- Timestamp

**Click any row** with a diff icon to expand and see the before/after values.

**Filter:**
- Category: `data`, `auth`, `notification`, or `security`
- Action: type any partial string (e.g. "server" matches all server.* actions)

**Pagination:** Click **Load more** to fetch older entries (cursor-based, 50 per page).

---

## User Management

Sidebar → **Users** (admin only)

**Add a user:**
1. Click **Add User**
2. Enter name, email, password, and role
3. Click Create

**Edit a user:**
- Click the pencil icon to update name and email

**Change role:**
- Use the role dropdown inline in the table
- You cannot change your own role

**Set password:**
- Click the key icon to reset another user's password
- Does not require the old password

**Ban / unban:**
- Click the ban icon to prevent a user from signing in
- Banned users' sessions and API keys stop working immediately; an open terminal closes at its next re-check

**Remove a user:**
- Click the trash icon
- Permanently removes the account and all sessions

Sign-in attempts are rate-limited per IP address and per account (10 per minute by default), so a single account
cannot be brute-forced from many addresses.

---

## Access Requests

Editors and viewers can request temporary access to actions that require higher privileges.

**Request types:**
- **SSH** — open the browser SSH terminal for a specific server
- **Password Reveal** — reveal the stored SSH password for a specific server
- **Service Password Reveal** — reveal a service's stored password

### For viewers / editors

1. Click **Reveal Password** or **SSH Terminal** on a server you don't have access to
2. A request dialog appears — enter an optional note explaining why
3. Submit the request
4. Wait for admin approval
5. Once approved, access is granted until the expiry time set by the admin

### For admins

1. Sidebar → **Access Requests** — pending requests appear with a badge count
2. Click **Approve** or **Reject**
3. When approving, set an expiry duration (e.g. 24 hours)
4. Add an optional admin note

Approved access automatically expires. All actions taken during the approved window are audited.

---

## Cron Jobs

Open a server and choose the **Cron Jobs** tab (*Cron Jobs & Scheduled Tasks*, editors and admins). Anyone with the
tab can read crontabs; **Save to host**, **Run now**, and heartbeat monitoring need a **Pro license** (`remote_cron`).

- **Targets** — the list on the left shows every user crontab found on the host (**+ New** adds one), the system
  crontab `/etc/crontab`, each file in `/etc/cron.d` (**+ New file**, admins), and **systemd → Timers**
  (read-only). Files in `/etc/cron.d` whose names contain a dot are flagged: cron ignores them. The header shows the
  host's time zone and a **Reload from host** button.
- **Reading an entry** — each row shows the schedule, a plain-English description, the next run times in the host's
  time zone, the command, and its label. A *monitored* badge marks entries watched by a heartbeat.
- **Adding or editing** — **Add job**, or a row's menu (Edit, Duplicate, Run now, Delete). In the dialog, pick a
  preset chip (**Every 5 min**, **Hourly**, **Daily at** a time, **Weekly**, **Monthly**, **@reboot**) or type the five
  fields; the description and next runs update as you type. Only syntax that standard cron understands is accepted
  (`L`, `W`, `#`, and `?` are rejected). Tick **Log output to /var/log/rackmap-cron/…** to keep the job's output on the
  host.
- **Raw** switches the target to a plain-text editor for the whole file.
- **Saving** — edits are staged; the save bar shows the line counts, **Show diff**, **Discard**, and **Save to host**.
  If someone changed the file on the host since you loaded it, the save is refused — reload, then re-apply your change.
  The previous version is kept on the host in `/var/backups/rackmap-cron` (last 10 per file).
- **Run now** runs one entry immediately as its user (60-second limit, 64 KiB of output kept) and shows the exit code
  and output. Save pending edits first.
- **Who can edit what** — editors can edit ordinary users' crontabs. Root's crontab, `/etc/crontab`, `/etc/cron.d`,
  and users who are root-equivalent on the host (members of sudo, wheel, admin, docker, lxd, disk, root, adm, or
  shadow, or with a sudoers rule — checked on the host at every save) need an admin.

---

## Heartbeats

A heartbeat is a dead-man's switch: it expects a check-in on a schedule and alerts when one is missed, late, or reports
failure. The **Heartbeats** page is visible to everyone; editors and admins create and edit, and only admins delete.

- **From a cron job** (Pro) — in the cron entry dialog, open **Heartbeat monitoring**, switch on **Monitor this job**,
  set **Grace period (minutes)** (default 5), optionally tick **Measure duration**, and save. RackMap wraps the command
  so the host calls `PUBLIC_BASE_URL/api/v1/ping/<token>/<exit code>` after each run (and `…/start` before it when
  measuring duration). The host needs `curl` or `wget` and must be able to reach `PUBLIC_BASE_URL`. Turning monitoring
  off restores the original command.
- **By hand** — **New heartbeat** gives you a URL for anything else: a script, a systemd `OnFailure=` unit, a
  Kubernetes CronJob. Choose **On a cron schedule** or **Every fixed period**, a time zone, **Grace (minutes)**, an
  optional **Max runtime (minutes)**, and whether to **Alert when late** and **Resume on ping**. Hand-made heartbeats
  work on every license tier.
- **Detail page** — the **How to ping** card has copy-paste snippets for **curl**, **wget**, **systemd**, and
  **Kubernetes**, plus the check-in history.
- **Statuses** — *New* (waiting for the first check-in), *Up*, *Late* (past the expected time, within the grace
  period), *Down* (grace period passed, or the job reported a non-zero exit code), *Paused*. The list shows the last
  30 check-ins per heartbeat.
- **Rotate token** issues a new ping URL; the old one stops working immediately. For cron-created heartbeats, tick
  **Rewrite the crontab line on <host>** to update the host as well.
- Deleting a heartbeat that came from a crontab leaves the wrapped line on the host; its check-ins will then return
  404. Turn monitoring off first.

---

## Runbooks

**Runbooks** (sidebar → Automation, admins and editors) are saved scripts you run on many servers at once. They need a
**Pro license** (`runbooks`).

- **Authoring (admin)** — **New runbook** opens the editor with sections for *Script* (bash or sh), *Parameters*
  (name, type, default, required, allowed pattern, or a list of choices; *secret* values are masked in output),
  *Execution* (**Run as** SSH user or root (sudo), timeout, hosts at a time, stop after N failures, **Require
  approval**, **Allow narrowing targets at run time**), *Targets*, and *Schedule*. Editors see runbooks read-only.
- **Targets** — select by tag, environment, location, and/or individual servers, with exclusions. Filters combine
  with AND across fields and OR within a field. An empty selection is refused rather than meaning "every server".
- **Running** — **Run** shows the resolved server list with warnings (host down, vault locked, no credentials)
  before anything starts. A **Dry run** only checks SSH, the user, bash, and passwordless sudo; the script does not
  run. Root runs, runs on more than 10 hosts, and runs that include a `production` host ask you to type `RUN` to
  confirm.
- **Approvals** — runbooks marked *requires approval*, and any root run requested by an editor, wait for an admin
  (**Request run**). The approver must be a different person from the requester. Pending approvals show under
  *Waiting for approval* and as a sidebar badge, and expire after 24 hours (`RUNBOOK_APPROVAL_TTL_HOURS`).
- **Watching a run** — the run page lists every host with its status, exit code, and output, updating while the
  run is in progress. **Cancel** stops it; **Rerun failed** reruns only the hosts that did not succeed; **Rerun**
  starts it again. Run statuses: Awaiting approval, Queued, Running, Succeeded, Failed, Partially failed, Cancelled,
  Rejected, Expired.
- **Schedules** — **Run on a schedule** runs a runbook on a cron expression in a chosen time zone, with fixed values
  for its parameters. It is not available together with approval. Scheduled runs happen in the background, so
  password-only hosts need the vault unlocked globally or `VAULT_PASSPHRASE` set; otherwise those hosts fail with
  *vault locked* and admins get one alert per day.
- Parameters are passed to the script as environment variables (`$VERSION`, …), plus `RACKMAP_RUN_ID`,
  `RACKMAP_SERVER_ID`, and `RACKMAP_HOSTNAME`. They are never pasted into the script text.

---

## Services (systemd)

Open a server and choose the **Services** tab (*systemd Services*, editors and admins). Listing units and reading
the journal work on every tier; start/stop/restart/reload/enable/disable need a **Pro license** (`service_manager`),
and the tab shows **Actions need Pro** when it is missing.

- **List** — filter by type (Services, Timers, Sockets, All types), by name or description, and by state (active,
  failed, inactive, with counts). Up to 500 rows are shown. **Reload from host** refreshes the list.
- **Details & journal** — open a unit for its properties and journal: the last 20, 100, 200, 500, 1000, or 2000 lines,
  a time filter (last 15 minutes up to 7 days), wrap, copy, and refresh.
- **Actions** — every action asks for confirmation, runs as root on the host, and is recorded in the audit log.
- **Protected units** — SSH, networking, D-Bus, the container runtime (Docker), `systemd-*`, targets, and mounts.
  Editors see a lock icon on actions that could cut the host off; admins get an extra warning, because if the
  connection drops RackMap cannot undo it. Aliases are resolved on the host, so a protected unit cannot be acted on
  under another name.
- Hosts without systemd show *systemd is not running on this host*.

---

## Patches

**Patches** (sidebar → Automation, admins and editors) lists every server's pending updates, security updates,
reboot-required flag, and running vs newest kernel. apt, dnf, yum, and zypper are supported.

- **Nightly scan** — the whole fleet is scanned every night (`PATCH_SCAN_CRON`, default 03:00, `PATCH_SCAN_CONCURRENCY`
  hosts at a time) on every license tier.
- **Tiles and filters** — servers with security updates, pending updates, reboot required, and scan errors; filter by
  *Security updates only*, *Reboot required*, or scan status.
- **Scan all** / a row's **Scan** (editors and admins, Pro) — scan now.
- **Apply** (admins, Pro) — choose **Security updates only** or **All updates**. It runs as root for up to 30
  minutes and **never reboots** the server. On apt, security-only uses `unattended-upgrades` and is refused if it is
  not installed.
- The server page shows the same status in a **Patches** card, visible to every role.
- New security updates and reboot-required hosts raise `patch_available` / `reboot_required` alerts, which resolve
  when the condition clears.

---

## Drift

Drift detection (Pro, `drift_detection`) snapshots every server nightly (`DRIFT_SCAN_CRON`, default 03:30): user
accounts, privileged group members, sudoers rules, crontab hashes, listening ports, enabled systemd units, and
authorized SSH keys.

- The first snapshot becomes the **baseline**. Later scans record each changed category as a drift event. A new root
  key, sudoers rule, uid-0 account, or privileged group member is **critical**. The same unresolved drift is not
  re-reported every night.
- **Drift** (sidebar, page *Configuration drift*) lists events grouped by server, with filters for open or all events
  and by severity. Each event shows its category, the number of changes, when it was seen, and a summary. Editors and
  admins can **Acknowledge** it.
- The **Configuration drift** card on a server page shows *Matches baseline* or *Differs from baseline*. **Scan now**
  (editors and admins) takes a fresh snapshot. **Accept as baseline** (admins) makes the last scan the new baseline,
  after a confirmation.
- Without sudo, categories that need root are listed under *Not checked in the last scan*, never reported as
  "removed".
- `drift_detected` alerts resolve once the drift is cleared or accepted.

---

## Access Grants

Give someone temporary access that RackMap takes away on time. Access grants need a **Pro license**
(`access_expiry`).

- **Where** — **Access Grants → Grant access**, **Temporary User** on a server's OS Users tab, or the **Key** button
  on a user row.
- **Grant temporary access** — choose **Temporary user** (a new OS account) or **Temporary key** (an SSH key added to
  an existing account). Pick a duration (1 hour, 8 hours, 1 day, 7 days, or **Custom…**, at least a minute ahead and at
  most 90 days), what happens **On expiry** (lock or delete the account), and a **Reason** (required).
- **At expiry** RackMap locks or deletes the account, or removes the key from `authorized_keys`. The host enforces the
  expiry as well (`chage`, and `expiry-time` on OpenSSH 8.2+), so access ends even if RackMap is down. Revocation still
  works after the server has been removed from the inventory.
- **Access Grants** page (*Access grants*) — filter by type and status (Active, In progress, Revoked, Revoke failed).
  Each grant shows a live countdown, amber under an hour and red under five minutes. **Change expiry** and **Revoke
  now** (or **Retry revoke**) are available to the grant's creator and to admins.
- If a revoke keeps failing, RackMap retries with backoff; after five failures the grant is marked *Revoke failed* and a
  critical alert fires.
- **Editors** cannot grant sudo, add privileged groups, or target root-equivalent accounts; the dialog hides the sudo
  option and warns about privileged groups. Ask an admin.
- Password-only hosts need the credential vault unlocked (**Settings → Vault Security**, **Security → Master
  Credential Vault**, or `VAULT_PASSPHRASE`) for grants to be created and revoked.

---

## Alert Channels & Notifications

Admins manage channels under **Settings → Alerts** (card *Alert channels*). Editors can read the channel list
through the API.

- **Types** — Slack, Microsoft Teams (Workflows webhook), Discord, PagerDuty (Events API v2), Telegram, webhook, and
  email (needs `SMTP_HOST`). The Free tier allows **one** channel of type Slack, Discord, Telegram, email, or webhook,
  without filters or custom templates; a banner shows how many you have used. A Pro license (`multi_channel_alerts`)
  adds unlimited channels, Teams, PagerDuty, routing filters, and custom webhook templates. Channels that are over the
  free allowance show a **needs Pro** badge, and their deliveries are logged as suppressed rather than deleted.
- **Events** — each channel subscribes to the events it wants: server/service down and recovered, metric thresholds
  (CPU/RAM/disk/GPU), SSL certificate expiring, heartbeat late/failed/recovered, runbook failed/succeeded/awaiting
  approval, security updates available, reboot required, configuration drift, access requests, temporary access
  expired or revoke failed, system notices, and test alerts. Filters can limit a channel to specific servers, tags,
  environments, or a minimum severity.
- **Delivery** — every alert is queued and retried with backoff (up to six attempts), honouring `Retry-After`. The
  **Delivery log** action shows each attempt. **Send test** posts a clearly labelled test message and never pages
  anyone for real.
- **Per server** — the **Alert routing** card on a server page (admins) shows which channels receive that server's
  alerts; **Send test alert** queues a test event for exactly those channels. It is a `test` event, not a fake outage,
  so PagerDuty is never paged.
- **PagerDuty** incidents are opened on failure and resolved automatically on recovery.
- **Webhooks** carry `X-Rackmap-Event`, `X-Rackmap-Delivery` (stable across retries — use it to deduplicate),
  `X-Rackmap-Timestamp`, and, when a signing secret is set, `X-Rackmap-Signature: sha256=<HMAC-SHA256 of
  "<timestamp>.<raw body>">`.
- **Safety** — webhook URLs must be `https` and resolve to public addresses unless the operator allows private or
  plain-`http` targets with `ALERT_OUTBOUND_ALLOW_PRIVATE`, `ALERT_OUTBOUND_ALLOW_HTTP`, or
  `ALERT_OUTBOUND_ALLOWLIST`. Cloud metadata and link-local addresses are always refused, and redirects are never
  followed.
- **Legacy settings** — `NOTIFY_WEBHOOK_URL` and `NOTIFY_TELEGRAM_BOT_TOKEN` / `NOTIFY_TELEGRAM_CHAT_ID` still work
  and appear as read-only channels (they do not count against the Free limit). The webhook keeps its original body,
  for example
  `{"event":"status_flip","type":"server","serverId":…,"hostname":…,"ip":…,"port":…,"from":"up","to":"down","ts":…}`.
- **Email** preferences per user (**Settings → Notifications**) still apply in addition to channels. Status alerts
  fire after `STATUS_FLIP_THRESHOLD` consecutive failures (default 2) to avoid alert storms on transient blips.
- SSL certificates are scanned daily (`SSL_SCAN_CRON`) and alert 30, 14, 7, and 1 days before expiry.

---

## Status History Maintenance

Every server probe produces an up/down result. RackMap keeps a sampled history of them: a row is written when a
server's status changes, otherwise at most once every 15 minutes (`STATUS_SAMPLE_INTERVAL_MS`), and the table is
capped at 10,000 rows (`STATUS_MAX_ROWS`) as well as `STATUS_RETENTION_DAYS` (30). Older, unsampled installs could
hold millions of rows; the first automatic prune after upgrading trims them to the cap.

Admins can see and clean the history under **Settings → Maintenance** (card *Status probe history*):

- **Stats** — *Stored rows*, *Servers with history*, *Oldest*, and *Newest*, plus the current sampling interval and
  the automatic pruning limits.
- **Delete rows older than** — choose 1 day, 7 days, 30 days, 90 days, or everything, then **Clean**.
- **Keep only the newest** — enter a row count (default 10000), then **Trim**.

Both ask for confirmation. Deleted history cannot be recovered, but current server status is not affected. Each
cleanup is recorded in the audit log.

---

## Security Settings & Credential Vault

The **Security** page (`/security`) has, in order: **Profile**, **Change Password**, **Two-Factor Authentication**,
**Master Credential Vault**, and **API Keys**.

### Are Server Passwords Actually Encrypted or Just Gated?

**Server passwords are AES-256-GCM encrypted, not just gated or masked:**
1. **At-Rest Database Encryption**: The `passwordEnc` column never contains plaintext passwords. It stores encrypted payloads:
   - `v2.<iv>.<auth_tag>.<cipher>` (when using the Master Credential Vault DEK)
   - an application-key envelope (when using the at-rest `APP_ENCRYPTION_KEY`)
2. **Authenticated Encryption (AEAD)**: Every encrypted value uses a random 12-byte initialization vector (IV) and a 16-byte authentication tag, ensuring integrity and preventing tampering.
3. **API Stripping**: All server listing, query, and detail endpoints strip `passwordEnc` at the service layer. The REST API only returns `hasPassword: true/false`.
4. **On-Demand In-Memory Decryption**: Decryption only happens in memory when:
   - An authorized operator clicks "Reveal Password" (which logs an audit event).
   - The backend opens an SSH connection or runs a background job.

### Global Admin Vault Configuration (Settings → Vault Security)

Administrators can unlock the vault once for the whole instance:
1. Open **Settings → Vault Security** (card *Credential Vault & Encryption*).
2. Enter the master passphrase and click **Unlock Globally**.
3. Tick **Keep unlocked permanently (save to .env file for auto-unlock on container reboot)** to save
   `VAULT_PASSPHRASE` into the environment file, so the vault unlocks whenever the API restarts.
4. **Lock Vault Now** locks it again.

### 1. Master Credential Vault & Encryption Passphrases

RackMap uses two tiers of encryption to protect server credentials and access keys:

| Encryption Tier | Configuration Location | Purpose | Accepted Formats |
|---|---|---|---|
| **Tier 1: At-Rest Encryption** | `.env` (`APP_ENCRYPTION_KEY` or `APP_ENCRYPTION_PASSPHRASE`) | Encrypts server passwords and tokens in the database (AES-256-GCM) | 32-byte base64 string (`openssl rand -base64 32`) **or** any passphrase (min 8 chars) |
| **Tier 2: Credential Vault** | `.env` (`VAULT_PASSPHRASE`) **or** the web UI (Settings → Vault Security, Security, `/servers/:id`) | Master envelope encryption (PBKDF2 / AES-256, format `v2.<iv>.<tag>.<cipher>`). Derives an in-memory KEK and ephemeral 256-bit DEK | Any master passphrase (min 8 chars) |

#### Setting Encryption in `.env`
```bash
# Tier 1: application at-rest key (generate your own — never reuse an example value)
APP_ENCRYPTION_KEY=<output of: openssl rand -base64 32>
# Or a human-readable passphrase:
# APP_ENCRYPTION_PASSPHRASE="<long passphrase>"

# Tier 2: master credential vault passphrase (optional, for headless auto-unlock)
VAULT_PASSPHRASE="<long passphrase>"
```

#### Benefits of `VAULT_PASSPHRASE` in `.env`
- **Headless Auto-Unlock**: The API unlocks the vault on startup.
- **Background Jobs**: Auto-discovery, scheduled runbooks, patch and drift scans, access-grant revocation, and other
  background SSH jobs can decrypt server credentials without an operator unlocking the vault every 30 minutes.

#### Interactive Unlocking via Web UI
If `VAULT_PASSPHRASE` is left unset:
1. The vault is locked when the server boots.
2. Click the **"Vault: Locked"** badge on the **Security** page or in the header of any **Server Detail** page (`/servers/:id`).
3. Enter your master passphrase. Your session stays authorized for 30 minutes before auto-locking.

#### Changing or Recovering the Master Passphrase
Two different operations live behind the same dialog. Only one of them loses data.

**Rotating the passphrase (safe, the normal case)**
1. Open **Settings → Vault Security → Reset / Change Passphrase**, or **Manage / Reset Passphrase** on the Security page.
2. Enter the **current** passphrase, then the new one twice (minimum 8 characters).
3. Click **Change Passphrase**. The data-encryption key is re-wrapped under the new passphrase. **Every stored credential keeps working** — nothing needs re-entering.

**Recovering a forgotten passphrase (destructive)**
1. In the same dialog, tick **"I have lost the current passphrase — destroy and re-key"**.
2. Click **Destroy & Re-key Vault** and confirm.
3. A brand-new data-encryption key is generated.

> ⚠️ The destructive path is irreversible. Every server and service password encrypted under the old passphrase
> becomes permanently unreadable and must be re-entered by hand. Only use it when the passphrase is genuinely lost.

A request that supplies neither the current passphrase nor the explicit destroy flag is rejected — the API will
not guess which one you meant.

### 2. Account Security & Two-Factor Authentication (2FA)

- **Change Password**: Update your local account password at any time.
- **Two-Factor Authentication (2FA / TOTP)**:
  1. Click **"Enable 2FA"**.
  2. Scan the QR code in Google Authenticator, Authy, or 1Password.
  3. Enter the 6-digit code to activate two-factor authentication.
- **API Keys**: Create scoped tokens for automation. A key never exceeds your own role, can expire, and is shown only
  once (*Copy this key — shown only once*). See the [README](README.md#-automation--api-keys).

---

## Database, Backups & Upgrades

RackMap stores its data in **PostgreSQL 18**; SQLite is no longer supported.

- **Docker Compose** runs the database for you. Set `POSTGRES_PASSWORD` in `.env` before the first start (URL-safe,
  e.g. `openssl rand -hex 24`). If the host already uses port 5432, set `POSTGRES_HOST_PORT`.
- **External database** — set `DOCKER_DATABASE_URL` (Compose) or `DATABASE_URL` (bare metal).
- **Backups** — with `BACKUP_DIR` set (Compose: `/backups`), RackMap runs `pg_dump` on `BACKUP_CRON` (default 02:00)
  and keeps the newest `BACKUP_KEEP` (default 14) dumps. `/health/ready` reports the last backup's status. Restore
  steps are in [MIGRATION.md](MIGRATION.md#9-backups--restore).
- **Upgrading** from 0.8.x, or from an older SQLite installation, is covered step by step in
  [MIGRATION.md](MIGRATION.md#upgrading-08x--100).

---

## Licensing, Subscriptions & Quotas

RackMap integrates with **Licencia** for subscription tiers and server quotas.

### 1. Subscription Tiers
- **Free Community Edition**: The default, with no configuration. Up to **10 servers**, full inventory, probes, live
  metrics, logs, the SSH terminal, access requests, the audit log, hand-made heartbeats, read-only views of OS users,
  crontabs, systemd units and the patch report, and one alert channel.
- **RackMap Pro**: Up to **100 servers**, and adds hardware auto-discovery, ATOP history, OS user create/edit/delete,
  automated OS updates, unlimited alert channels (including Teams and PagerDuty), the cron editor and heartbeat
  monitoring, runbooks, systemd actions, patch scan and apply, drift detection, and time-boxed access grants.
- **RackMap Enterprise**: Everything in Pro with **unlimited servers**.

A Licencia entitlement can override these limits.

### 2. Managing Your Subscription (admins)
1. Open **Settings → Subscription & Billing** (card *Subscription & Licensing*).
2. View your plan badge, **Managed Nodes Capacity** (`X / Y Servers`), and the **Active Feature Entitlements**; features
   you do not have are marked **PRO**.
3. To activate a key, enter your Licencia key (`LIC-XXXX-XXXX-XXXX-XXXX`) and click **Activate**.
4. For **air-gapped / offline deployments**, click *"Air-gapped deployment? Paste offline lease token"* and paste your signed Ed25519 token.
5. To remove a license, click **Deactivate License (Return to Free)**.

Activating a license, deactivating it, and checkout are admin-only. **Upgrade / Checkout** can only complete when the
operator has set `BILLING_MODE=simulated` (for demos), because RackMap has no payment gateway. In production, a
license key is accepted only if Licencia can verify it. When a feature is not licensed, the action fails with a
message saying it requires an active Pro or Enterprise subscription.

---

## Roles & Permissions

| Action | Admin | Editor | Viewer |
|--------|:-----:|:------:|:------:|
| View servers, services, SSL certificates, heartbeats, patch report | ✓ | ✓ | ✓ |
| View server metrics, logs, ATOP | ✓ | ✓ | — |
| Add / edit servers, services, SSL entries | ✓ | ✓ | — |
| Delete / restore servers, services, SSL entries | ✓ | — | — |
| Reveal server/service password | ✓ | ✓ | Request |
| SSH terminal | ✓ | Request | Request |
| Export data | ✓ | ✓ | ✓ |
| OS users (not sudo, privileged groups, or root-equivalent accounts) | ✓ | ✓ | — |
| Sudoers rules and privileged groups | ✓ | — | — |
| Cron editor (ordinary users' crontabs) | ✓ | ✓ | — |
| Cron: root, `/etc/crontab`, `/etc/cron.d`, root-equivalent users | ✓ | — | — |
| systemd actions (not protected units) | ✓ | ✓ | — |
| systemd actions on protected units | ✓ | — | — |
| Patch scan | ✓ | ✓ | — |
| Patch apply | ✓ | — | — |
| Drift: scan and acknowledge | ✓ | ✓ | — |
| Drift: accept baseline | ✓ | — | — |
| Access grants: create, and extend/revoke your own | ✓ | ✓ | — |
| Access grants: extend/revoke anyone's | ✓ | — | — |
| Heartbeats: create, edit, pause, rotate | ✓ | ✓ | — |
| Heartbeats: delete | ✓ | — | — |
| Runbooks: run, cancel, rerun | ✓ | ✓ | — |
| Runbooks: author and approve (not your own run) | ✓ | — | — |
| Alert channels, server test alert | ✓ | — | — |
| Manage lookups | ✓ | ✓ (Create/Edit) | — |
| Delete lookups | ✓ | — | — |
| Settings → Maintenance, Vault Security, Subscription | ✓ | — | — |
| View audit log and reports | ✓ | — | — |
| Manage users | ✓ | — | — |
| Approve access requests | ✓ | — | — |

**Request** = submit an access request; access granted after admin approval with an expiry time. Several actions also
need a Pro license — see [Licensing](#licensing-subscriptions--quotas). The complete matrix is in the
[README](README.md#-rbac).

---

## FAQ / Troubleshooting

**Q: Live metrics show "no credentials configured"**
> RackMap has neither a working SSH key nor a saved password for this server. Add an SSH key from the server page,
> or edit the server and add the password.

**Q: Live metrics show "connection refused" or "host unreachable"**
> The API cannot reach the server on its SSH port. Check: (1) the IP in the server record, (2) that the firewall allows SSH from the RackMap host, (3) that SSH is running on the target.

**Q: An OS-user dialog asks for a "Sudo password"**
> Sudo on the host rejected the saved server password, or needs one RackMap does not have. Type it to retry once; it
> is not saved. To stop the prompt, update the server's saved password or give the SSH user passwordless sudo. See
> [When RackMap asks for the sudo password](#when-rackmap-asks-for-the-sudo-password).

**Q: An action fails with "requires an active Pro or Enterprise subscription"**
> The feature is not included in your license tier. See [Licensing](#licensing-subscriptions--quotas).

**Q: Editing a user fails with "requires the server:sudo permission"**
> Editors cannot grant sudo or privileged groups, or change root-equivalent accounts. Ask an admin.

**Q: A scheduled runbook, patch scan, or access-grant revoke fails with "vault locked"**
> Background jobs cannot prompt for the vault passphrase. Unlock the vault globally (Settings → Vault Security) or set
> `VAULT_PASSPHRASE`.

**Q: Heartbeat check-ins return 404**
> The token was rotated, or the heartbeat was deleted while the wrapped crontab line stayed on the host. Update the
> line (rotate with *Rewrite the crontab line*) or turn monitoring off in the cron editor.

**Q: SSH Terminal is missing from the sidebar**
> `SSH_ENABLED=false` (the default), or you are not an admin. Set `SSH_ENABLED=true` in `.env` and restart the API
> container; non-admins need an approved access request.

**Q: I edited a server but the password didn't change**
> Correct behavior — leaving the password field blank keeps the existing stored password. Enter a new password only when you want to change it.

**Q: Export downloads an empty file**
> The search filter returned no results. Clear the search box and try again.

**Q: Status shows "unknown" for all servers**
> The scheduler may be disabled (`SCHEDULER_ENABLED=false`) or the first probe hasn't run yet. Wait up to `PING_INTERVAL_MS` milliseconds, or click the refresh button.

**Q: The Servers page is empty after upgrading, but the dashboard shows servers**
> You are running the v0.8.0 web image, whose nginx redirected the server list to a URL the API does not serve.
> Rebuild both images: `docker compose up -d --build`.

**Q: I'm getting CORS or "invalid origin" errors when signing in**
> Set `WEB_ORIGIN` to the exact URL the web app is served at (e.g. `https://rackmap.example.com`), including scheme,
> hostname, and port. If you reach it under several names, list all of them in `TRUSTED_ORIGINS`.

**Q: GPU shows "No GPU" but the server has one**
> The metrics detection checks `nvidia-smi`, then AMD sysfs (`/sys/class/drm/card*/device/gpu_busy_percent`), then `rocm-smi`, then `xpu-smi`. If none are present, it reports no GPU. Ensure the GPU driver is installed on the target server and the tools are in PATH for the SSH user.

**Q: Telegram notifications aren't arriving**
> Verify the bot is added to the chat/group and has permission to post. Get the chat ID by sending `/start` to the
> bot and checking `https://api.telegram.org/bot<TOKEN>/getUpdates`. Then open the channel's **Delivery log** under
> Settings → Alerts to see the error.

**Q: The API container won't start: "Refusing to seed the initial admin with a weak or default password"**
> In production the first start needs a strong `SEED_ADMIN_PASSWORD` (12+ characters, not a published default). Set
> one in `.env` and start again.

**Q: How do I move from SQLite to PostgreSQL?**
> RackMap 1.0 runs on PostgreSQL 18 only. Follow [MIGRATION.md](MIGRATION.md#upgrading-08x--100): start 1.0 once so
> it creates the schema, then copy the old data across with `pnpm --filter @inv/api db:migrate:postgres`.
