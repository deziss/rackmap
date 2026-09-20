#!/usr/bin/env python3
"""Ansible dynamic inventory backed by RackMap.

RackMap already knows every host, its SSH user and port, and how it is
classified. This exposes that as an Ansible inventory so the fleet stops being
maintained in two places.

Usage
-----
    export RACKMAP_URL=https://rackmap.example.com
    export RACKMAP_API_KEY=sk_...
    ansible-inventory -i contrib/rackmap-inventory.py --list
    ansible -i contrib/rackmap-inventory.py all -m ping
    ansible-playbook -i contrib/rackmap-inventory.py site.yml --limit env_docker

Create the API key in RackMap under Security -> API Keys. Scope it to
**viewer** — this script only reads, and a viewer-scoped key cannot mutate the
inventory even if it leaks.

Environment
-----------
    RACKMAP_URL          Base URL of the RackMap instance (required)
    RACKMAP_API_KEY      API key, "sk_..." (required)
    RACKMAP_TIMEOUT      HTTP timeout in seconds (default 30)
    RACKMAP_VERIFY_TLS   "false" to skip certificate verification (default true)
    RACKMAP_INCLUDE_DOWN "true" to include hosts currently probed as down
                         (default true; set false to skip unreachable hosts)

Groups produced
---------------
    all                      every host
    env_<environment>        on-premise / cloud / ...
    provider_<name>          cloud provider
    location_<name>          datacentre or region
    type_<name>              server type
    allocated_<name>         owning team or project
    tag_<name>               each RackMap tag
    status_up / status_down  last probe result
    gpu                      hosts with at least one GPU

Host variables set: ansible_host, ansible_port, ansible_user, plus the RackMap
metadata under rackmap_* for use in playbook conditionals.

Note: RackMap does not hand out SSH credentials over the API by design, so
authentication is left to your normal Ansible setup (agent, key file, or
ansible_ssh_private_key_file in group_vars).
"""

from __future__ import annotations

import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

PAGE_SIZE = 200


def die(message: str) -> "NoReturn":  # type: ignore[valid-type]
    print(f"rackmap-inventory: {message}", file=sys.stderr)
    sys.exit(1)


def safe_group_name(value: str) -> str:
    """Ansible group names allow letters, digits and underscore."""
    slug = re.sub(r"[^A-Za-z0-9_]+", "_", value.strip().lower()).strip("_")
    return slug or "unknown"


def fetch_servers() -> list[dict]:
    base = os.environ.get("RACKMAP_URL", "").rstrip("/")
    api_key = os.environ.get("RACKMAP_API_KEY", "")
    if not base:
        die("RACKMAP_URL is not set")
    if not api_key:
        die("RACKMAP_API_KEY is not set")

    timeout = float(os.environ.get("RACKMAP_TIMEOUT", "30"))
    context = None
    if os.environ.get("RACKMAP_VERIFY_TLS", "true").lower() == "false":
        context = ssl._create_unverified_context()  # noqa: S323 - opt-in only

    servers: list[dict] = []
    page = 1
    while True:
        query = urllib.parse.urlencode({"page": page, "limit": PAGE_SIZE})
        request = urllib.request.Request(
            f"{base}/api/v1/servers?{query}",
            headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 401:
                die("RackMap rejected the API key (401). Check RACKMAP_API_KEY has not expired.")
            if exc.code == 403:
                die("API key lacks permission to list servers (403).")
            die(f"HTTP {exc.code} from RackMap: {exc.reason}")
        except urllib.error.URLError as exc:
            die(f"cannot reach {base}: {exc.reason}")

        items = payload.get("items", payload if isinstance(payload, list) else [])
        if not items:
            break
        servers.extend(items)

        total_pages = payload.get("totalPages")
        if total_pages is not None:
            if page >= int(total_pages):
                break
        elif len(items) < PAGE_SIZE:
            break
        page += 1

    return servers


def lookup_name(value) -> str | None:
    """Lookup relations arrive as {id, name}; tolerate a bare string too."""
    if isinstance(value, dict):
        return value.get("name")
    if isinstance(value, str):
        return value
    return None


def build_inventory(servers: list[dict]) -> dict:
    include_down = os.environ.get("RACKMAP_INCLUDE_DOWN", "true").lower() != "false"

    inventory: dict = {"_meta": {"hostvars": {}}}
    groups: dict[str, list[str]] = {}

    def add(group: str, host: str) -> None:
        groups.setdefault(group, [])
        if host not in groups[group]:
            groups[group].append(host)

    for server in servers:
        if server.get("deletedAt"):
            continue
        status = server.get("lastStatus") or "unknown"
        if not include_down and status == "down":
            continue

        host = server.get("hostname") or server.get("ip")
        if not host:
            continue

        inventory["_meta"]["hostvars"][host] = {
            "ansible_host": server.get("ip"),
            "ansible_port": server.get("sshPort") or 22,
            "ansible_user": server.get("username"),
            "rackmap_id": server.get("id"),
            "rackmap_environment": server.get("environment"),
            "rackmap_status": status,
            "rackmap_domain": server.get("domain"),
            "rackmap_os": server.get("osType"),
            "rackmap_cpu": server.get("cpu"),
            "rackmap_ram": server.get("ram"),
            "rackmap_disk": server.get("disk"),
            "rackmap_gpu_count": server.get("gpuCount") or 0,
            "rackmap_gpu_type": lookup_name(server.get("gpuType")),
            "rackmap_provider": lookup_name(server.get("cloudProvider")),
            "rackmap_location": lookup_name(server.get("location")),
            "rackmap_type": lookup_name(server.get("serverType")),
            "rackmap_allocated_to": lookup_name(server.get("allocatedTo")),
            "rackmap_purpose": server.get("purpose"),
            "rackmap_tags": [t.get("name") for t in server.get("tags") or [] if t.get("name")],
        }

        add("all", host)
        add(f"status_{safe_group_name(status)}", host)

        for prefix, value in (
            ("env", server.get("environment")),
            ("provider", lookup_name(server.get("cloudProvider"))),
            ("location", lookup_name(server.get("location"))),
            ("type", lookup_name(server.get("serverType"))),
            ("allocated", lookup_name(server.get("allocatedTo"))),
        ):
            if value:
                add(f"{prefix}_{safe_group_name(str(value))}", host)

        for tag in server.get("tags") or []:
            name = tag.get("name")
            if name:
                add(f"tag_{safe_group_name(name)}", host)

        if (server.get("gpuCount") or 0) > 0:
            add("gpu", host)

    for name, hosts in groups.items():
        inventory[name] = {"hosts": sorted(hosts)}

    return inventory


def main() -> None:
    args = sys.argv[1:]

    # --host is required by the inventory API but unused: all host variables are
    # returned up front in _meta, which is the documented fast path.
    if "--host" in args:
        print(json.dumps({}))
        return

    if args and "--list" not in args:
        die(f"unsupported argument(s): {' '.join(args)} (expected --list or --host <name>)")

    print(json.dumps(build_inventory(fetch_servers()), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
