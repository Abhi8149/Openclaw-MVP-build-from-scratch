
@echo off

set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
set "PROFILE=%LOCALAPPDATA%\OpenClaw\AgentChrome"

if not exist "%CHROME%" (
  set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
)

if not exist "%CHROME%" (
  echo Chrome was not found.
  exit /b 1
)

start "" "%CHROME%" ^
  --remote-debugging-port=9223 ^
  --user-data-dir="%PROFILE%" ^
  --no-first-run ^
  about:blank
