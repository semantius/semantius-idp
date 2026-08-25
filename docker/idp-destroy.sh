#!/usr/bin/env bash
# Destroy the semantius-idp stack: its containers, network and volumes — which
# includes the Postgres data directory, so every user, signing key and token
# goes with it. The image is kept (a reusable, versioned artefact) and so are
# ../.env and ../config.
set -euo pipefail
cd "$(dirname "$0")"

read -r -p "This DELETES the idp Postgres volume (all users, keys and tokens). Continue? [y/N] " ans
case "$ans" in
  y|Y) ;;
  *) echo "Cancelled."; exit 0 ;;
esac

# `--profile caddy` so a TLS front end started by `--profile caddy up` is
# removed too, rather than left behind as an orphan pointing at nothing.
docker compose --env-file ../.env --profile caddy down -v
echo "Removed the semantius-idp containers, network and volumes (image kept)."
