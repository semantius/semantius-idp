@echo off
REM The operator CLI (OPS-6), inside the running container:
REM
REM   idp-cli.cmd config validate
REM   idp-cli.cmd migrate
REM   idp-cli.cmd rotate-keys
REM
REM Run against the container rather than a checkout, so the command sees the
REM same configuration folder and connection strings the IdP itself does.
cd /d "%~dp0"
docker compose --env-file ..\.env exec idp idp %*
