@echo off
title BimmerStein Bin Analyzer (dev)
cd /d "%~dp0"
echo ============================================================
echo   BimmerStein Bin Analyzer - launching in DEV mode (hot-reload)
echo   First launch compiles Rust; give it a few minutes.
echo ============================================================
echo.
call corepack pnpm install --prefer-offline
if errorlevel 1 (echo. & echo *** pnpm install failed - see messages above *** & pause & exit /b 1)
call corepack pnpm --filter desktop tauri dev
echo.
echo BimmerStein Bin Analyzer closed.
pause
