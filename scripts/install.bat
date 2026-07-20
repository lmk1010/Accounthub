@echo off
setlocal EnableExtensions
REM AccountHub one-click installer (Docker Compose) for Windows
REM Research / self-host lab helper only. Read NOTICE.md first.

cd /d "%~dp0\.."

echo.
echo AccountHub installer - important notice
echo ---------------------------------------
echo This software is for learning, research, and authorized self-hosted experiments.
echo You are responsible for complying with provider Terms of Service and law.
echo See NOTICE.md and docs\public\RESEARCH_USE.md
echo.
if /I not "%ACCOUNTHUB_I_UNDERSTAND_RESEARCH_USE%"=="1" (
  set /p ANSWER=Type YES to continue:
  if /I not "%ANSWER%"=="YES" (
    echo Aborted.
    exit /b 1
  )
)

where docker >nul 2>nul
if errorlevel 1 (
  echo ERROR: docker not found in PATH
  exit /b 1
)

docker compose version >nul 2>nul
if errorlevel 1 (
  echo ERROR: Docker Compose v2 required
  exit /b 1
)

if not exist ".env" (
  echo Creating .env ...
  if exist "backend\.env.example" (
    copy /Y "backend\.env.example" ".env" >nul
  ) else (
    (
      echo USE_DATABASE=true
      echo DB_DATABASE=accounthub
      echo DB_USER=accounthub
      echo DB_PASSWORD=change-me
      echo MYSQL_ROOT_PASSWORD=change-me-root
      echo REDIS_KEY_PREFIX=accounthub:
      echo REQUIRED_API_KEY=change-me-admin-or-gateway-key
      echo HOST=0.0.0.0
      echo SERVER_PORT=3000
      echo OAUTH_CALLBACK_HOST=localhost
      echo OAUTH_CALLBACK_SCHEME=http
      echo BACKEND_PORT=13000
      echo FRONTEND_PORT=13001
    ) > ".env"
  )
  echo NOTE: Edit .env and replace default passwords / REQUIRED_API_KEY before production use.
)

echo Building and starting containers...
docker compose up -d --build
if errorlevel 1 exit /b 1

echo.
echo AccountHub is starting.
echo   Admin UI : http://localhost:13001
echo   API      : http://localhost:13000
echo.
echo Next: complete admin setup, configure authorized credentials only,
echo and read docs\public\QUICKSTART.md + docs\public\RESEARCH_USE.md
echo.
endlocal
