#!/usr/bin/env bash
# Show the semantius-idp containers' status: created / running (healthy) / exited.
# Prints only the header once the stack has been destroyed (./idp-destroy.sh).
cd "$(dirname "$0")" || exit 1
docker compose --env-file ../.env ps -a
