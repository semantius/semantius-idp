@echo off
REM Build and start the semantius-idp stack: Postgres plus the IdP image, as its
REM own compose project (semantius-idp, set by "name:" in docker-compose.yml).
REM
REM A clean checkout has no .env and no config\, so this creates both from the
REM examples one level up. After that the only two values it cannot start
REM without are DATABASE_URL and IDP_SECRET (D48).
REM
REM Re-runs are safe: named volumes are kept, so this does NOT lose data. Use
REM idp-destroy.cmd for that.
cd /d "%~dp0"

if not exist "..\.env" (
  copy "..\.env.example" "..\.env" >nul
  echo Created .env from .env.example - set IDP_SECRET in it before this can start.
)

if not exist "..\config" (
  xcopy /e /i /q "..\config.example" "..\config" >nul
  echo Created config\ from config.example\ - the annotated defaults ^(CFG-1^).
)

REM Tags the image under the name "image:" resolves to, so "up" runs what was
REM just built rather than pulling a published one.
docker compose --env-file ..\.env build || goto :err

REM --force-recreate: always replace existing containers with fresh ones built
REM from the current compose config, so create can never resume a stale or
REM half-built container left by an earlier failed "up". --remove-orphans drops
REM services no longer in the file. --wait blocks until every container reports
REM healthy, which for the IdP means the migrations ran and /healthz answers.
docker compose --env-file ..\.env up -d --force-recreate --remove-orphans --wait || goto :err
docker compose --env-file ..\.env ps

echo.
echo Ready (semantius-idp).
echo   IdP : http://localhost:3000   (or IDP_BASE_URL / IDP_PORT from .env)
echo.
echo On a database with no users that address shows the first-run setup page:
echo whoever completes it becomes the first administrator (D52).
exit /b 0

:err
echo.
echo Failed. Is Docker Desktop running?
exit /b 1
