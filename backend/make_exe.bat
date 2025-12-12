@echo off
REM Empaquetar Registro VI Backend + frontend en un solo .exe

REM Activar entorno virtual
call .venv\Scripts\activate

set FRONTEND_SRC=..\frontend\dist
set FRONTEND_DST=app\static\vi_frontend

if not exist "%FRONTEND_SRC%" (
  echo No se encontro "%FRONTEND_SRC%". Ejecuta "npm run build" en frontend primero.
  exit /b 1
)

echo Sincronizando build de frontend en "%FRONTEND_DST%"...
robocopy "%FRONTEND_SRC%" "%FRONTEND_DST%" /MIR >nul
if %ERRORLEVEL% GEQ 8 (
  echo Error copiando el build del frontend.
  exit /b %ERRORLEVEL%
)

REM Limpiar build anterior y compilar
echo Generando EXE...
pip install pywin32
pyinstaller ^
  --clean ^
  --noconfirm ^
  --noconsole ^
  --onefile ^
  --name Registro_VI ^
  --icon icon_vi.ico ^
  --hidden-import=pystray ^
  --hidden-import=PIL ^
  --hidden-import=PIL.Image ^
  --hidden-import=uvicorn ^
  --add-data "app\data\PLANTILLA_VI.xlsx;app\data" ^
  --add-data "app\static\vi_frontend;app\static\vi_frontend" ^
  --add-data "icon_vi.ico;." ^
  vi_tray_app.py

echo.
echo Build terminado. El exe se encuentra en: dist\Registro_VI.exe
pause
