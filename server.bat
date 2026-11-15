@echo off
setlocal
cd /d "%~dp0"

echo Iniciando MR Pag em http://localhost:8007
call npx wrangler dev --port 8007
if errorlevel 1 pause