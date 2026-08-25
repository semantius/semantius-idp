#!/usr/bin/env bash
# Stop the semantius-idp containers WITHOUT removing them. Containers, network
# and volumes are all KEPT, so ./idp-start.sh resumes the same ones. Use
# ./idp-destroy.sh to actually remove containers + data.
set -euo pipefail
cd "$(dirname "$0")"

docker compose --env-file ../.env stop
echo "Stopped. Containers kept — ./idp-start.sh to resume."
