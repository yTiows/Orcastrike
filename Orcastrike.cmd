@echo off
rem Orcastrike for Windows. Double-click to start, or run: Orcastrike.cmd start / stop / setup / update / doctor
rem Everything is done by scripts\orca.mjs (details: SETUP.md). No admin rights needed.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13 or newer is required and was not found.
  echo Install it with:  winget install OpenJS.NodeJS.LTS
  echo or get the LTS installer from https://nodejs.org, then open a new window and run this again.
  pause
  exit /b 1
)
if "%~1"=="" (
  node --disable-warning=ExperimentalWarning scripts\orca.mjs start
) else (
  node --disable-warning=ExperimentalWarning scripts\orca.mjs %*
)
set "rc=%errorlevel%"
if not "%rc%"=="0" pause
exit /b %rc%
