import sys  # <--- IMPORTANTE
import logging
from pathlib import Path
import time
import uuid

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from app.core.settings import get_settings
from app.api import admin, catalogs, auth, oi
from app.core.db import init_db
from app.core.logging_config import configure_logging
from app.oi_tools.routers import integrations as oi_integrations
from app.oi_tools.routers import updates as oi_updates
from app.oi_tools.routers import oi_merge as oi_merge
from app.oi_tools.routers import excel as oi_excel
from app.oi_tools.routers import files as oi_files
from app.logistica.routers import log01 as log01_router

configure_logging()

app = FastAPI(title="VI Backend")
settings = get_settings()
logger = logging.getLogger(__name__)

# Pequeño hardening: avisar si CORS está en modo abierto
if "*" in settings.cors_origins:
    logger.warning(
        "CORS configurado con '*' en cors_origins; " 
        "esto solo se recomienda en entornos de desarrollo aislados."
        )

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True}


app.include_router(catalogs.router, prefix="/catalogs", tags=["catalogs"])
app.include_router(auth.router, prefix="/auth", tags=["auth"])
app.include_router(oi.router, prefix="/oi", tags=["oi"])
app.include_router(admin.router, prefix="/admin", tags=["admin"])

# --- OI TOOLS (integración OI_PROJECT) ---
# Nota: algunos routers ya traen prefix interno (integrations, bases/actualizar, merge).
app.include_router(oi_integrations.router)
app.include_router(oi_updates.router)
app.include_router(oi_merge.router)
app.include_router(oi_excel.router, prefix="/tools/excel", tags=["excel-tools"])
app.include_router(oi_files.router, prefix="/tools/files", tags=["files"])

app.include_router(log01_router.router)


@app.on_event("startup")
def _startup() -> None:
    init_db()


# --- FRONTEND BUILD (Vite) + SOPORTE EXE ---

def get_frontend_root() -> Path:
    """Busca la carpeta del frontend compatible con PyInstaller y Dev"""
    # 1. Intentamos leer la variable mágica de forma segura
    meipass_path = getattr(sys, "_MEIPASS", None)

    if meipass_path:
        # MODO EXE: Usamos la ruta temporal
        base = Path(meipass_path) / "app" / "static" / "vi_frontend"
    else:
        # MODO DEV: Usamos la ruta de tu disco duro
        base = Path(__file__).resolve().parent / "static" / "vi_frontend"
    
    # Priorizar carpeta 'cls' si existe
    if (base / "cls").exists():
        return base / "cls"
    
    return base


frontend_root = get_frontend_root()

# Montaje de archivos estáticos
if frontend_root.exists():
    app.mount(
        "/",
        StaticFiles(directory=str(frontend_root), html=True),
        name="frontend",
    )
    logger.info("Serving frontend from %s", frontend_root)
else:
    logger.warning("Frontend path not found: %s", frontend_root)


# 🔹 NUEVO: middleware de logging y manejo de errores
@app.middleware("http")
async def logging_and_error_middleware(request: Request, call_next):
    """
    - Loguea cada petición HTTP con método, path, status y tiempo.
    - Captura errores HTTP controlados (HTTPException).
    - Captura errores inesperados y devuelve 500 estándar.
    """
    request_id = str(uuid.uuid4())
    start_time = time.perf_counter()

    try:
        response = await call_next(request)
    except HTTPException as exc:
        process_ms = (time.perf_counter() - start_time) * 1000
        logger.warning(
            "HTTPException",
            extra={
                "request_id": request_id,
                "method": request.method,
                "path": request.url.path,
                "status_code": exc.status_code,
                "detail": str(exc.detail),
                "process_ms": round(process_ms, 2),
            },
        )
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail},
        )
    except Exception as exc:  # noqa: BLE001
        process_ms = (time.perf_counter() - start_time) * 1000
        logger.exception(
            "Unhandled error",
            extra={
                "request_id": request_id,
                "method": request.method,
                "path": request.url.path,
                "process_ms": round(process_ms, 2),
            },
        )
        return JSONResponse(
            status_code=500,
            content={"detail": "Error interno en el servidor. Intente nuevamente."},
        )

    process_ms = (time.perf_counter() - start_time) * 1000
    logger.info(
        "HTTP request completed",
        extra={
            "request_id": request_id,
            "method": request.method,
            "path": request.url.path,
            "status_code": response.status_code,
            "process_ms": round(process_ms, 2),
        },
    )

    response.headers["X-Request-ID"] = request_id
    return response


# 🔹 Tu middleware SPA se mantiene igual, solo queda debajo
@app.middleware("http")
async def spa_for_react_routes(request: Request, call_next):
    """
    Ensure browser navigation to SPA routes returns index.html.
    """
    accept = request.headers.get("accept", "")
    path = request.url.path.rstrip("/")

    if (
        path.startswith("/logistica/log01/progress")
        or path.startswith("/logistica/log01/poll")
        or path.startswith("/logistica/log01/start")
        or path.startswith("/logistica/log01/upload")
        or path.startswith("/logistica/log01/result")
        or path.startswith("/logistica/log01/cancel")
    ):
        return await call_next(request)
    
    # Agregué "/login" y "/" por seguridad para la navegación directa
    spa_paths = {"/home", "/oi", "/oi/list", "/login", "/password", "/users", "/admin/permisos"}

    if (
        request.method == "GET"
        and "text/html" in accept
        and (path in spa_paths or path.startswith("/oi") or path.startswith("/admin") or path.startswith("/logistica"))

    ):
        index_file = frontend_root / "index.html"
        if index_file.exists():
            return FileResponse(index_file)

    return await call_next(request)
