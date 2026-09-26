# contrib

Integrations that treat RackMap as the source of truth for your fleet. These are
not part of the application — they talk to it over the public REST API.

All of them authenticate with an **API key**, not a session cookie. Create one in
the UI under **Security → API Keys**.

> **Scope the key to `viewer`.** Everything here only reads. A viewer-scoped key
> cannot modify your inventory even if it leaks into a CI log.

Keys can be given an expiry (`expiresInDays`) when created via the API:

```bash
curl -X POST https://rackmap.example.com/api/v1/api-keys \
  -H "Content-Type: application/json" \
  -H "Cookie: better-auth.session_token=<your session>" \
  -d '{"name":"ansible-inventory","scopeRole":"viewer","expiresInDays":90}'
```

The raw key is returned **once**. Store it immediately.

---

## `rackmap-inventory.py` — Ansible dynamic inventory

Stops you maintaining an Ansible inventory file alongside RackMap.

```bash
export RACKMAP_URL=https://rackmap.example.com
export RACKMAP_API_KEY=sk_...

ansible-inventory -i contrib/rackmap-inventory.py --list
ansible -i contrib/rackmap-inventory.py all -m ping
ansible-playbook -i contrib/rackmap-inventory.py site.yml --limit env_cloud
```

No dependencies beyond the Python 3 standard library.

### Groups

| Group | Source |
|---|---|
| `all` | every non-deleted server |
| `env_<name>` | `environment` (on-premise, cloud, …) |
| `provider_<name>` | cloud provider lookup |
| `location_<name>` | location lookup |
| `type_<name>` | server type lookup |
| `allocated_<name>` | allocated-to lookup |
| `tag_<name>` | each RackMap tag |
| `status_up` / `status_down` | last probe result |
| `gpu` | `gpuCount > 0` |

### Host variables

`ansible_host`, `ansible_port` and `ansible_user` come straight from RackMap.
Everything else is exposed under `rackmap_*` — `rackmap_os`, `rackmap_gpu_count`,
`rackmap_tags`, `rackmap_location` and so on — for use in conditionals:

```yaml
- hosts: gpu
  tasks:
    - name: Install the NVIDIA container toolkit
      ansible.builtin.package:
        name: nvidia-container-toolkit
      when: rackmap_gpu_type is search("NVIDIA")
```

### SSH credentials

**Not provided, by design.** RackMap never serves stored SSH credentials over the
API, so authentication stays with your normal Ansible setup — an agent, a key
file, or `ansible_ssh_private_key_file` in `group_vars`.

### Other settings

| Variable | Default | Meaning |
|---|---|---|
| `RACKMAP_TIMEOUT` | `30` | HTTP timeout, seconds |
| `RACKMAP_VERIFY_TLS` | `true` | Set `false` only for an internal CA you cannot install |
| `RACKMAP_INCLUDE_DOWN` | `true` | Set `false` to omit hosts currently probed as down |

### Troubleshooting

- **`rejected the API key (401)`** — the key was revoked, expired, or belongs to a banned user.
- **`lacks permission to list servers (403)`** — the key is scoped below `viewer`, or the owning user was demoted.
- **Empty inventory** — check `RACKMAP_INCLUDE_DOWN`; if the whole fleet is probed as down, everything is filtered out.

---

## Prometheus and Grafana

RackMap does not store a time series of its own. It exposes its current state
to Prometheus and hands Prometheus the target list for your exporters, so the
inventory is the only list you maintain.

| File | What it is |
|---|---|
| `prometheus/prometheus.yml` | Example config: scrapes RackMap's exporter, discovers node_exporter targets from RackMap |
| `grafana/rackmap-fleet.json` | Importable Grafana dashboard for the exporter's series |

Both endpoints below take the same credentials: a session, or a `viewer`-scoped
API key sent as `Authorization: Bearer sk_...`. Put the raw key in a file that
only the `prometheus` user can read and point `credentials_file` at it.

### Exporter — `GET /api/v1/metrics`

Prometheus text format. Every series is a gauge computed from aggregate queries,
so a scrape costs a handful of database round trips regardless of history size.

