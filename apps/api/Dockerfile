FROM node:24-alpine AS base
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

# Prune dev dependencies so the runtime image does not ship tsup, tsx, vitest
# and typescript. Prisma's CLI is a devDependency but is needed at start for
# `migrate deploy`, so it is reinstalled explicitly below.
RUN pnpm --filter @inv/api --prod deploy /app/pruned

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
RUN corepack enable pnpm
WORKDIR /app

COPY --from=builder /app/pruned/node_modules ./node_modules
COPY --from=builder /app/pruned/package.json ./package.json
COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/apps/api/prisma ./prisma
# The generated Prisma client lives in the builder's node_modules.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma

# /data holds the SQLite database and any SSH keys the operator drops in, so it
# must be writable by the unprivileged user the process runs as.
RUN mkdir -p /data /backups && chown -R node:node /app /data /backups
VOLUME ["/data"]

ENV DATABASE_URL="file:/data/inventory.db"
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
CMD ["sh", "-c", "node prisma/ensure-baseline.mjs && node_modules/.bin/prisma migrate deploy && node dist/seed.js && node dist/index.js"]
