# file: app/main.py
import logging
import os
import pkgutil
import sys
import tempfile
import uuid
import zipfile
from pathlib import Path
from typing import Optional
import threading, time, os
from fastapi import Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path
import sys

from fastapi import FastAPI, File, HTTPException, UploadFile, Query
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse
from openpyxl.utils.exceptions import InvalidFileException

from .merge import build_and_write, MergeFileReadError, MergeUserError
from .templates_inline import INDEX_HTML

logger = logging.getLogger(__name__)

DEFAULT_MAX_FILE_MB = 25
DEFAULT_MAX_TECH_FILES = 50
CHUNK_SIZE_BYTES = 2 * 1024 * 1024

app = FastAPI()

# 1) Debe ir PRIMERO
def _package_root() -> Path:
    base = Path(__file__).resolve().parent
    if getattr(sys, "frozen", False):
        bundle = Path(getattr(sys, "_MEIPASS", base))
        candidate = bundle / "app"
        if candidate.exists():
            return candidate
        return bundle
    return base

# 2) Luego _static_dir usa _package_root
def _static_dir() -> Path:
    return _package_root() / "static"

# 3) Y reciÃ©n aquÃ­ montas /static y sirves el favicon
app.mount("/static", StaticFiles(directory=_static_dir()), name="static")

@app.get("/favicon.ico")
def favicon():
    return FileResponse(_static_dir() / "favicon.ico")


def _runtime_root() -> Path:
    env_root = os.environ.get("OI_RUNTIME_DIR")
    if env_root:
        return Path(env_root)
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


UPLOADS = _runtime_root() / "uploads"
UPLOADS.mkdir(parents=True, exist_ok=True)

TEMPLATES = _package_root() / "templates"
if not TEMPLATES.exists():
    alt_templates = _runtime_root() / "templates"
    if alt_templates.exists():
        TEMPLATES = alt_templates


def _load_template(name: str) -> Optional[str]:
    """Lee un template, incluso cuando estamos empaquetados con PyInstaller."""
    if name == "index.html":
        return INDEX_HTML

    path = TEMPLATES / name
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        pass

    try:
        data = pkgutil.get_data("app", f"templates/{name}")
    except Exception:
        data = None

    if data is not None:
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError:
            return data.decode("utf-8", errors="replace")
    return None




