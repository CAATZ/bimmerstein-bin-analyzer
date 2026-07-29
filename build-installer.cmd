@echo off
title BimmerStein Bin Analyzer - build installer
cd /d "%~dp0"
echo ============================================================
echo   BimmerStein Bin Analyzer - building a distributable installer
echo   This can take 10+ minutes the first time (Rust release build).
echo ============================================================
echo.
call corepack pnpm install --prefer-offline
if errorlevel 1 (echo. & echo *** pnpm install failed - see messages above *** & pause & exit /b 1)
call corepack pnpm --filter desktop tauri build
if errorlevel 1 (echo. & echo *** build failed - see messages above *** & pause & exit /b 1)
echo.
echo ============================================================
echo   Build complete. Your installer/app is under:
echo   apps\desktop\src-tauri\target\release\bundle\
echo     - \msi\   Windows Installer (.msi)
echo     - \nsis\  Setup executable (.exe)
echo   Standalone app (no install needed): apps\desktop\src-tauri\target\release\desktop.exe
echo ============================================================
pause
