@echo off
setlocal
cd /d "%~dp0"
set "LIBRARY_NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" (
    set "LIBRARY_NODE=%ProgramFiles%\nodejs\node.exe"
  ) else (
    echo Library Search needs Node.js 20 or newer. Install it from https://nodejs.org/
    pause
    exit /b 1
  )
)
"%LIBRARY_NODE%" "%~dp0library_search_server.cjs" --open
if errorlevel 1 pause
endlocal
