@echo off
rem Backfill skill usage history into lifecycle.json.
rem Close dsh completely BEFORE running this, otherwise the running plugin
rem rewrites the whole in-memory table and silently clobbers the result.
setlocal
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo node.exe not found in PATH.
  pause
  exit /b 1
)
node scripts\backfill-usage.mjs
echo.
set /p GO=Press Enter to WRITE (Ctrl+C to cancel)...
node scripts\backfill-usage.mjs --write
pause
