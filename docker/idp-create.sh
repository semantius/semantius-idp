#!/usr/bin/env bash
# Build and start the semantius-idp stack: Postgres plus the IdP image, as its
# own compose project (semantius-idp, set by `name:` in docker-compose.yml).
#
# A clean checkout has no `.env` and no `config/`, so this creates both from the
# examples one level up — `.env` through idp-setup-env.sh, which generates every
# secret in it, so nothing has to be edited before the first start. The
# two values it cannot start without, DATABASE_URL and IDP_SECRET, are
# both in the generated file.
#
# Re-runs are safe. Named volumes are kept, so this does NOT lose data; use
# ./idp-destroy.sh for that.
set -euo pipefail
cd "$(dirname "$0")"

compose() { docker compose --env-file ../.env "$@"; }
docker_hint() { echo; echo "Failed. Is Docker Desktop running?" >&2; exit 1; }

# Not a plain copy: idp-setup-env.sh writes a generated IDP_SECRET, both
# database passwords and the example-client secrets into the new .env,
# so a first run boots without an edit and never holds the values .env.example
# ships. All of them have to be right BEFORE the first boot — see its header.
# It is a no-op when .env already exists, whatever that file contains.
fresh_env=0
if [ ! -f ../.env ]; then
  ./idp-setup-env.sh
  fresh_env=1
fi

if [ ! -d ../config ]; then
  cp -r ../config.example ../config
  echo "Created config/ from config.example/ — the annotated defaults."
fi

# A freshly generated .env next to a kept database volume cannot work: the
# volume was initialized with the OLD passwords (Postgres reads them once, at
# initdb), the new file names ones it has never seen, and `up --wait` would sit
# on "password authentication failed" three screens into a log nobody has
# opened yet. Say so here, before anything is built. The project name is parsed
# from `name:` so it stays a single source of truth; the volume is the one
# compose names from it.
if [ "$fresh_env" = 1 ]; then
  project="$(sed -nE 's/^name:[[:space:]]*([^[:space:]#]+).*/\1/p' docker-compose.yml | head -1)"
  if docker volume inspect "${project}_pgdata" >/dev/null 2>&1; then
    cat >&2 <<EOF

A database volume (${project}_pgdata) already exists, and .env was just
generated with new passwords. That volume was initialized with the old ones,
so the IdP would not be able to connect. Either

  ./idp-destroy.sh      # removes the volume and ALL its data; then re-run this

or put the previous POSTGRES_PASSWORD, IDP_DB_PASSWORD and DATABASE_URL back
into ../.env by hand, from wherever the old file went.

Nothing was built or started.
EOF
    exit 1
  fi
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
echo "whoever completes it becomes the first administrator."
