@echo off
chcp 65001 >nul
title MiMo Token Statistics
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel%==0 (
  python server.py %*
) else (
  py -3 server.py %*
)

pause
