@echo off
rem ---------------------------------------------------------------------------
rem  MPU6050 Web Visualizer - local launcher (Windows, no install needed)
rem
rem  Serves the web\ folder on http://localhost:8000 and opens it in Chrome or
rem  Edge (Web Serial only works in those browsers, over localhost or https).
rem
rem  Usage:  start.bat         connect a real sensor
rem          start.bat demo    open in demo mode (no hardware)
rem ---------------------------------------------------------------------------
setlocal EnableDelayedExpansion
set "PORT=8000"
set "URL=http://localhost:%PORT%/"
if /i "%~1"=="demo" set "URL=%URL%?demo"

rem Find a browser with Web Serial support (first match wins).
set "BROWSER=default"
for %%B in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do if "!BROWSER!"=="default" if exist %%B set "BROWSER=%%~B"

echo.
echo   MPU6050 Web Visualizer
echo   ----------------------
echo   App:     %URL%
echo   Browser: !BROWSER!
echo   Stop:    press Ctrl+C or close this window
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\serve.ps1" -Root "%~dp0web" -Port %PORT% -Open "%URL%" -Browser "!BROWSER!"
endlocal
