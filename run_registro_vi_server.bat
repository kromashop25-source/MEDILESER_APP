@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem === Repo root (nuevo) ===
set "REPO=\\192.168.1.237\data\MEDILESER_APP"

rem === Logs ===
set "LOGDIR=C:\Run_RegistroVI\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

rem Fecha/hora robusta (YYYYMMDD_HHMMSS)
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value 2^>nul') do set "LDT=%%I"
set "LOGDATE=%LDT:~0,8%_%LDT:~8,6%"
set "LOG=%LOGDIR%\uvicorn_%LOGDATE%.log"

echo [RUN] Iniciando MEDILESER_APP desde: "%REPO%" >> "%LOG%" 2>&1

pushd "%REPO%" || (
  echo [RUN] ERROR: No se pudo cambiar a "%REPO%" >> "%LOG%" 2>&1
  exit /b 1
)

echo [RUN] Directorio actual: "%CD%" >> "%LOG%" 2>&1

rem Validar venv en la RAIZ del repo
if not exist ".venv\Scripts\python.exe" (
  echo [RUN] ERROR: No existe ".venv\Scripts\python.exe" en "%CD%" >> "%LOG%" 2>&1
  echo [RUN] Ejecuta primero: backend\setup_registro_vi.bat >> "%LOG%" 2>&1
  popd
  exit /b 1
)

rem Arranque Uvicorn: --app-dir backend para imports correctos,
rem y .env en la raíz (opción B) se mantiene consistente.
".venv\Scripts\python.exe" -m uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port 8000 >> "%LOG%" 2>&1

echo [RUN] Uvicorn detenido. >> "%LOG%" 2>&1
popd
endlocal
