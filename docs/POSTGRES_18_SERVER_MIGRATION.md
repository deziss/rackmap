# PostgreSQL 18 Server Migration

This guide has moved into [MIGRATION.md](../MIGRATION.md), which is kept up to date with each release. An earlier
copy here described the pre-1.0 `docker compose --profile postgres` setup, which no longer exists: in RackMap 1.0 the
`postgres` service always runs and `POSTGRES_PASSWORD` is required.

| You want to… | Go to |
|---|---|
| Upgrade an existing 0.8.x install (SQLite) to 1.0.0 | [Upgrading 0.8.x → 1.0.0](../MIGRATION.md#upgrading-08x--100) |
| Copy a SQLite database into PostgreSQL | [Docker Compose upgrade](../MIGRATION.md#docker-compose-upgrade) · [Bare-metal upgrade](../MIGRATION.md#bare-metal-upgrade) |
| Move RackMap to another server | [Moving RackMap to another server](../MIGRATION.md#moving-rackmap-to-another-server-postgresql-18) |
| Deploy on a host-native PostgreSQL 18 with systemd | [Option B: Bare-Metal / Systemd](../MIGRATION.md#option-b-bare-metal--systemd-deployment-host-postgresql-18) |
| Back up or restore the database | [Backups & Restore](../MIGRATION.md#9-backups--restore) |
| Recover from a failed `20260921000000_postgres_baseline` migration | [If `migrate deploy` failed](../MIGRATION.md#if-migrate-deploy-failed-on-20260921000000_postgres_baseline) |
