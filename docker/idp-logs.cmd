@echo off
REM Follow the IdP's logs. Any argument is a service name, so "idp-logs.cmd
REM postgres" follows the database instead; with none it follows "idp".
cd /d "%~dp0"
if "%~1"=="" (
  docker compose --env-file ..\.env logs -f idp
) else (
  docker compose --env-file ..\.env logs -f %*
)
