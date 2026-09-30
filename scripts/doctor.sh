#!/usr/bin/env bash
# Host-side checks. Things a container cannot see: is Docker there, is the
# compose file valid, is the port already taken.
#
#   doctor.sh              everything, warnings included
#   doctor.sh --fatal-only just the blockers (used by `make up`)
set -uo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

FATAL_ONLY=0
[ "${1:-}" = "--fatal-only" ] && FATAL_ONLY=1

fail=0
err()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; }
warn() { [ "$FATAL_ONLY" = 1 ] || printf '  \033[33m!\033[0m %s\n' "$1"; }
ok()   { [ "$FATAL_ONLY" = 1 ] || printf '  \033[32m✓\033[0m %s\n' "$1"; }

[ "$FATAL_ONLY" = 1 ] || echo "Checking..."

# ── Blockers ────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  err "docker is not installed — https://docs.docker.com/get-docker/"
elif ! docker info >/dev/null 2>&1; then
  err "the Docker daemon is not reachable. Start Docker, or add yourself to the docker group."
else
  ok "docker is running"
fi

if [ "$fail" = 0 ]; then
  if ! docker compose version >/dev/null 2>&1; then
    err "'docker compose' (v2) is not available. Docker Desktop ships it; on Linux install docker-compose-plugin."
  else
    ok "docker compose is available"
  fi
fi

if [ ! -f .env ]; then
  err "no .env — run 'make up' (it generates one)."
elif [ "$fail" = 0 ]; then
  # compose's own interpolation is the most thorough config check available,
  # and its error messages already name the offending variable.
  if out=$(docker compose config -q 2>&1); then
    ok ".env and docker-compose.yml are consistent"
  else
    err "docker-compose.yml could not be resolved:"
    printf '      %s\n' "$out"
  fi
fi

# ── Warnings ────────────────────────────────────────────────────────────────
if [ "$FATAL_ONLY" = 0 ] && [ -f .env ]; then
  perms=$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env 2>/dev/null || echo '?')
  if [ "$perms" = "600" ]; then ok ".env is mode 600"
  else warn ".env is mode $perms — it holds your keys. chmod 600 .env"; fi

  get() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2-; }

  port=$(get PORT); port=${port:-8080}
  pgport=$(get POSTGRES_HOST_PORT); pgport=${pgport:-5432}

  port_busy() {
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3<&- 3>&-; return 0; }
    return 1
  }

  if port_busy "$port"; then
    # Our own stack holding it is fine — that is just "already running".
    if docker compose ps --status running 2>/dev/null | grep -q web; then
      ok "port $port is in use by RackMap itself"
    else
      warn "port $port is already in use. Set PORT=8081 in .env, then 'make up'."
    fi
  else
    ok "port $port is free"
  fi

  if port_busy "$pgport"; then
    if docker compose ps --status running 2>/dev/null | grep -q postgres; then
      ok "port $pgport is in use by RackMap's database"
    else
      warn "port $pgport is taken (another PostgreSQL?). Set POSTGRES_HOST_PORT=5433 in .env."
    fi
  else
    ok "port $pgport is free"
  fi

  origin=$(get WEB_ORIGIN)
  if [ -n "$origin" ] && ! printf '%s' "$origin" | grep -q ":$port\b"; then
    warn "WEB_ORIGIN ($origin) does not match PORT ($port). Sign-in will be rejected — they must agree."
  fi

  if [ "$(get NODE_ENV)" != "production" ]; then
    warn "NODE_ENV is not 'production': demo accounts with published credentials will be seeded."
  fi
fi

if [ "$fail" != 0 ]; then
  [ "$FATAL_ONLY" = 1 ] && echo
  echo "Fix the above, then run 'make up' again." >&2
  exit 1
fi

[ "$FATAL_ONLY" = 1 ] || echo "All good."
