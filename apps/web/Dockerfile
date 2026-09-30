FROM node:24-alpine AS base
RUN corepack enable pnpm

# ── deps ─────────────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/web/package.json ./apps/web/
# --frozen-lockfile: the image must match the lockfile that was tested.
#
# The retry is not superstition: the most common first-build failure on a home
# or corporate connection is a flaky registry, and pnpm aborts the whole install
# on one EAI_AGAIN/ETIMEDOUT — minutes of downloading thrown away, reported by
# docker as a build failure that reads like a broken app. The lower concurrency
# is for the same reason: 16 parallel sockets is what pushes a weak link over.
# If every attempt fails the build still fails, loudly — this only absorbs a
# blip, it does not paper over a real outage.
RUN for attempt in 1 2 3; do \
      pnpm install --frozen-lockfile \
        --fetch-retries 5 \
        --fetch-retry-maxtimeout 120000 \
        --network-concurrency 8 \
      && exit 0; \
      echo "pnpm install failed (attempt $attempt of 3) — retrying in 15s..." >&2; \
      sleep 15; \
    done; \
    echo "pnpm install failed three times. If the log shows EAI_AGAIN or" >&2; \
    echo "ETIMEDOUT the npm registry was unreachable — check your network or" >&2; \
    echo "proxy and run 'make up' again." >&2; \
    exit 1

# ── build ─────────────────────────────────────────────────────────────────────
FROM deps AS builder
WORKDIR /app
# VITE_ vars are baked into the JS bundle at build time, not runtime
ARG VITE_SECURITY_LOCK=false
ENV VITE_SECURITY_LOCK=$VITE_SECURITY_LOCK
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
RUN pnpm --filter @inv/shared build
RUN pnpm --filter @inv/web build

# ── nginx serve ───────────────────────────────────────────────────────────────
FROM nginx:alpine AS runtime
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
