@echo off
REM Destroy the semantius-idp stack: its containers, network and volumes - which
REM includes the Postgres data directory, so every user, signing key and token
REM goes with it. The image is kept, and so are ..\.env and ..\config.
cd /d "%~dp0"

set /p ans=This DELETES the idp Postgres volume (all users, keys and tokens). Continue? [y/N] 
if /i not "%ans%"=="y" (
  echo Cancelled.
  exit /b 0
)

REM --profile caddy so a TLS front end started by "--profile caddy up" is removed
REM too, rather than left behind as an orphan pointing at nothing.
docker compose --env-file ..\.env --profile caddy down -v
echo Removed the semantius-idp containers, network and volumes (image kept).
