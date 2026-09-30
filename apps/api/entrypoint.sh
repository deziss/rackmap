#!/bin/sh
# Resolve DATABASE_URL, then hand off to the command.
#
# Why this exists: the URL used to be assembled in docker-compose.yml by string
# interpolation. Compose cannot percent-encode, so a password containing "/",
# "?" or "#" silently produced a corrupt URL — "/" terminates the authority
# early, so postgresql://user:ab/cd@postgres:5432/db parses host "user", port
# "ab", and Prisma reports "invalid port number in database URL". `openssl rand
# -base64 32` emits "/" in roughly 70% of draws, so this was easy to hit and
# very hard to diagnose: Postgres itself accepts the same password happily (it
# never parses it as a URL), so the database container stayed green while the
# API crash-looped.
#
# Building the URL here instead means the password is encoded exactly once, by
# code that understands URLs. It has to happen before the command rather than
# inside the app because `prisma migrate deploy` is a separate process that
# reads DATABASE_URL from the environment.
set -e

if [ -z "${DATABASE_URL:-}" ]; then
  if [ -n "${DOCKER_DATABASE_URL:-}" ]; then
    # Explicit override for an external database. Passed through untouched —
    # the operator owns the encoding of a URL they wrote themselves.
    DATABASE_URL="$DOCKER_DATABASE_URL"
  elif [ -n "${POSTGRES_PASSWORD:-}" ]; then
    DATABASE_URL=$(
      POSTGRES_USER="${POSTGRES_USER:-rackmap}" \
      POSTGRES_DB="${POSTGRES_DB:-rackmap}" \
      POSTGRES_HOST="${POSTGRES_HOST:-postgres}" \
      POSTGRES_PORT="${POSTGRES_PORT:-5432}" \
      node -e '
        const enc = encodeURIComponent;
        const { POSTGRES_USER: u, POSTGRES_PASSWORD: p, POSTGRES_DB: d,
                POSTGRES_HOST: h, POSTGRES_PORT: port } = process.env;
        process.stdout.write(
          `postgresql://${enc(u)}:${enc(p)}@${h}:${port}/${enc(d)}`
        );
      '
    )
  else
    echo "rackmap: no database configured." >&2
    echo "  Set POSTGRES_PASSWORD (the bundled database), or DOCKER_DATABASE_URL" >&2
    echo "  (an external one). Run 'make setup' to generate a working .env." >&2
    exit 1
  fi
  export DATABASE_URL
fi

exec "$@"
