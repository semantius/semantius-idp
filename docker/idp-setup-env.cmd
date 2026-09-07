@echo off
REM idp-setup-env.cmd - create ..\.env from ..\.env.example on first run, with
REM UNIQUE secrets. The Windows twin of idp-setup-env.sh;
REM idp-create.cmd calls it in place of the plain `copy` it used to do.
REM
REM A fresh IDP_SECRET, both database passwords (the application role's spliced
REM into DATABASE_URL as well) and the two example-client secrets are generated
REM before the file is written, because all of them are load-bearing BEFORE the
REM first boot: IDP_SECRET encrypts the stored signing keys, and the passwords
REM are baked into the database by init scripts that run once per data
REM directory.
REM
REM IDEMPOTENT: an existing .env is never touched.
REM
REM Batch has no CSPRNG, so the work lives in idp-setup-env.ps1 next to this
REM file and this is just the entry point.
cd /d "%~dp0"

where powershell >nul 2>&1
if errorlevel 1 (
  echo powershell not found - copy .env.example to .env and set IDP_SECRET,
  echo POSTGRES_PASSWORD, IDP_DB_PASSWORD ^(also inside DATABASE_URL^) and the
  echo two EXAMPLE_*_CLIENT_SECRET values by hand.
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0idp-setup-env.ps1"
exit /b %ERRORLEVEL%
