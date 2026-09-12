@echo off
chcp 65001 >nul
title Stop MiMo Token Statistics
set PORT=8765

echo Stopping MiMo Token Statistics on port %PORT% ...

for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":%PORT%"') do (
    echo Killing PID %%a
    taskkill /PID %%a /F >nul 2>nul
)

echo Done.
timeout /t 1 >nul
