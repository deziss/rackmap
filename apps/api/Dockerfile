FROM node:22-alpine AS base
RUN corepack enable pnpm

# ── deps ─────────────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
RUN pnpm install --no-frozen-lockfile

# ── build ─────────────────────────────────────────────────────────────────────
FROM deps AS builder
WORKDIR /app
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
RUN pnpm --filter @inv/shared build
RUN pnpm --filter @inv/api build

# Generate Prisma client
RUN pnpm --filter @inv/api exec prisma generate

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
RUN corepack enable pnpm
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/api/src ./apps/api/src
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/package.json ./

WORKDIR /app/apps/api
VOLUME ["/data"]
ENV DATABASE_URL="file:/data/inventory.db"
ENV PORT=3001
EXPOSE 3001

# Run migrations, seed the database, then start
# CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && pnpm run db:seed && node dist/index.js"]
# Run db push, seed the database, then start
CMD ["sh", "-c", "node_modules/.bin/prisma db push --accept-data-loss && pnpm run db:seed && node dist/index.js"]

