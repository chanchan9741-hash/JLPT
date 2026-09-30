@echo off
title JLPT Master
cd /d "%~dp0"
echo Starting JLPT Master Server...
if exist "C:\Program Files\nodejs\node.exe" goto USE_PROGRAM_FILES
node server.js
goto END
:USE_PROGRAM_FILES
"C:\Program Files\nodejs\node.exe" server.js
:END
pause
