# User Guide — RackMap

## Table of Contents

1. [Getting Started](#getting-started)
2. [Dashboard & Server List](#dashboard--server-list)
3. [Adding a Server](#adding-a-server)
4. [Server Detail Modal](#server-detail-modal)
5. [Live Metrics](#live-metrics)
6. [SSH Terminal](#ssh-terminal)
7. [Export](#export)
8. [Tags](#tags)
9. [Lookup Tables](#lookup-tables)
10. [Audit Log](#audit-log)
11. [User Management](#user-management)
12. [Access Requests](#access-requests)
13. [Notifications](#notifications)
14. [Security Settings](#security-settings)
15. [Roles & Permissions](#roles--permissions)
16. [FAQ / Troubleshooting](#faq--troubleshooting)

---

## Getting Started

Open the app in your browser (default: `http://localhost:8080`). Sign in with your email and password. First-time setup creates an admin account using the `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` values from `.env`.

After signing in you land on the **Servers** page.

---

## Dashboard & Server List

The servers table shows all servers you have access to.

| Column | Description |
|--------|-------------|
| Status dot | Green = up, Red = down, Gray = unknown (never probed) |
| Hostname | Click to open the server detail modal |
| IP | IP address |
| SSH Port | Default 22 |
| Tags | Colored label badges |
| Last seen | Time of last successful probe |
| Latency | Round-trip time of last probe (ms) |
| Actions | Edit, delete, reveal password |

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
1. Click a server hostname to open the detail modal
2. Click **SSH Terminal** in the header
3. The terminal connects using stored credentials — no password prompt

**Limits:**
- Idle sessions close after 5 minutes (configurable via `SSH_IDLE_TIMEOUT_MS`)
- Sessions close after 1 hour maximum (`SSH_MAX_SESSION_MS`)
- Max 5 concurrent sessions (`SSH_MAX_CONCURRENT`)

All SSH open/close events are recorded in the audit log.

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

## Security Settings

Sidebar → **Security** (your own account settings)

- **Change password** — enter current password and new password
- **Active sessions** — view and revoke other active sessions

---

## Roles & Permissions

| Action | Admin | Editor | Viewer |
|--------|-------|--------|--------|
| View server list | ✓ | ✓ | ✓ |
| View server detail | ✓ | ✓ | ✓ |
| Add / edit server | ✓ | ✓ | — |
| Delete server | ✓ | ✓ | — |
| Reveal password | ✓ | ✓ | Request |
| Live metrics | ✓ | ✓ | — |
| SSH terminal | ✓ | Request | Request |
| Export data | ✓ | ✓ | ✓ |
| Manage tags | ✓ | ✓ | — |
| Manage lookups | ✓ | — | — |
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
