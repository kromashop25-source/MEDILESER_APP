@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
cd /d "%ROOT%" || goto :fatal

set "ACTIVATE_BAT=%ROOT%.venv\Scripts\activate.bat"
if not exist "%ACTIVATE_BAT%" goto :no_venv

call "%ACTIVATE_BAT%"
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
exit /b %errorlevel%

:no_venv
echo(
echo ERROR: No existe "%ACTIVATE_BAT%".
echo Ejecuta primero: instalar_dependencias.bat
exit /b 1

:fatal
echo(
echo ERROR: No se pudo ubicar la ruta del proyecto.
exit /b 1
