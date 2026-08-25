@echo off
REM Stop the semantius-idp containers WITHOUT removing them. Containers, network
REM and volumes are all KEPT, so idp-start.cmd resumes the same ones. Use
REM idp-destroy.cmd to actually remove containers + data.
cd /d "%~dp0"
docker compose --env-file ..\.env stop
echo Stopped. Containers kept - idp-start.cmd to resume.
