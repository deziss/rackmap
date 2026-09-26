FROM node:26-alpine AS base
RUN corepack enable pnpm

# ── deps ─────────────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
# --frozen-lockfile: the image must be reproducible. A build that silently
# resolves different versions than the lockfile is not the thing that was tested.
RUN pnpm install --frozen-lockfile

# ── build ─────────────────────────────────────────────────────────────────────
FROM deps AS builder
WORKDIR /app
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
RUN pnpm --filter @inv/shared build
RUN pnpm --filter @inv/api build

# Generate Prisma client
RUN pnpm --filter @inv/api exec prisma generate

# NOTE: the runtime image still carries devDependencies.
#
# `pnpm deploy --prod` prunes them correctly, but under pnpm's isolated
# node_modules layout the generated Prisma client ends up unreachable from the
# pruned tree (`Cannot find module '.prisma/client/default'`), and the Prisma
# CLI — needed at start for `migrate deploy` — is itself a devDependency.
# Shipping a slightly larger image is preferable to shipping a broken one, so
# the full dependency tree is copied below. Revisit when Prisma's pnpm story
# improves.

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:26-alpine AS runtime
# pg_dump for the scheduled backups (services/backup.service.ts). Its major
# version must be >= the server's: pg_dump refuses to dump a newer server.
# postgresql18-client is in Alpine 3.23+; node:24-alpine is currently 3.24.
RUN corepack enable pnpm && apk add --no-cache postgresql18-client
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma

WORKDIR /app/apps/api

# /data holds the SSH keys the operator drops in (and, on installs upgraded from
# SQLite, the old inventory.db); /backups receives the pg_dump backups. Both must
# be writable by the unprivileged user the process runs as.
RUN mkdir -p /data /backups && chown -R node:node /app /data /backups
VOLUME ["/data"]

# No DATABASE_URL default: the database is PostgreSQL, and a baked-in URL could
# only ever be wrong. docker-compose.yml derives it from POSTGRES_*.
ENV PORT=3001
EXPOSE 3001

# Drop root. Nothing here needs privileged ports or privileged files.
USER node

# `migrate deploy` applies the committed migration history and refuses to
# proceed on drift. The previous `db push --accept-data-loss` silently dropped
# columns, and it meant the Docker and systemd paths built different schemas.
#
# ensure-baseline adopts databases created by the old `db push` image into the
# migration history first, so an upgrade does not abort on "table already
# exists". Seeding is idempotent and self-limiting (see seed.ts).
CMD ["sh", "-c", "node prisma/ensure-baseline.mjs && pnpm exec prisma migrate deploy && node dist/seed.js && node dist/index.js"]
