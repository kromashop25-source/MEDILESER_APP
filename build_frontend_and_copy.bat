@echo off
setlocal

REM Build frontend (Vite) and copy the dist contents to backend static folder.
REM - Source:      frontend\dist\  (contents only)
REM - Destination: backend\app\static\vi_frontend\

set "ROOT=%~dp0"
cd /d "%ROOT%"

echo [1/2] Generando build del frontend...
pushd "frontend" >nul
call npm run build
if errorlevel 1 (
  echo.
  echo ERROR: Fallo el build del frontend (npm run build).
  popd >nul
  exit /b 1
)
popd >nul

echo [2/2] Copiando frontend\\dist a backend\\app\\static\\vi_frontend...
set "SRC=%ROOT%frontend\dist"
set "DST=%ROOT%backend\app\static\vi_frontend"

if not exist "%SRC%" (
  echo.
  echo ERROR: No existe la carpeta de salida: "%SRC%"
  exit /b 1
)

if not exist "%DST%" (
  mkdir "%DST%" >nul 2>&1
)

REM /MIR deja el destino igual al dist (incluye eliminar archivos viejos).
robocopy "%SRC%" "%DST%" /MIR /NFL /NDL /NJH /NJS /NP >nul
set "RC=%ERRORLEVEL%"
if %RC% GEQ 8 (
  echo.
  echo ERROR: Fallo la copia (robocopy). Codigo: %RC%
  exit /b %RC%
)

echo Listo.
exit /b 0

