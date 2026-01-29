@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem === Repo root ===
set "REPO=\\192.168.2.237\data\MEDILESER_APP"

rem === Puerto (por defecto 8010, puedes pasarlo como argumento) ===
set "PORT=%~1"
if "%PORT%"=="" set "PORT=8010"

rem === Logs (separado por carpeta y por puerto) ===
set "LOGDIR=C:\MedileserApp_run\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

rem Fecha/hora robusta (YYYYMMDD_HHMMSS)
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value 2^>nul') do set "LDT=%%I"
set "LOGDATE=%LDT:~0,8%_%LDT:~8,6%"

rem Importante: incluir el puerto en el nombre para evitar colisión si arrancan al mismo segundo
set "LOG=%LOGDIR%\uvicorn_%PORT%_%LOGDATE%.log"

echo [RUN] Iniciando MEDILESER_APP desde: "%REPO%" >> "%LOG%" 2>&1
echo [RUN] Puerto: %PORT% >> "%LOG%" 2>&1

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

".venv\Scripts\python.exe" -m uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port %PORT% >> "%LOG%" 2>&1

echo [RUN] Uvicorn detenido. >> "%LOG%" 2>&1
popd
endlocal
