@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
cd /d "%ROOT%" || goto :fatal

echo [1/2] Generando build del frontend...
pushd "%ROOT%frontend" || goto :fatal

call npm run build
if errorlevel 1 goto :build_fail

popd >nul 2>&1

echo [2/2] Copiando frontend\dist a backend\app\static\vi_frontend...
set "SRC=%ROOT%frontend\dist"
set "DST=%ROOT%backend\app\static\vi_frontend"

if not exist "%SRC%" goto :no_dist

if not exist "%DST%" (
  mkdir "%DST%" >nul 2>&1
)

robocopy "%SRC%" "%DST%" /MIR /NFL /NDL /NJH /NJS /NP >nul
set "RC=%ERRORLEVEL%"
if %RC% GEQ 8 goto :copy_fail

echo Listo.
exit /b 0

:build_fail
echo(
echo ERROR: Fallo el build del frontend (npm run build).
popd >nul 2>&1
exit /b 1

:no_dist
echo(
echo ERROR: No existe la carpeta de salida: "%SRC%"
exit /b 1

:copy_fail
echo(
echo ERROR: Fallo la copia (robocopy). Codigo: %RC%
exit /b %RC%

:fatal
echo(
echo ERROR: No se pudo ubicar la ruta del proyecto o la carpeta "frontend".
exit /b 1
