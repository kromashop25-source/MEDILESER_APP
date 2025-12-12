"""
Package shim to allow running the FastAPI backend from the repo root.

The backend package lives at `backend/app`. When starting Uvicorn from the repo
root (e.g. `python -m uvicorn app.main:app`), Python would otherwise be unable
to resolve `app.*` imports.
"""

from pathlib import Path

_BACKEND_APP_DIR = Path(__file__).resolve().parents[1] / "backend" / "app"
if _BACKEND_APP_DIR.is_dir():
    backend_app_dir_str = str(_BACKEND_APP_DIR)
    if backend_app_dir_str not in __path__:
        __path__.append(backend_app_dir_str)
