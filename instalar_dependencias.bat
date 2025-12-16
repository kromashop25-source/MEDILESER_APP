@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0"
cd /d "%ROOT%" || goto :fatal

echo [1/2] Instalando dependencias del backend (Python)...

set "VENV_DIR=%ROOT%.venv"
set "VENV_PY=%VENV_DIR%\Scripts\python.exe"

if not exist "%VENV_PY%" (
  echo - Creando entorno virtual en "%VENV_DIR%"...
  call :find_python || goto :python_missing
  call !PY_CMD! -m venv "%VENV_DIR%" || goto :fatal
)

call "%VENV_PY%" -m pip install -U pip setuptools wheel || goto :fatal
call "%VENV_PY%" -m pip install -r "%ROOT%requirements.txt" || goto :fatal

echo(
echo [2/2] Instalando dependencias del frontend (Node/npm)...

where npm >nul 2>nul
if errorlevel 1 goto :npm_missing

pushd "%ROOT%frontend" || goto :fatal
if exist package-lock.json (
  call npm ci
) else (
  call npm install
)
if errorlevel 1 goto :fatal
popd >nul 2>&1

echo(
echo Listo. Dependencias instaladas.
echo - Backend: .venv\ (pip + requirements.txt)
echo - Frontend: frontend\node_modules\ (npm)
echo(
echo Siguiente (opcional):
echo - Backend:  "%VENV_PY%" -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
echo   (o ejecuta: run_backend.bat)
echo   Nota: si usas "python -m uvicorn ..." sin activar .venv, usaras tu Python global y faltaran modulos.
echo - Frontend: cd frontend ^&^& npm run dev
exit /b 0

:find_python
set "PY_CMD="
where python >nul 2>nul
if not errorlevel 1 (
  set "PY_CMD=python"
  exit /b 0
)
where py >nul 2>nul
if not errorlevel 1 (
  set "PY_CMD=py"
  exit /b 0
)
exit /b 1

:python_missing
echo(
echo ERROR: No se encontro Python en PATH.
echo - Instala Python 3.11+ y vuelve a ejecutar este script.
exit /b 1

:npm_missing
echo(
echo ERROR: No se encontro npm en PATH.
echo - Instala Node.js 20+ (incluye npm) y vuelve a ejecutar este script.
exit /b 1

:fatal
echo(
echo ERROR: Fallo la instalacion de dependencias.
exit /b 1
