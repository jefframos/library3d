@echo off
rem Rebuilds library\index.json (the model list the game editors read) from files\, then closes after 3 seconds.
cd /d "%~dp0"
call npm run scan
timeout /t 3 /nobreak >nul