def _int_from_env(var_name: str, default: int) -> int:
    raw = os.environ.get(var_name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        logger.warning("Valor invalido en %s=%r, usando %s", var_name, raw, default)
        return default
    if value <= 0:
        logger.warning("Valor invalido en %s=%r, usando %s", var_name, raw, default)
        return default
    return value


def _upload_limits() -> tuple[int, int]:
    max_file_mb = _int_from_env("OI_MAX_FILE_MB", DEFAULT_MAX_FILE_MB)
    max_tech_files = _int_from_env("OI_MAX_TECH_FILES", DEFAULT_MAX_TECH_FILES)
    return max_file_mb, max_tech_files


class FileTooLargeError(Exception):
    def __init__(self, filename: str, limit_mb: int) -> None:
        self.filename = filename
        self.limit_mb = limit_mb
        super().__init__(f"Archivo {filename} supera {limit_mb}MB")


def _validate_extension(upload: UploadFile) -> str:
    filename = upload.filename or "archivo"
    if Path(filename).suffix.lower() != ".xlsx":
        raise HTTPException(status_code=422, detail=f"Archivo {filename} no es .xlsx")
    return filename


def _allocate_temp_path(prefix: str, original_name: str) -> Path:
    suffix = Path(original_name).suffix or ".xlsx"
    handle = tempfile.NamedTemporaryFile(prefix=f"{prefix}_", suffix=suffix, dir=UPLOADS, delete=False)
    path = Path(handle.name)
    handle.close()
    return path


def _sanitize_download_filename(original: Optional[str]) -> str:
    if not original:
        return "maestro.xlsx"
    name = Path(original).name.strip()
    if not name:
        return "maestro.xlsx"
    stem = Path(name).stem or "maestro"
    if Path(name).suffix.lower() != ".xlsx":
        name = stem + ".xlsx"
    sanitized = name.replace("\n", " ").replace("\r", " ").replace("\"", "_").strip()
    return sanitized or "maestro.xlsx"



def _bytes_to_megabytes(size_bytes: int) -> float:
    return size_bytes / (1024 * 1024)


def _log_saved_file(role: str, filename: str, size_bytes: int, path: Path) -> None:
    logger.info(
        "%s guardado: %s -> %s (%.2f MB)",
        role,
        filename,
        path.name,
        _bytes_to_megabytes(size_bytes),
    )


async def _stream_upload_to_disk(upload: UploadFile, prefix: str, max_file_mb: int) -> tuple[Path, int]:
    filename = _validate_extension(upload)
    limit_bytes = max_file_mb * 1024 * 1024
    destination = _allocate_temp_path(prefix, filename)
    total = 0
    try:
        with destination.open("wb") as target:
            while True:
                chunk = await upload.read(CHUNK_SIZE_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > limit_bytes:
                    raise FileTooLargeError(filename, max_file_mb)
                target.write(chunk)
    except Exception:
        if destination.exists():
            try:
                destination.unlink()
            except OSError:
                logger.warning("No se pudo eliminar temporal %s tras error", destination)
        raise
    finally:
        await upload.seek(0)
    _log_saved_file(prefix, filename, total, destination)
    return destination, total

@app.get('/config/upload-limits')
async def get_upload_limits():
    max_file_mb, max_tech_files = _upload_limits()
    return {'max_file_mb': max_file_mb, 'max_tech_files': max_tech_files}


@app.get("/", response_class=HTMLResponse)
async def root():
    """Sirve el formulario HTML al acceder a la raiz '/'."""
    html = _load_template("dashboard.html")
    if html is None:
        return PlainTextResponse("No se encontro menu.html en la carpeta templates", status_code=404)
    return html

@app.get("/ui/correlativo", response_class=HTMLResponse)
async def ui_correlativo():
    html = _load_template("index_correlativo.html")
    if html is None:
        return PlainTextResponse("Falta index_correlativo.html en templates", status_code=404)
    return html

@app.get("/ui/no-correlativo", response_class=HTMLResponse)
async def ui_no_correlativo():
    html = _load_template("index_no_correlativo.html")
    if html is None:
        return PlainTextResponse("Falta index_no_correlativo.html en templates", status_code=404)
    return html


@app.post("/merge")
async def merge(
    master: UploadFile = File(...),
    technicians: list[UploadFile] = File(...),
    mode: str = Query("correlativo")  # 'correlativo' | 'no-correlativo'
):
    max_file_mb, max_tech_files = _upload_limits()

    if len(technicians) > max_tech_files:
        raise HTTPException(status_code=413, detail=f"Demasiados tecnicos, max {max_tech_files}")
    if not technicians:
        raise HTTPException(status_code=400, detail="No se subio ningun archivo de tecnico.")

    logger.info(
        "Iniciando merge: tecnicos=%d, limite archivo=%dMB, mode=%s",
        len(technicians), max_file_mb, mode
    )

    download_name = _sanitize_download_filename(master.filename)
    master_path: Path
    technician_paths: list[Path] = []
    try:
        try:
            master_path, _ = await _stream_upload_to_disk(master, "master", max_file_mb)
        except FileTooLargeError as exc:
            raise HTTPException(status_code=413, detail=f"Archivo {exc.filename} supera {exc.limit_mb}MB") from exc

        for index, upload in enumerate(technicians, start=1):
            try:
                t_path, _ = await _stream_upload_to_disk(upload, f"tecnico_{index}", max_file_mb)
            except FileTooLargeError as exc:
                raise HTTPException(status_code=413, detail=f"Archivo {exc.filename} supera {exc.limit_mb}MB") from exc
            technician_paths.append(t_path)

        try:
            # Decide si ordenar por G (correlativo) o respetar el orden original (no-correlativo)
            order_by_g = (mode.lower() == "correlativo")
            output_path = build_and_write(
                master_path,
                technician_paths,
                order_by_col_g=order_by_g
            )
        except MergeFileReadError as exc:
            cause = exc.cause
            if isinstance(cause, (InvalidFileException, zipfile.BadZipFile)):
                raise HTTPException(status_code=422, detail=f"Archivo {exc.path.name} corrupto o no valido") from exc
            trace_id = uuid.uuid4().hex[:8]
            logger.exception("Error leyendo %s (trace_id=%s)", exc.path, trace_id)
            raise HTTPException(status_code=500, detail=f"Error interno. Trace ID: {trace_id}") from exc
        except MergeUserError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:
            trace_id = uuid.uuid4().hex[:8]
            logger.exception("Error inesperado en consolidacion (trace_id=%s)", trace_id)
            raise HTTPException(status_code=500, detail=f"Error interno. Trace ID: {trace_id}") from exc

        logger.info("Consolidado generado: %s", output_path.name)
        return FileResponse(
            path=output_path,
            filename=download_name,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
    finally:
        await master.close()
        for upload in technicians:
            await upload.close()

@app.post("/shutdown")
def shutdown(request: Request):
    """
    Cierra el servidor de forma controlada.
    - Si se ejecuta como .exe con run_server.py: usa server.should_exit = True
    - En cualquier caso: tiene un fallback forzado.
    """
    # OpciÃ³n preferida: avisar al server de uvicorn
    server = getattr(request.app.state, "server", None)
    if server is not None:
        def _graceful():
            # pequeÃ±a espera para devolver respuesta al cliente
            time.sleep(0.3)
            server.should_exit = True
        threading.Thread(target=_graceful, daemon=True).start()
        return JSONResponse({"ok": True, "message": "Cerrando la aplicaciÃ³n..."})

    # Fallback (forzado) si no hay server en app.state
    def _forced():
        time.sleep(0.3)
        os._exit(0)
    threading.Thread(target=_forced, daemon=True).start()
    return JSONResponse({"ok": True, "message": "Cierre forzado..."})
