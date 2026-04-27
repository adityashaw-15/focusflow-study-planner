@echo off
setlocal

set "PROJECT_ROOT=%~dp0"
set "PORT=%~1"

if "%PORT%"=="" set "PORT=8090"

powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%start-server.ps1" -Port %PORT%
