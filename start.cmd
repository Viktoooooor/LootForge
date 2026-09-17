@echo off
title LootForge
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   LootForge needs Node.js 18 or newer.
  echo   Download it from https://nodejs.org/ ^(the LTS version^), install it and run start.cmd again.
  echo.
  pause
  exit /b 1
)

set OPEN_BROWSER=1
node server.js
if errorlevel 1 pause
