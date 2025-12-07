@echo off
setlocal

echo ==========================================
echo   HTTPS Server Manager - Windows Starter
echo ==========================================
echo.

REM --- Script directory (where server.js etc. live) ---
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

REM --- Hard-set port to 3001 ---
set "PORT=3001"

REM --- Default config file (relative to this folder) ---
if not defined CONFIG_FILE set "CONFIG_FILE=%SCRIPT_DIR%config.json"

REM --- Default projects directory (CHANGE THIS IF YOU WANT) ---
if not defined PROJECTS_DIR set "PROJECTS_DIR=E:\JupyterLocal\projects"

echo [INFO] Using settings:
echo   Port:   %PORT%
echo   Config: %CONFIG_FILE%
echo   Projects Directory: %PROJECTS_DIR%
echo.

REM ───────────────────────────────────────────────
REM 1) Check that Node.js is installed
REM ───────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js was not found in PATH.
    echo         Please install Node.js from https://nodejs.org/
    echo         Then re-run this script.
    echo.
    goto :DONE
)

echo [OK] Node.js found:
node -v
echo.

REM ───────────────────────────────────────────────
REM 2) Sanity check: package.json should exist
REM ───────────────────────────────────────────────
if not exist "%SCRIPT_DIR%package.json" (
    echo [ERROR] package.json not found in:
    echo   %SCRIPT_DIR%
    echo.
    echo This folder might be incomplete. Expected at least:
    echo   server.js
    echo   package.json
    echo   package-lock.json
    echo   public\index.html, app.js, style.css
    echo.
    goto :DONE
)

REM ───────────────────────────────────────────────
REM 3) Install dependencies if node_modules is missing
REM ───────────────────────────────────────────────
if not exist "%SCRIPT_DIR%node_modules" (
    echo [INFO] node_modules folder not found.
    echo        Running "npm install" to install dependencies...
    echo.

    npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] "npm install" failed. Check the output above for details.
        echo        Fix the issue, then re-run this script.
        echo.
        goto :DONE
    )

    echo.
    echo [OK] Dependencies installed successfully.
    echo.
) else (
    echo [OK] node_modules already exists. Skipping npm install.
    echo.
)

REM ───────────────────────────────────────────────
REM 4) Start the Node server
REM ───────────────────────────────────────────────
echo [INFO] Starting HTTP Server Manager on http://localhost:%PORT%
echo   (Press Ctrl+C in this window to stop it.)
echo.

node server.js
set "EXITCODE=%ERRORLEVEL%"

echo.
echo [INFO] server.js exited with code %EXITCODE%
echo.

:DONE
echo Press any key to close this window...
pause >nul

endlocal
exit /b %EXITCODE%