| Series | Labels | Meaning |
|---|---|---|
| `rackmap_servers_total` | `status` | servers by last probe status |
| `rackmap_services_total` | `status` | services by last probe status |
| `rackmap_ssl_certificates_total` | `status` | tracked certificates by status |
| `rackmap_server_up` | `hostname`, `ip`, `environment` | 1 = last TCP probe succeeded |
| `rackmap_server_probe_latency_ms` | `hostname` | last successful probe round trip |
| `rackmap_server_last_probe_age_seconds` | `hostname` | seconds since the last probe; a rising value means the scheduler has stopped |
| `rackmap_server_gpu_count` | `hostname` | GPUs recorded for the server (servers with none are omitted) |
| `rackmap_ssl_days_remaining` | `domain` | days until expiry (soonest 200) |
| `rackmap_heartbeat_up` | `heartbeat`, `heartbeat_id`, `server` | 1 = up or new, 0 = late or down; paused heartbeats are omitted |
| `rackmap_heartbeat_last_ping_age_seconds` | `heartbeat`, `heartbeat_id` | seconds since the last ping |
| `rackmap_heartbeats` | `status` | heartbeats by status |
| `rackmap_runbook_runs` | `status` | runs created in the last 24 hours |
| `rackmap_alert_deliveries` | `status` | alert deliveries created in the last 24 hours |
| `rackmap_patch_security_updates` | `server`, `server_id` | pending security updates (last scan) |
| `rackmap_patch_upgradable` | `server`, `server_id` | all upgradable packages (last scan) |
| `rackmap_patch_reboot_required` | `server`, `server_id` | 1 = reboot pending |
| `rackmap_drift_open_events` | `server`, `server_id`, `severity` | unacknowledged drift events |
| `rackmap_access_grants_active` | — | active temporary access grants |

Status-labelled series are zero-filled for every known status, so a quiet day
reads `0` instead of "no data". Series without a fixed label set (drift, patch)
are absent when there is nothing to report — use `or vector(0)` in expressions.

### Service discovery — `GET /api/v1/prometheus/sd`

Returns [`http_sd_configs`](https://prometheus.io/docs/prometheus/latest/http_sd/)
JSON: one target group per server, `<ip>:<port>`, with these labels:

| Label | Example |
|---|---|
| `rackmap_server_id` | `12` |
| `rackmap_hostname` | `db-01.example.com` |
| `rackmap_environment` | `on-premise` |
| `rackmap_location` | `dc1` |
| `rackmap_server_type` | `baremetal` |
| `rackmap_status` | `up` / `down` / `unknown` |
| `rackmap_tags` | `,db,web,` — sorted and comma-wrapped; match one tag with `regex: ".*,web,.*"` |

| Query parameter | Default | Meaning |
|---|---|---|
| `port` | `PROMETHEUS_SD_DEFAULT_PORT` (9100) | exporter port for every target |
| `address` | `ip` | `ip` or `hostname` as the target host (IPv6 is bracketed) |
| `environment` | — | one environment (case-insensitive) |
| `location` | — | location id or name |
| `tag` | — | repeatable; a server must carry every listed tag |
| `status` | — | `up`, `down` or `unknown` |
| `excludeDown` | `false` | `true` skips servers currently probed as down |

```bash
curl -s -H "Authorization: Bearer $RACKMAP_API_KEY" \
  "https://rackmap.example.com/api/v1/prometheus/sd?tag=monitored&excludeDown=true" | jq .
```

`rackmap_status` changes with every probe result; drop it (and `rackmap_tags`)
in `relabel_configs` rather than attaching it to every scraped series — the
example config shows how, and maps `rackmap_server_id` to `server_id` so
exporter series join with RackMap's per-server series.

### Grafana dashboard

**Dashboards → New → Import**, upload `grafana/rackmap-fleet.json`, and pick
the Prometheus data source that scrapes RackMap. It covers servers up/down,
probe latency, certificate expiry, heartbeats, runbook runs, alert deliveries,
pending and security updates, reboots required, open drift by severity and
active access grants. The **Environment** variable filters the server panels.
