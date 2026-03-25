@echo off
REM collab-cli.cmd — Launch the Collaborator Electron app from the command line.
REM Installed to %USERPROFILE%\.local\bin\collab.cmd by the app.

setlocal

REM Check common install locations
set "APP_PATH=%LOCALAPPDATA%\Programs\Collaborator\Collaborator.exe"
if exist "%APP_PATH%" goto :launch

set "APP_PATH=%PROGRAMFILES%\Collaborator\Collaborator.exe"
if exist "%APP_PATH%" goto :launch

set "APP_PATH=%PROGRAMFILES(x86)%\Collaborator\Collaborator.exe"
if exist "%APP_PATH%" goto :launch

echo Error: Collaborator.exe not found. Is it installed? >&2
exit /b 1

:launch
start "" "%APP_PATH%" %*
