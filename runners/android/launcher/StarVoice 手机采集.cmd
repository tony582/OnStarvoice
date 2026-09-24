@echo off
rem Double-click launcher for the StarVoice Android runner (Windows).
rem Moves to the runner directory and runs the one-click `up` command.
setlocal
cd /d "%~dp0.." || (echo Runner directory not found & exit /b 1)

set "STATE_DIR=%LOCALAPPDATA%\StarVoice Android\state"
if exist "%~dp0launcher.json" (
  for /f "usebackq delims=" %%i in (`node -e "try{const c=require(process.argv[1]);if(c&&c.stateDir)process.stdout.write(String(c.stateDir))}catch(e){}" "%~dp0launcher.json"`) do set "STATE_DIR=%%i"
)

echo StarVoice mobile capture - state dir: %STATE_DIR%
echo Keep the phone unlocked and awake with Douyin signed in; first run asks for the activation code (never saved).
node cli.mjs up --state-dir "%STATE_DIR%"
endlocal
