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
