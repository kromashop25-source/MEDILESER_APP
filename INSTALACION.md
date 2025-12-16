# Instalación de dependencias (backend + frontend)

## Requisitos

- **Backend:** Python 3.11+ y `pip`
- **Frontend:** Node.js 20+ (incluye `npm`)

## Opción rápida (Windows)

En la raíz del proyecto, ejecuta:

- `instalar_dependencias.bat`
- `run_backend.bat` (levanta FastAPI con la `.venv`)

## Instalación manual

### 1) Backend (Python)

Desde la raíz del proyecto:

1. Crear entorno virtual:
   - `py -m venv .venv` (o `python -m venv .venv`)
2. Activar el entorno virtual:
   - **CMD:** `.\.venv\Scripts\activate.bat`
   - **PowerShell:** `.\.venv\Scripts\Activate.ps1`
     - Si PowerShell bloquea scripts: `Set-ExecutionPolicy -Scope Process Bypass`
3. Instalar dependencias:
   - `python -m pip install -U pip setuptools wheel`
   - `python -m pip install -r requirements.txt`

> Nota: también existe `backend/requirements.txt` (útil para empaquetado/EXE), pero para desarrollo normal usa `requirements.txt` en la raíz.

### 2) Frontend (Node)

Desde la raíz del proyecto:

1. `cd frontend`
2. Instalar dependencias:
   - `npm ci` (recomendado si existe `package-lock.json`)
   - o `npm install`

## (Opcional) Comandos típicos de desarrollo

- Backend (desde raíz, con `.venv` activo): `python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000`
- Backend (sin activar venv): `.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000` (o `run_backend.bat`)
- Frontend: `cd frontend` y luego `npm run dev`
- Build del frontend y copia al backend: `build_frontend_and_copy.bat`
