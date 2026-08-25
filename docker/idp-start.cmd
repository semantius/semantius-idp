@echo off
REM Start the semantius-idp containers that idp-create.cmd already created. This
REM ONLY starts existing (stopped) containers - it never creates them. If the
REM stack has not been created yet (or was destroyed), run idp-create.cmd.
cd /d "%~dp0"

if not exist "..\.env" (
  echo No .env found. Run idp-create.cmd first ^(it copies .env.example^).
  goto :err
)

for /f %%i in ('docker compose --env-file ..\.env ps -aq') do set HAVE=1
if not defined HAVE (
  echo No containers exist. Run idp-create.cmd first.
  goto :err
)

docker compose --env-file ..\.env start || goto :err
docker compose --env-file ..\.env ps
exit /b 0

:err
echo.
echo Failed. Is Docker Desktop running?
exit /b 1
