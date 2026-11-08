@echo off
rem ---------------------------------------------------------------------------
rem  MPU6050 Projects - local launcher (Windows, no install needed)
rem
rem  Serves this folder on http://localhost:8000 and opens the project page in
rem  Chrome or Edge (Web Serial only works in those browsers).
rem
rem  Usage:  start.bat              project list
rem          start.bat visualizer   open the motion visualizer
rem          start.bat leveler      open the digital leveler
rem          add "demo" for demo mode, e.g.  start.bat leveler demo
rem ---------------------------------------------------------------------------
setlocal EnableDelayedExpansion
set "PORT=8000"
set "URL=http://localhost:%PORT%/"
if /i "%~1"=="visualizer" set "URL=%URL%visualizer/web/"
if /i "%~1"=="leveler"    set "URL=%URL%leveler/web/"
if /i "%~1"=="demo" set "URL=%URL%visualizer/web/?demo"
if /i "%~2"=="demo" set "URL=%URL%?demo"

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
echo   MPU6050 Projects
echo   ----------------
echo   App:     %URL%
echo   Browser: !BROWSER!
echo   Stop:    press Ctrl+C or close this window
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\serve.ps1" -Root "%~dp0." -Port %PORT% -Open "%URL%" -Browser "!BROWSER!"
endlocal
