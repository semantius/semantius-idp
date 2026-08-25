#!/usr/bin/env bash
# Start the semantius-idp containers that ./idp-create.sh already created. This
# ONLY starts existing (stopped) containers — it never creates them. If the
# stack has not been created yet (or was destroyed), run ./idp-create.sh.
set -euo pipefail
cd "$(dirname "$0")"

compose() { docker compose --env-file ../.env "$@"; }
docker_hint() { echo; echo "Failed. Is Docker Desktop running?" >&2; exit 1; }

if [ ! -f ../.env ]; then
  echo "No .env found. Run ./idp-create.sh first (it copies .env.example)." >&2
  exit 1
fi

if [ -z "$(compose ps -aq 2>/dev/null)" ]; then
  echo "No containers exist. Run ./idp-create.sh first." >&2
  exit 1
fi

compose start || docker_hint
compose ps
