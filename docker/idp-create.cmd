@echo off
REM Build and start the semantius-idp stack: Postgres plus the IdP image, as its
REM own compose project (semantius-idp, set by "name:" in docker-compose.yml).
REM
REM A clean checkout has no .env and no config\, so this creates both from the
REM examples one level up - .env through idp-setup-env.cmd, which generates
REM every secret in it, so nothing has to be edited before the first
REM start. The two values it cannot start without, DATABASE_URL and IDP_SECRET
REM, are both in the generated file.
REM
REM Re-runs are safe: named volumes are kept, so this does NOT lose data. Use
REM idp-destroy.cmd for that.
cd /d "%~dp0"

REM Not a plain copy: idp-setup-env.cmd writes a generated IDP_SECRET, both
REM database passwords and the example-client secrets into the new .env,
REM so a first run boots without an edit and never holds the values
REM .env.example ships. All of them have to be right BEFORE the first boot -
REM see its header. It is a no-op when .env already exists, whatever that file
REM contains.
set "FRESH_ENV=0"
if exist "..\.env" goto :env_done
call "%~dp0idp-setup-env.cmd" || goto :err
set "FRESH_ENV=1"
:env_done

if not exist "..\config" (
  xcopy /e /i /q "..\config.example" "..\config" >nul
  echo Created config\ from config.example\ - the annotated defaults.
)

REM A freshly generated .env next to a kept database volume cannot work: the
REM volume was initialized with the OLD passwords (Postgres reads them once, at
REM initdb), the new file names ones it has never seen, and "up --wait" would
REM sit on "password authentication failed" three screens into a log nobody
REM has opened yet. Say so here, before anything is built. The project name is
REM parsed from "name:" so it stays a single source of truth; the volume is
REM the one compose names from it.
if not "%FRESH_ENV%"=="1" goto :volume_done
set "PROJECT="
for /f "tokens=2 delims=: " %%A in ('findstr /b /c:"name:" docker-compose.yml') do if not defined PROJECT set "PROJECT=%%A"
docker volume inspect "%PROJECT%_pgdata" >nul 2>&1
if not errorlevel 1 goto :old_volume
:volume_done

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
echo whoever completes it becomes the first administrator.
exit /b 0

:old_volume
echo.
echo A database volume (%PROJECT%_pgdata) already exists, and .env was just
echo generated with new passwords. That volume was initialized with the old
echo ones, so the IdP would not be able to connect. Either
echo.
echo   idp-destroy.cmd      removes the volume and ALL its data; then re-run this
echo.
echo or put the previous POSTGRES_PASSWORD, IDP_DB_PASSWORD and DATABASE_URL
echo back into ..\.env by hand, from wherever the old file went.
echo.
echo Nothing was built or started.
exit /b 1

:err
echo.
echo Failed. Is Docker Desktop running?
exit /b 1
