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
from app.oi_tools.routers import formato_ac_history as formato_ac_history_router
from app.logistica.routers import log01 as log01_router
from app.logistica.routers import log02 as log02_router


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
app.include_router(formato_ac_history_router.router)

app.include_router(log01_router.router)
app.include_router(log02_router.router)



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


# 🔹 Middleware ASGI (no BaseHTTPMiddleware) para NO afectar StreamingResponse (NDJSON)
#    - Logging por request (al finalizar respuesta)
#    - Manejo de errores: HTTPException -> JSON {detail}, Exception -> 500 estándar
#    - Agrega X-Request-ID en todas las respuestas

from starlette.types import ASGIApp, Scope, Receive, Send  # type: ignore


class LoggingAndErrorASGIMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = str(uuid.uuid4())
        start_time = time.perf_counter()
        status_code: int | None = None

        async def send_wrapper(message):
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = int(message.get("status", 0))
                headers = list(message.get("headers", []))
                headers.append((b"x-request-id", request_id.encode("utf-8")))
                message["headers"] = headers
            await send(message)

            # Log al final de la respuesta (incluye streaming)
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                process_ms = (time.perf_counter() - start_time) * 1000
                logger.info(
                    "HTTP request completed",
                    extra={
                        "request_id": request_id,
                        "method": scope.get("method"),
                        "path": scope.get("path"),
                        "status_code": status_code,
                        "process_ms": round(process_ms, 2),
                    },
                )

        try:
            await self.app(scope, receive, send_wrapper)
        except HTTPException as exc:
            process_ms = (time.perf_counter() - start_time) * 1000
            logger.warning(
                "HTTPException",
                extra={
                    "request_id": request_id,
                    "method": scope.get("method"),
                    "path": scope.get("path"),
                    "status_code": exc.status_code,
                    "detail": str(exc.detail),
                    "process_ms": round(process_ms, 2),
                },
            )
            response = JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
            response.headers["X-Request-ID"] = request_id
            await response(scope, receive, send)
        except Exception:  # noqa: BLE001
            process_ms = (time.perf_counter() - start_time) * 1000
            logger.exception(
                "Unhandled error",
                extra={
                    "request_id": request_id,
                    "method": scope.get("method"),
                    "path": scope.get("path"),
                    "process_ms": round(process_ms, 2),
                },
            )
            response = JSONResponse(
                status_code=500,
                content={"detail": "Error interno en el servidor. Intente nuevamente."},
            )
            response.headers["X-Request-ID"] = request_id
            await response(scope, receive, send)


class SpaForReactRoutesASGIMiddleware:
    def __init__(self, app: ASGIApp, frontend_root: Path) -> None:
        self.app = app
        self.frontend_root = frontend_root

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method = scope.get("method", "GET")
        path = (scope.get("path") or "").rstrip("/")

        # Headers (lowercase) -> string
        headers = {}
        for k, v in (scope.get("headers") or []):
            try:
                headers[k.decode("latin-1").lower()] = v.decode("latin-1")
            except Exception:
                continue
        accept = headers.get("accept", "")

        # Excepciones específicas LOG-01 (no interferir con endpoints)
        if path.startswith("/logistica/log01/history"):
            if method != "GET" or "text/html" not in accept or path != "/logistica/log01/history":
                await self.app(scope, receive, send)
                return

        if (
            path.startswith("/logistica/log01/progress")
            or path.startswith("/logistica/log01/poll")
            or path.startswith("/logistica/log01/start")
            or path.startswith("/logistica/log01/upload")
            or path.startswith("/logistica/log01/result")
            or path.startswith("/logistica/log01/cancel")
        ):
            await self.app(scope, receive, send)
            return

        # Navegación SPA (incluye logistica)
        spa_paths = {"/home", "/oi", "/oi/list", "/login", "/password", "/users", "/admin/permisos"}

        if (
            method == "GET"
            and "text/html" in accept
            and (path in spa_paths or path.startswith("/oi") or path.startswith("/admin") or path.startswith("/logistica"))
        ):
            index_file = self.frontend_root / "index.html"
            if index_file.exists():
                return await FileResponse(index_file)(scope, receive, send)

        await self.app(scope, receive, send)


# Orden:
# - SPA debe ir "adentro" (para decidir rutas HTML)
# - Logging/Error debe ir "afuera" (para loguear también respuestas SPA)
app.add_middleware(SpaForReactRoutesASGIMiddleware, frontend_root=frontend_root)
app.add_middleware(LoggingAndErrorASGIMiddleware)
