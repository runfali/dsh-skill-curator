@echo off
rem 停止 dsh 之后双击本文件：把历史会话里的真实使用时间回填进 lifecycle.json
rem 先干跑一遍看 diff，确认后回车再写入
cd /d "%~dp0.."
node scripts\backfill-usage.mjs
echo.
set /p GO=确认写入请按回车（Ctrl+C 取消）...
node scripts\backfill-usage.mjs --write
pause
