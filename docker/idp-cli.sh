#!/usr/bin/env bash
# The operator CLI (OPS-6), inside the running container:
#
#   ./idp-cli.sh config validate
#   ./idp-cli.sh migrate
#   ./idp-cli.sh rotate-keys
#
# Run against the container rather than a checkout, so the command sees the same
# configuration folder and the same connection strings the IdP itself does.
set -euo pipefail
cd "$(dirname "$0")"

# `-T` when there is no terminal: `docker compose exec` allocates one by
# default and fails outright when stdin is a pipe, which is how this breaks the
# first time somebody puts it in a script.
if [ -t 0 ]; then
  docker compose --env-file ../.env exec idp idp "$@"
else
  docker compose --env-file ../.env exec -T idp idp "$@"
fi
