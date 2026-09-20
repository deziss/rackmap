# User Guide — RackMap

## Table of Contents

1. [Getting Started & Product Portal](#getting-started--product-portal)
2. [Dashboard & Server List](#dashboard--server-list)
3. [Adding a Server](#adding-a-server)
4. [Server Detail Page & Specs](#server-detail-page--specs)
5. [OS Users & Sudoers Management](#os-users--sudoers-management)
6. [Forensic Logs & Auto-Query](#forensic-logs--auto-query)
7. [Live Metrics & ATOP History](#live-metrics--atop-history)
8. [SSH Terminal](#ssh-terminal)
7. [Services Inventory](#services-inventory)
8. [SSL Certificate Tracking](#ssl-certificate-tracking)
9. [Export & Reports](#export--reports)
10. [Tags](#tags)
11. [Lookup Tables](#lookup-tables)
12. [Audit Log](#audit-log)
13. [User Management](#user-management)
14. [Access Requests](#access-requests)
15. [Notifications](#notifications)
16. [Security Settings](#security-settings)
17. [Database Options (SQLite & PostgreSQL)](#database-options-sqlite--postgresql)
18. [Roles & Permissions](#roles--permissions)
19. [FAQ / Troubleshooting](#faq--troubleshooting)

---

## Getting Started & Product Portal

### Product Landing & Pricing Portal (`/portal`)
Before signing in or when exploring platform capabilities, visit the customer-facing **Product Portal** at `http://localhost:3123/portal`:
- **Interactive Mock Console**: Test the Server Fleet overview, live ATOP Replay, client-side Zero-Knowledge decryption, and Remote Sudoers audits.
- **Licencia Plan Calculator**: Toggle between monthly and annual billing to compare Free Community, Pro ($39/mo or $31/mo billed annually), and Enterprise ($249/mo or $199/mo billed annually).
- **One-Minute Quickstart**: Copyable Docker Compose production configuration.
- **FAQ & Architectural Guides**: Deep-dives into agentless SSH, client WebCrypto AES-256-GCM vault security, and air-gapped activation.

### Signing In to the Console
Open `http://localhost:3123/login` in your browser. Sign in with your email and password. First-time setup creates an admin account using the `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` values from `.env`.

After signing in you land on the **Servers** page. You can jump back to the Product Portal at any time via the sidebar navigation item **Product Portal**.

---

## Dashboard & Server List

The servers table shows all servers you have access to.

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
| Actions | Fixed sticky quick actions: health check, SSH copy, dedicated page, terminal, edit, delete (vibrant hover highlight colors) |

### Universal Pagination
Every table in RackMap features an interactive pagination bar:
- **Rows Selector**: Choose `10`, `25`, `50`, or `100` rows displayed at a time.
- **Range Summary**: Real-time counter showing `Showing X–Y of Z items`.
- **Numbered Navigation**: Direct jump to any numbered page `[1] [2] [3] ... [N]`, with `Previous` and `Next` buttons, and `First` / `Last` page shortcuts.

**Search** — Type in the search box to filter by hostname, IP, domain, remark, or username. Filters apply instantly.

**Refresh** — Click the refresh button or wait for the automatic 30-second poll.

---

## Adding a Server

Click **Add Server** (top-right). Fill in:

| Field | Required | Notes |
|-------|----------|-------|
| Hostname | Yes | Human-readable name |
| IP Address | Yes | Used for TCP probe and SSH |
| SSH Port | Yes | Default: 22 |
| Username | Yes | SSH login user |
| Password | No | Stored AES-256 encrypted. Required for live metrics and SSH terminal. |
| Domain | No | e.g. `prod.example.com` |
| Environment | No | prod / staging / dev / etc. |
| Cloud Provider | No | From lookup table |
| Location | No | From lookup table |
| Server Type | No | From lookup table |
| Allocated To | No | From lookup table |
| GPU Type | No | From lookup table |
| GPU Count | No | Number of GPUs |
| CPU | No | Free-text, e.g. "Intel Xeon E5-2680 × 2" |
| RAM | No | Free-text, e.g. "128 GB" |
| Remark | No | Any notes |
| Tags | No | Select or create inline |

Click **Save**. The server appears in the table and is immediately queued for a TCP probe.

**Edit a server** — Click the pencil icon. Leave the password blank to keep the existing stored password.

**Delete a server** — Click the trash icon. Soft-deleted servers are removed from the list but kept in the database for audit purposes.

---

## Server Detail Modal

Click any **hostname** in the servers table to open the full-screen detail modal.

The modal shows:

- **Status dot + hostname** — live connectivity status
- **Badges** — domain, environment, cloud provider, location
- **Copy SSH command buttons** — copies `ssh user@ip -p port` to clipboard (one plain, one with `sudo -i`)
- **SSH Terminal button** — opens an embedded terminal (admin or approved access request required)
- **Server info grid** — all metadata fields
- **Tags** — colored label pills
- **Live metrics** — CPU, memory, GPU, disk, network (see [Live Metrics](#live-metrics))

Close with the × button or press Escape.

---


---

## OS Users & Sudoers Management

RackMap provides enterprise-grade Linux user account management directly from the server detail page under the **OS Users & Sudoers** tab.

### Inspecting Local Accounts
- Lists all local user accounts parsed directly from `/etc/passwd` and `/etc/group` via agentless SSH.
- Displays **Username**, **UID : GID**, **Home Directory**, **Shell**, **Secondary Groups**, and **Sudo Privileges**.
- Summary badges identify **Human Accounts** (UID >= 1000), **Superuser** (`root`), and **SSH Admin** (active management user).
- Filter input allows searching by username, shell, home directory, or group name.

### Adding a User (+ Add User)
Click **+ Add User** to open the creation dialog with comprehensive Linux options:
- **Username**: Validated Linux username (`^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*[$]?$`).
- **Password**: Password input with visibility toggle and a **"Generate Strong Password"** button (16-character secure random string).
- **Login Shell**: Select from standard shells (`/bin/bash`, `/bin/sh`, `/bin/zsh`, `/usr/sbin/nologin`, `/bin/false`) or enter a custom path.
- **Home Directory**: Auto-fills `/home/<username>` as you type with an option to manually customize.
- **Account Flags**:
  - `Create home directory (-m)`: Ensures user skeleton files and directory are created.
  - `System account (-r)`: Creates system user without password aging.
- **Secondary Groups**: Comma-separated input with quick-add chips for `sudo`, `docker`, `adm`, `www-data`, and `staff`.
- **UID / GID**: Optional custom numeric identifiers.
- **Sudoers Rules**: Choose between `None`, `Full Sudo without Password (NOPASSWD: ALL)`, `Full Sudo with Password Required (ALL=(ALL:ALL) ALL)`, or `Custom Restricted Commands`.

### Editing a User (Edit)
Click **Edit** on any user row to modify:
- Login shell and home directory.
- Secondary group memberships.
- Reset user password with the secure password generator.
- Toggle account lock status (`usermod -L` / `usermod -U`) to temporarily block logins without deleting data.
- Update sudoers privileges.

### Deleting a User (Delete)
Click the trash icon to safely remove an account:
- **Root Protection**: Deletion of the `root` account is permanently blocked.
- **Active SSH Protection**: If deleting the active SSH user, a critical warning is displayed, and you must type the exact username to confirm.
- **Options**:
  - `Remove user home directory (-r)`: Deletes home directory and mail spool.
  - `Force deletion (-f)`: Forces removal even if active processes are owned by the user.

---

## Forensic Logs & Real-Time Storage Telemetry

The **Forensic Logs & Evidence** tab allows deep, real-time forensic auditing of remote systems over SSH without installing any agent software:

### 1. Real-Time Storage Footprint Telemetry
Every log query automatically probes the remote host's log storage consumption and displays dedicated telemetry badges:
- **`/var/log` Total Disk Footprint** (Amber Badge): Measured via `du -sh /var/log`, showing total space consumed by all log files on the host (e.g. `3.7G`, `850M`).
- **`journalctl` Systemd Usage** (Blue Badge): Measured via `journalctl --disk-usage`, showing total archived and active systemd journal volume (e.g. `2.6G`, `500M`).
- **Telemetry Locations**: Displayed in the filter toolbar above the inputs and directly in the terminal console header next to active line counts.

### 2. Multi-Source Log Streams
Switch seamlessly between multiple system log sources:
- **`journalctl (systemd)`**: Full systemd journal with unit filtering (`-u <unit>`), priority levels, and short-iso timestamps.
- **`/var/log/auth.log`**: Dedicated authentication events, SSH login attempts, sudo invocations, and pam sessions.
- **`/var/log/syslog`**: General system log stream.
- **`dmesg (kernel)`**: Kernel ring buffer logs, hardware faults, and OOM killer notifications.

### 3. Filters & Auto-Querying
- **Priority Filter**: Emergency (0), Alert (1), Critical (2), Error (3), Warning (4), Notice (5), Info (6), Debug (7).
- **Auto-Query Interval**: Select `Manual (Click)`, `Auto: 5s`, `Auto: 10s`, `Auto: 30s`, or `Auto: 60s` for hands-free live stream monitoring with a pulsing status badge.
- **Evidence Search & Time Range**: Fast full-text keyword search and time bounds (e.g. `1 hour ago`, `24 hours ago`).
- **Export & Copy**: Export results directly to a `.log` text file or copy lines to clipboard.

## Live Metrics

Live metrics are collected by SSH-ing into the server and running a shell command — **no software is installed on the target server**.

**Requirements:**
- Server must have an SSH password saved in its record
- `METRICS_ENABLED=true` (default)
- API must be able to reach the server on its SSH port

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

Metrics **refresh every 5 seconds** while the modal is open. If SSH connection fails, an error banner shows the exact reason (e.g. "no credentials configured", "connection refused").

---

## SSH Terminal

An in-browser SSH terminal powered by xterm.js.

**Enable it:**
1. Set `SSH_ENABLED=true` in your `.env` and restart the API
2. Only admins can open terminals by default
3. Editors and viewers must submit an access request (see [Access Requests](#access-requests))

**Open a terminal:**
1. Click **SSH Terminal** in the main sidebar (`/ssh`) or click **SSH Terminal** from any Server Detail page.
2. In the sidebar host list, use the **"Filter hosts by name or IP..."** search bar to quickly locate any server by hostname or IP address.
3. Online hosts display a green status dot with current latency, and offline hosts display a red dot.
4. Click any host (or press **Enter**) to instantly open a dedicated terminal session tab.
5. The terminal connects using configured SSH keys or saved passwords, with automatic PAM keyboard-interactive fallback.

**Limits:**
- Idle sessions close after 5 minutes (configurable via `SSH_IDLE_TIMEOUT_MS`)
- Sessions close after 1 hour maximum (`SSH_MAX_SESSION_MS`)
- Max 5 concurrent sessions (`SSH_MAX_CONCURRENT`)

All SSH open/close events are recorded in the audit log.

---

---

## Services Inventory & Multi-Hosting Architecture

The **Services** page (`/services`) manages 175+ microservices, internal applications, AI model endpoints, and system daemons categorized by runtime environment.

### 1. Multi-Hosting Runtime Environments
Services are categorized by their hosting model:
- **`server` (Host-Native)**: Applications running directly on bare-metal or cloud host machines (e.g., Mattermost on `:13373`, Jenkins on `:8081`, GitLab on `:8999`, Zabbix Server, Canvas, and direct system daemons).
- **`docker` (Containerized)**: Standalone Docker containers or Docker-Compose deployments (e.g., Uptime Kuma, Quay Registry, Sonarqube, Posthog, Minio).
- **`k8s` (Kubernetes)**: Kubernetes microservices and operators with dedicated **NodePort** allocation tracking (e.g., Aim `:31000`, Bytebase `:30420`, Elasticsearch `:30092`, Keycloak `:30845`, RabbitMQ `:31672`, Redis `:31068`).

### 2. AI Model & Inference Topology
AI deployments on vLLM, Ollama, and llama.cpp are tracked as first-class services bound to their host server:
- **Hosted Models**: Individual model endpoints (e.g. `Qwen3.5-122B-A10B-BF16`, `nomic-embed-text:latest`, `nemotron-3-super:120b`, `llama3.3:latest`) are registered with their host server IP and listening port.
- **API Bearer Tokens**: Authenticated endpoints store API authorization bearer tokens encrypted at rest with AES-256-GCM, accessible only to authorized operators.
- **Automatic Server Mapping**: When viewing any server detail page (`/servers/:id`), all associated AI models and hosted services automatically populate the **Hosted Applications & Services** table.

### 3. Server Backup Automation & Disaster Recovery Tracking
Servers track automated backup policies and disaster recovery state:
- **Backup Script Path**: Shell scripts executed for backups (e.g. `/home/script/docker_dump.sh`, `/home/script/k8s_backup.sh`, `gitlab.sh`).
- **Destination Storage**: Target location for dumps (NVMe disks, central NFS network storage e.g. `/MNnfsF90SRV15/backup/`).
- **Cron Schedules**: Exact schedule execution times (e.g. `05 21 * * 1-6`, `Every night 11 PM`).
- **Retention Durability**: Durability guarantees (e.g. `60 days`, `30 days`).
- **Data Categories**: Identifies whether the backup contains database volumes, Kubernetes YAML manifests, or full system state.

---

## SSL Certificate Tracking

RackMap provides proactive SSL/TLS certificate tracking and expiration monitoring.
- **Search & Filtering**: Use the top search bar to filter certificates by domain name, team, project, issuer authority (e.g., Let's Encrypt, Sectigo), or linked server hostname.
- **Status Indicators**: Badges indicate Valid, Expiring Soon (<30 days), Expired, or Error.

The **SSL** page (`/ssl`) monitors domain certificates for upcoming expiration.

- **Auto-Discovery**: Automatically extracts domains configured on servers and services.
- **Manual Domains**: Add standalone external domains to monitor.
- **Background Scanner**: Probes port 443, reads peer certificates, records issuer, validity window, and calculates days remaining.
- **Alerts**: Color-coded badges for valid, expiring soon (≤30 days), and expired certificates, with automated email warnings.
- **Wildcard Domain Monitoring**: Track wildcard certificates (e.g. `*.example.com`, `*.domain.com`). The SSL scanner intelligently probes existing active subdomains or apex hosts on port 443 with SNI to retrieve the authoritative certificate.
- **Automatic Subdomain Omission**: When a wildcard domain is tracked, all related subdomains are automatically grouped and omitted from the default display table to eliminate clutter, showing a summary banner with an omission count.
- **Show Wildcard Subdomains Toggle**: Use the **Show wildcard subdomains** checkbox in the toolbar to reveal and inspect all covered subdomains at any time.

---

## Export

On the Servers page, click the **Export** dropdown (top-right area):

- **Export Excel (.xlsx)** — Downloads an Excel file with all currently filtered servers
- **Export JSON** — Downloads a JSON file with all currently filtered servers

The export respects the current search filter. Sensitive fields (passwords) are never included.

---

## Tags

Tags are colored labels you can attach to servers.

**Create a tag:**
1. Go to **Tags** in the sidebar
2. Click **Add Tag**, enter a name and pick a color
3. Click Save

**Attach to a server:**
- In the Add/Edit Server dialog, click the Tags field and select from the dropdown
- Type to search existing tags

**Filter by tag:**
- Tags are visible in the server list; use the search box to filter

---

## Lookup Tables

Lookup tables provide dropdown options for:

- **Cloud Providers** — AWS, GCP, Azure, Hetzner, etc.
- **GPU Types** — NVIDIA A100, RTX 3090, etc.
- **Allocated To** — teams or people servers are assigned to
- **Locations** — data centers, regions, racks
- **Server Types** — bare-metal, VM, container host, etc.

**Manage lookups** (admin only):
1. Go to **Lookups** in the sidebar
2. Select a category tab
3. Click **Add** to create a new entry, or click the edit/delete icons

Lookup values appear in server forms and are shown as badges in the server list.

---

## Audit Log

The audit log records every action in the system.

**Access:** Sidebar → **Audit Log** (admin only)

**What is logged:**
- Server create / update / delete / restore
- Password reveal
- Import, export, metrics view, SSH open/close
- Lookup create / update / delete
- Tag create / delete
- User create / update / role change / ban / unban / remove
- Password reset by admin
- Access request create / approve / reject
- Sign in / sign in failure / sign out

**Each entry shows:**
- Action badge (color-coded)
- Entity + ID
- Actor email
- IP address
- Timestamp

**Click any row** with a diff icon to expand and see the before/after values.

**Filter:**
- Category: `data` or `auth`
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
- Cannot change your own role

**Set password:**
- Click the key icon to reset another user's password
- Does not require the old password

**Ban / unban:**
- Click the ban icon to prevent a user from signing in
- Banned users' sessions are invalidated immediately

**Remove a user:**
- Click the trash icon
- Permanently removes the account and all sessions

---

## Access Requests

Editors and viewers can request temporary access to actions that require higher privileges.

**Request types:**
- **SSH** — open the browser SSH terminal for a specific server
- **Password Reveal** — reveal the stored SSH password for a specific server

### For viewers / editors

1. Click **Reveal Password** or **SSH Terminal** on a server you don't have access to
2. A request dialog appears — enter an optional note explaining why
3. Submit the request
4. Wait for admin approval
5. Once approved, access is granted until the expiry time set by the admin

**View your requests:** Sidebar → **Access Requests**

### For admins

1. Sidebar → **Access Requests** — pending requests appear with a badge count
2. Click **Approve** or **Reject**
3. When approving, set an expiry duration (e.g. 24 hours)
4. Add an optional admin note

Approved access automatically expires. All actions taken during the approved window are audited.

---

## Notifications

The system sends alerts when a server changes status (up → down or down → up).

**Webhook:**
- Set `NOTIFY_WEBHOOK_URL` in `.env`
- Receives a POST with JSON body: `{ hostname, ip, status, previousStatus, latencyMs, checkedAt }`

**Telegram:**
- Set `NOTIFY_TELEGRAM_BOT_TOKEN` and `NOTIFY_TELEGRAM_CHAT_ID`
- Get a bot token from [@BotFather](https://t.me/botfather)
- Add the bot to your group/channel and get the chat ID

Both can be active simultaneously. Notifications fire after `STATUS_FLIP_THRESHOLD` consecutive failures (default 2) to avoid alert storms on transient blips.

---

## Security Settings & Credential Vault

Navigate to **Security** via the bottom sidebar or visit `/security`.

### Are Server Passwords Actually Encrypted or Just Gated?

**Server passwords are truly AES-256-GCM encrypted, not just gated or masked:**
1. **At-Rest Database Encryption**: In SQLite / PostgreSQL (`inventory.db`), the `passwordEnc` column never contains plaintext passwords. It stores encrypted payloads in the format:
   - `v2.<iv_hex>.<auth_tag_hex>.<cipher_hex>` (when using the Master Credential Vault DEK)
   - `v1.<iv_hex>.<auth_tag_hex>.<cipher_hex>` (when using the At-Rest Application Key)
2. **Authenticated Encryption with Associated Data (AEAD)**: Every encrypted password generates a cryptographically random 12-byte initialization vector (IV) and a 16-byte authentication tag ensuring integrity and preventing tampering.
3. **API Stripping**: All standard server listing, query, and detail endpoints explicitly strip `passwordEnc` at the service layer (`toDto`). The REST API only outputs `hasPassword: true/false` to frontend clients.
4. **On-Demand In-Memory Decryption**: Decryption only occurs in-memory when:
   - An authorized operator with vault access clicks "Reveal Password" (which logs an audit event).
   - The backend SSH service establishes an SSH tunnel or executes automated background discovery.

### Global Admin Vault Configuration (`/settings`)

Administrators can configure the vault once globally to eliminate repetitive unlock prompts:
1. Navigate to **Admin Settings** (`/settings`) → **Credential Vault & Passphrase Configuration**.
2. Enter the master passphrase to unlock the vault globally in server memory.
3. Check **"Persist to .env file"** to automatically save `VAULT_PASSPHRASE` into the environment configuration. This ensures the master vault automatically initializes and unlocks whenever API containers reboot.

### 1. Master Credential Vault & Encryption Passphrases

RackMap employs two tiers of military-grade encryption to protect target server credentials and access keys:

#### Where and How to Set Encryption Passphrase

| Encryption Tier | Configuration Location | Purpose | Accepted Formats |
|---|---|---|---|
| **Tier 1: At-Rest Encryption** | `.env` (`APP_ENCRYPTION_KEY` or `APP_ENCRYPTION_PASSPHRASE`) | Encrypts server passwords in the database at rest (AES-256-GCM, format `v1.<iv>.<tag>.<cipher>`) | 32-byte base64 string (`openssl rand -base64 32`) **OR** any human-readable passphrase (min 8 chars) |
| **Tier 2: Zero-Knowledge Vault** | `.env` (`VAULT_PASSPHRASE`) **or** Web UI (`/security` & `/servers/:id`) | Master envelope encryption (PBKDF2/AES-256, format `v2.<iv>.<tag>.<cipher>`). Derives an in-memory KEK and ephemeral 256-bit DEK. | Arbitrary master passphrase string (min 8 chars) |

#### Setting Encryption in `.env`
In your `.env` file (or `docker-compose.yml`):
```bash
# Tier 1: Application At-Rest Key or Passphrase
APP_ENCRYPTION_KEY=y9ThjEzTQ1UmAM2KrEe3ALbjAijKY2yG4icDuiylcGM=
# Or use a custom human-readable passphrase:
# APP_ENCRYPTION_PASSPHRASE="MySecureAppPassword123!"

# Tier 2: Master Credential Vault Passphrase (Optional for headless auto-unlock)
VAULT_PASSPHRASE="MyMasterVaultPassphrase2026!"
```

#### Benefits of `VAULT_PASSPHRASE` in `.env`
- **Headless Auto-Unlock**: The API automatically unlocks the master vault on startup.
- **Continuous Background Tasks**: Automated hardware auto-discovery, scheduled ATOP metrics collection, and background SSH jobs can decrypt server credentials without requiring an operator to manually unlock the vault in a browser every 30 minutes.

#### Interactive Unlocking via Web UI
If `VAULT_PASSPHRASE` is left unset in `.env`:
1. The vault defaults to locked when the server boots.
2. In the Web UI, click the **"Vault: Locked"** badge on the **Security** page or the header of any **Server Detail** page (`/servers/:id`).
3. Enter your master passphrase. The session remains authorized for 30 minutes before auto-locking.

#### Resetting or Re-Keying the Vault
If an administrator forgets the master vault passphrase or needs to rotate keys:
1. Open the **Credential Vault** modal on `/security` or `/servers/:id`.
2. Click **"Forgot passphrase? Reset vault"** (if locked) or **"Manage / Reset Passphrase" → "Reset / Re-key"** (if unlocked).
3. Enter and confirm the new master passphrase (minimum 8 characters).
4. Click **"Reset Master Vault"**. The system generates a fresh salt, KEK, and DEK.
*(Note: Any server passwords encrypted under a previous lost passphrase will need to be re-entered).*

---

### 2. Account Security & Two-Factor Authentication (2FA)

- **Change Password**: Update your local account password anytime.
- **Two-Factor Authentication (2FA / TOTP)**:
  1. Click **"Enable 2FA"**.
  2. Scan the generated QR code in Google Authenticator, Authy, or 1Password.
  3. Enter the 6-digit code to activate two-factor authentication.
- **API Keys**: Generate scoped programmatic tokens for external automations and scripts.

---

---

## Database Options (SQLite & PostgreSQL)

RackMap supports both **SQLite** and **PostgreSQL**:
- **SQLite (Default)**: Zero external setup. Database file stored at `/data/inventory.db` in Docker or `./dev.db` locally.
- **PostgreSQL**: Ideal for production deployments with heavy concurrency.
  1. Set `DATABASE_URL="postgresql://user:pass@host:5432/rackmap"` in `.env`.
  2. Change `provider = "postgresql"` in `apps/api/prisma/schema.prisma`.
  3. Start with Docker profile: `docker compose --profile postgres up -d`.

---

## Licensing, Subscriptions & Quotas (Licencia)

RackMap includes native integration with **Licencia** for subscription tiering and node quota management:

### 1. Subscription Tiers
- **Free Community Edition**: Enabled by default with zero configuration. Allows managing up to **10 servers** with full inventory CRUD, manual specs, and SSH terminal access.
- **RackMap Pro**: Unlocks up to **100 servers**, agentless Hardware Auto-Discovery over SSH, ATOP historical spikes timeline, remote OS user & sudoers fleet management, automated OS updates, and multi-channel alerts (Slack, Discord, Telegram).
- **RackMap Enterprise**: Unlocks **unlimited servers**, customized retention periods, and priority enterprise capabilities.

### 2. Managing Your Subscription
1. Navigate to **Admin Settings** (`/settings`) → **Subscription & Licensing**.
2. View your active tier badge and node capacity bar (`X / 10 servers used`).
3. To activate a key, enter your Licencia key (`LIC-XXXX-XXXX-XXXX-XXXX`) and click **Activate**.
4. For **air-gapped / offline deployments**, click *"Air-gapped deployment? Paste offline lease token"* and paste your signed Ed25519 token.
5. To downgrade or remove a license, click **Deactivate License**.


## Roles & Permissions

| Action | Admin | Editor | Viewer |
|--------|-------|--------|--------|
| View server & service list | ✓ | ✓ | ✓ |
| View server detail & metrics | ✓ | ✓ | — |
| Add / edit server or service | ✓ | ✓ | — |
| Delete server or service | ✓ | ✓ | — |
| Reveal server/service password | ✓ | ✓ | Request |
| SSH terminal | ✓ | Request | Request |
| Export data & reports | ✓ | ✓ | ✓ |
| Manage tags | ✓ | ✓ | — |
| Manage lookups | ✓ | ✓ (Create/Edit) | — |
| Delete lookups | ✓ | — | — |
| View audit log | ✓ | — | — |
| Manage users | ✓ | — | — |
| Approve access requests | ✓ | — | — |

**Request** = submit an access request; access granted after admin approval with an expiry time.

---

## FAQ / Troubleshooting

**Q: Live metrics show "no credentials configured"**
> The server record doesn't have an SSH password saved. Edit the server and add the password.

**Q: Live metrics show "connection refused" or "host unreachable"**
> The API cannot reach the server on its SSH port. Check: (1) correct IP in the server record, (2) firewall allows SSH from the server running this app, (3) SSH service is running on the target.

**Q: SSH Terminal button is missing**
> `SSH_ENABLED=false` (the default). Set `SSH_ENABLED=true` in `.env` and restart the API container.

**Q: I edited a server but the password didn't change**
> Correct behavior — leaving the password field blank keeps the existing stored password. Enter a new password only when you want to change it.

**Q: Export downloads an empty file**
> The search filter returned no results. Clear the search box and try again.

**Q: Status shows "unknown" for all servers**
> The scheduler may be disabled (`SCHEDULER_ENABLED=false`) or the first probe hasn't run yet. Wait up to `PING_INTERVAL_MS` milliseconds, or click the refresh button.

**Q: I'm getting CORS errors in the browser console**
> Set `WEB_ORIGIN` to the exact URL where the web app is served (e.g. `http://myserver.lan:8080`). Must match scheme, hostname, and port exactly.

**Q: GPU shows "No GPU" but the server has one**
> The metrics detection checks: `nvidia-smi`, then AMD sysfs (`/sys/class/drm/card*/device/gpu_busy_percent`), then `rocm-smi`, then `xpu-smi`. If none are present, it reports no GPU. Ensure the GPU driver is installed on the target server and the tools are in PATH for the SSH user.

**Q: Telegram notifications aren't arriving**
> Verify the bot is added to the chat/group and has permission to post. Get the chat ID by sending `/start` to the bot and checking `https://api.telegram.org/bot<TOKEN>/getUpdates`.

**Q: How do I migrate from SQLite to PostgreSQL?**
> Change `DATABASE_URL` to a PostgreSQL connection string (`postgresql://user:pass@host:5432/dbname`). Run `prisma migrate deploy`. The schema is compatible — Prisma handles both databases.
