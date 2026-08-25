@echo off
REM Show the semantius-idp containers' status: created / running / exited.
cd /d "%~dp0"
docker compose --env-file ..\.env ps -a
