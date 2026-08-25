#!/usr/bin/env bash
# Follow the IdP's logs. Any argument is a service name, so `./idp-logs.sh
# postgres` follows the database instead; with none it follows `idp`, which is
# what you want nine times in ten.
set -euo pipefail
cd "$(dirname "$0")"

if [ "$#" -eq 0 ]; then
  docker compose --env-file ../.env logs -f idp
else
  docker compose --env-file ../.env logs -f "$@"
fi
