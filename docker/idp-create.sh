#!/usr/bin/env bash
# Build and start the semantius-idp stack: Postgres plus the IdP image, as its
# own compose project (semantius-idp, set by `name:` in docker-compose.yml).
#
# A clean checkout has no `.env` and no `config/`, so this creates both from the
# examples one level up. After that the only two values it cannot start without
# are DATABASE_URL and IDP_SECRET (D48) — everything else has a default.
#
# Re-runs are safe. Named volumes are kept, so this does NOT lose data; use
# ./idp-destroy.sh for that.
set -euo pipefail
cd "$(dirname "$0")"

compose() { docker compose --env-file ../.env "$@"; }
docker_hint() { echo; echo "Failed. Is Docker Desktop running?" >&2; exit 1; }

if [ ! -f ../.env ]; then
  cp ../.env.example ../.env
  echo "Created .env from .env.example — set IDP_SECRET in it before this can start."
fi

if [ ! -d ../config ]; then
  cp -r ../config.example ../config
  echo "Created config/ from config.example/ — the annotated defaults (CFG-1)."
fi

# Tags the image under the name `image:` resolves to, so `up` runs what was just
# built rather than pulling a published one.
compose build || docker_hint

# --force-recreate: always replace existing containers with fresh ones built
# from the current compose config, so create can never resume a stale or
# half-built container left by an earlier failed `up`. --remove-orphans drops
# services no longer in the file. --wait blocks until every container reports
# healthy, which for the IdP means the migrations ran and /healthz answers.
compose up -d --force-recreate --remove-orphans --wait || docker_hint
compose ps

# The shell first, then the file. Compose resolves these the same way — a shell
# value beats `--env-file` — so printing the file's would name an address the
# stack is not on whenever somebody overrode one for a single run.
#
# Read back rather than sourced: a connection string in .env can contain `&`,
# and `. ../.env` would run half of it.
base_url="${IDP_BASE_URL:-$(sed -n 's/^IDP_BASE_URL=//p' ../.env | tail -1)}"
port="${IDP_PORT:-$(sed -n 's/^IDP_PORT=//p' ../.env | tail -1)}"

echo
echo "Ready (semantius-idp)."
echo "  IdP : ${base_url:-http://localhost:${port:-3000}}"
echo
echo "On a database with no users that address shows the first-run setup page:"
echo "whoever completes it becomes the first administrator (D52)."
