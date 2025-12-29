from __future__ import annotations

import asyncio
import logging
import os
import queue
import re
import shutil
import tempfile
import threading
import time
import unicodedata
import uuid
from copy import copy
from dataclasses import dataclass
from datetime import date, datetime
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, cast

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from openpyxl import load_workbook
from openpyxl.cell.cell import Cell
from openpyxl.styles import Alignment, Font
from openpyxl.worksheet.worksheet import Worksheet

from app.api.auth import get_current_user_session
from app.core.settings import get_settings
from app.oi_tools.services.progress_manager import progress_manager, _SENTINEL as SENTINEL # mismo sentinel
from app.oi_tools.services.cancel_manager import cancel_manager

router = APIRouter(
    prefix="/logistica/log01",
    tags=["logistica/log01"],
    dependencies=[Depends(get_current_user_session)],
)

logger = logging.getLogger(__name__)

class Log01Cancelled(Exception):
    pass


@dataclass
class Log01InputFile:
    name: str
    data: Optional[bytes] = None
    path: Optional[str] = None


@dataclass
class Log01Job:
    operation_id: str
    created_at: float
    status: str
    work_dir: str
    output_name: Optional[str] = None
    result_path: Optional[str] = None
    error: Optional[str] = None


LOG01_JOBS: Dict[str, Log01Job] = {}
LOG01_JOBS_LOCK = threading.Lock()
LOG01_TTL_SECONDS = 60 * 30

# ----------------------------
# Utilitarios
# ----------------------------

_OI_RE = re.compile(r"OI-(\d{4})-(\d{4})", re.IGNORECASE)

def _parse_oi_number_from_filename(filename: str) -> int:
    m = _OI_RE.search(filename or "")
    if not m:
        raise ValueError(f"Nombre inválido: no se encontró patrón OI-####-YYYY en '{filename}'")
    return int(m.group(1))

def _norm_str(v: Any) -> str:
    return str(v).strip() if v is not None else ""

def _norm_header(v: Any) -> str:
    s = _norm_str(v).lower()
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    return s

def _natural_key(s: str):
    # Natural sort: divide digitos y texto
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r'(\d+)', s)]

def _find_header_row(ws) -> Optional[int]:
    """
    Busca en filas 1..20:
        C{r} == 'Serie del medidor'
        M{r} == 'Estado'
    Retorna r si encuentra.
    """
    for r in range(1, 21):
        c = _norm_str(ws.cell(row=r, column=3).value).lower()
        m = _norm_str(ws.cell(row=r, column=13).value).lower()
        if c == "serie del medidor" and m == "estado":
            return r
    return None

@dataclass
class SerieInfo:
    oi_num: int
    estado: str # CONFORME / NO CONFORME
    values: Dict[str, Any]

_OUTPUT_KEYS = [
    "medidor",
    "q3",
    "error_q3",
    "q2",
    "error_q2",
    "q1",
    "error_q1",
    "estado_pe",
    "fecha",
    "certificado",
    "estado",
    "precinto",
    "banco_numero",
    "certificado_banco",
    "organismo",
]

_INPUT_HEADER_ALIASES = {
    "medidor": ["serie del medidor"],
    "q3": ["q3 litros hora"],
    "q2": ["q2 litros hora"],
    "q1": ["q1 litros hora"],
    "estado_pe": ["ensayo de presion estatica"],
    "fecha": ["fecha de ejecucion"],
    "certificado": ["numero de certificado"],
    "precinto": ["numero de serie del precinto de verificacion inicial"],
    "banco_numero": ["numero de banco de ensayo"],
    "certificado_banco": ["numero de certificado del banco de pruebas"],
    "organismo": ["organismo de inspeccion"],
}

def _emit(operation_id: Optional[str], ev: Dict[str, Any]) -> None:
    if not operation_id:
        logger.warning("LOG01 emit skipped: operation_id None")
        return
    progress_manager.emit(operation_id, ev)
    logger.debug(
        "LOG01 emit operation_id=%s ts=%s type=%s stage=%s",
        operation_id,
        time.time(),
        ev.get("type"),
        ev.get("stage"),
    )


def _copy_cell_style(src, dst) -> None:
    dst.font = copy(src.font)
    dst.fill = copy(src.fill)
    dst.border = copy(src.border)
    dst.alignment = copy(src.alignment)
    dst.number_format = src.number_format
    dst.protection = copy(src.protection)


def _apply_output_format(cell) -> None:
    cell.alignment = Alignment(horizontal="center", vertical="center")
    font = cell.font
    cell.font = Font(
        name="Arial",
        size=8,
        b=font.b,
        i=font.i,
        strike=font.strike,
        outline=font.outline,
        shadow=font.shadow,
        condense=font.condense,
        extend=font.extend,
        color=font.color,
        vertAlign=font.vertAlign,
        u=font.u,
        charset=font.charset,
        family=font.family,
        scheme=font.scheme,
    )


def _normalize_output_date(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return value
        try:
            return datetime.fromisoformat(s).date()
        except ValueError:
            pass
        for fmt in (
            "%d/%m/%Y",
            "%d/%m/%Y %H:%M:%S",
            "%d/%m/%Y %H:%M",
            "%Y-%m-%d",
            "%Y-%m-%d %H:%M:%S",
            "%Y-%m-%d %H:%M",
        ):
            try:
                return datetime.strptime(s, fmt).date()
            except ValueError:
                continue
    return value


def _cleanup_log01_job_files(job: Log01Job) -> None:
    if job.work_dir and os.path.isdir(job.work_dir):
        shutil.rmtree(job.work_dir, ignore_errors=True)


def _cleanup_log01_jobs() -> None:
    now = time.time()
    stale: List[Log01Job] = []
    with LOG01_JOBS_LOCK:
        for operation_id, job in list(LOG01_JOBS.items()):
            if job.status == "running":
                continue
            if now - job.created_at < LOG01_TTL_SECONDS:
                continue
            stale.append(job)
            LOG01_JOBS.pop(operation_id, None)
    for job in stale:
        _cleanup_log01_job_files(job)


def _read_input_bytes(item: Log01InputFile) -> bytes:
    if item.data is not None:
        return item.data
    if item.path:
        with open(item.path, "rb") as fh:
            return fh.read()
    return b""


def _persist_upload_files(files: List[UploadFile], work_dir: str) -> List[Log01InputFile]:
    items: List[Log01InputFile] = []
    for idx, up in enumerate(files, start=1):
        name = up.filename or f"archivo_{idx}.xlsx"
        safe_name = Path(name).name
        dest_path = os.path.join(work_dir, f"{idx}_{safe_name}")
        with open(dest_path, "wb") as out_f:
            shutil.copyfileobj(up.file, out_f)
        up.file.close()
        items.append(Log01InputFile(name=name, path=dest_path))
    return items


def _process_log01_files(
    file_items: List[Log01InputFile],
    operation_id: Optional[str],
    output_filename: Optional[str],
    cancel_token: Optional["CancelToken"],
) -> Tuple[bytes, str, Dict[str, Any]]:
    cancel_emitted = False

    def _raise_cancelled() -> None:
        nonlocal cancel_emitted
        if cancel_token and cancel_token.is_cancelled():
            if not cancel_emitted:
                _emit(
                    operation_id,
                    {"type": "status", "stage": "cancelled", "message": "Cancelado por el usuario"},
                )
                cancel_emitted = True
            raise Log01Cancelled()

    _emit(operation_id, {"type": "status", "stage": "received", "message": "Archivos recibidos", "progress": 0})

    # 1) Consolidar serie -> (oi mayor, estado final)
    series: Dict[str, SerieInfo] = {}
    total_files = len(file_items)
    ok_files = 0
    bad_files = 0

    for idx, item in enumerate(file_items, start=1):
        _raise_cancelled()

        fname = item.name or f"archivo_{idx}.xlsx"
        _emit(
            operation_id,
            {
                "type": "status",
                "stage": "file_start",
                "message": f"Procesando: {fname}",
                "progress": int((idx - 1) * 100 / max(total_files, 1)),
            },
        )

        try:
            oi_num = _parse_oi_number_from_filename(fname)
            data = _read_input_bytes(item)
            if not data:
                raise ValueError("Archivo vacío.")

            wb = load_workbook(BytesIO(data), data_only=True)
            ws: Worksheet = wb.worksheets[0]

            header_row = _find_header_row(ws)
            if header_row is None:
                # fallback a la norma: cabecera en fila 8, data desde fila 9
                header_row = 8

            input_header_map = {}
            for c in range(1, ws.max_column + 1):
                name = _norm_header(ws.cell(row=header_row, column=c).value)
                if name and name not in input_header_map:
                    input_header_map[name] = c

            def find_input_col(key: str) -> Optional[int]:
                for alias in _INPUT_HEADER_ALIASES.get(key, []):
                    col = input_header_map.get(_norm_header(alias))
                    if col:
                        return col
                return input_header_map.get(_norm_header(key))

            input_cols = {key: find_input_col(key) for key in _OUTPUT_KEYS}
            col_serie = input_cols.get("medidor") or 3
            col_estado = input_cols.get("estado") or 13

            data_start = header_row + 1  # si hay fila en blanco, se ignora porque serie estará vacía

            extracted = 0
            for r in range(data_start, ws.max_row + 1):
                if r % 200 == 0:
                    _raise_cancelled()
                serie = _norm_str(ws.cell(row=r, column=col_serie).value)
                if not serie:
                    continue
                estado = _norm_str(ws.cell(row=r, column=col_estado).value).upper()
                if estado not in ("CONFORME", "NO CONFORME"):
                    # si viene basura o vacio, lo ignoramos
                    continue

                row_values: Dict[str, Any] = {"medidor": serie, "estado": estado}
                for key in _OUTPUT_KEYS:
                    if key in ("medidor", "estado"):
                        continue
                    col = input_cols.get(key)
                    row_values[key] = ws.cell(row=r, column=col).value if col else None

                extracted += 1
                prev = series.get(serie)
                if prev is None or oi_num > prev.oi_num:
                    series[serie] = SerieInfo(oi_num=oi_num, estado=estado, values=row_values)

            ok_files += 1
            _emit(
                operation_id,
                {
                    "type": "status",
                    "stage": "file_ok",
                    "message": f"OK: {fname} (registros leídos: {extracted})",
                    "progress": int(idx * 100 / max(total_files, 1)),
                },
            )

        except Exception as e:
            bad_files += 1
            _emit(
                operation_id,
                {
                    "type": "error",
                    "stage": "file_error",
                    "message": f"Error en {fname}",
                    "detail": str(e),
                    "code": "FILE_INVALID",
                },
            )
            # Importante: continuar con el lote
            continue

    # 2) Filtrar solo CONFORME
    conformes = [s for s, info in series.items() if info.estado == "CONFORME"]
    conformes.sort(key=_natural_key)

    # 3) Render a plantilla LOG01 (fila 2+, item desde 1)
    st = get_settings()
    template_path = getattr(st, "log01_template_abs_path", None)
    if not template_path:
        # fallback (por si aún no se agregan property en settings)
        template_path = str((st.data_dir.parent / "app" / "data" / "templates" / "logistica" / "LOG01_PLANTILLA_SALIDA.xlsx").resolve())

    wb_out = load_workbook(template_path)
    ws_out = next(
        (ws for ws in wb_out.worksheets if ws.sheet_state == "visible"),
        None,
    )
    if ws_out is None:
        ws_out = wb_out.active
    ws_out = cast(Worksheet, ws_out)

    # Detect output columns from header row to stay aligned with template changes.
    header_map = {}
    for c in range(1, ws_out.max_column + 1):
        name = _norm_header(ws_out.cell(row=1, column=c).value)
        if name and name not in header_map:
            header_map[name] = c

    col_item = header_map.get(_norm_header("item"), 1)
    output_cols = {}
    for key in _OUTPUT_KEYS:
        col = header_map.get(_norm_header(key))
        if col is not None:
            output_cols[key] = col

    cols_to_clear = []
    for c in [col_item, *output_cols.values()]:
        if c is None or c in cols_to_clear:
            continue
        cols_to_clear.append(c)
    cols_to_fill = cols_to_clear.copy()

    # Limpieza simple: borrar desde fila 2 hacia abajo en columna A..L (mínimo)
    max_clear = max(ws_out.max_row, 2)
    for r in range(2, max_clear + 1):
        for c in cols_to_clear:
            ws_out.cell(row=r, column=c, value=None)

    for i, serie in enumerate(conformes, start=1):
        r = i + 1  # inicia en fila 2
        if r != 2:
            for c in cols_to_fill:
                src = ws_out.cell(row=2, column=c)
                dst = ws_out.cell(row=r, column=c)
                _copy_cell_style(src, dst)

        ws_out.row_dimensions[r].height = 15

        info = series[serie]
        item_cell = cast(Cell, ws_out.cell(row=r, column=col_item, value=i))  # item
        _apply_output_format(item_cell)
        for key, col in output_cols.items():
            value = info.values.get(key)
            if key == "medidor" and not value:
                value = serie
            if value is None:
                continue
            cell = cast(Cell, ws_out.cell(row=r, column=col))
            if key == "fecha":
                value = _normalize_output_date(value)
                cell.number_format = "dd/mm/yyyy"
            cell.value = value
            _apply_output_format(cell)

    bio = BytesIO()
    wb_out.save(bio)
    xlsx_bytes = bio.getvalue()

    # 4) Nombre de salida sugerido/confirmable
    if output_filename and output_filename.strip():
        out_name = output_filename.strip()
    else:
        if conformes:
            out_name = f"BD_{conformes[0]}_AL_{conformes[-1]}.xlsx"
        else:
            out_name = "BD_SIN_CONFORMES.xlsx"

    summary = {
        "files_total": total_files,
        "files_ok": ok_files,
        "files_error": bad_files,
        "series_total_dedup": len(series),
        "series_conformes": len(conformes),
    }

    _emit(
        operation_id,
        {"type": "complete", "message": "Consolidación completada", "percent": 100.0, "result": summary},
    )
    return xlsx_bytes, out_name, summary


def _run_log01_job(
    job: Log01Job,
    file_items: List[Log01InputFile],
    output_filename: Optional[str],
) -> None:
    operation_id = job.operation_id
    cancel_token = cancel_manager.get(operation_id)
    try:
        xlsx_bytes, out_name, _summary = _process_log01_files(
            file_items,
            operation_id,
            output_filename,
            cancel_token,
        )
        result_path = os.path.join(job.work_dir, "result.xlsx")
        with open(result_path, "wb") as out_f:
            out_f.write(xlsx_bytes)
        with LOG01_JOBS_LOCK:
            current = LOG01_JOBS.get(operation_id)
            if current:
                current.status = "complete"
                current.output_name = out_name
                current.result_path = result_path
    except Log01Cancelled:
        with LOG01_JOBS_LOCK:
            current = LOG01_JOBS.get(operation_id)
            if current:
                current.status = "cancelled"
    except Exception as exc:  # noqa: BLE001
        logger.exception("LOG01 job failed operation_id=%s", operation_id)
        _emit(
            operation_id,
            {"type": "error", "stage": "failed", "detail": str(exc), "code": "JOB_FAILED"},
        )
        with LOG01_JOBS_LOCK:
            current = LOG01_JOBS.get(operation_id)
            if current:
                current.status = "error"
                current.error = str(exc)
    finally:
        progress_manager.finish(operation_id)
        cancel_manager.remove(operation_id)

# ----------------------------
# Progreso (NDJSON stream)
# ----------------------------
@router.get("/progress/{operation_id}")
async def log01_progress_stream(operation_id: str):
    logger.debug("LOG01 progress client connected operation_id=%s", operation_id)
    channel, history = progress_manager.subscribe(operation_id)

    async def event_stream():
        last_heartbeat = time.monotonic()
        try:
            # Primer evento JSON para handshake; evita carrera entre stream y start.
            yield progress_manager.encode_event(
                {"type": "hello", "ts": time.time(), "operation_id": operation_id}
            )
            for event in history:
                logger.debug(
                    "LOG01 progress yield operation_id=%s type=%s stage=%s",
                    operation_id,
                    event.get("type"),
                    event.get("stage"),
                )
                yield progress_manager.encode_event(event)
            while True:
                try:
                    item = channel.queue.get_nowait()
                except queue.Empty:
                    now = time.monotonic()
                    if now - last_heartbeat >= 0.8:
                        yield b"\n"
                        last_heartbeat = now
                    await asyncio.sleep(0.1)
                    continue
                if item is SENTINEL:
                    break
                logger.debug(
                    "LOG01 progress yield operation_id=%s type=%s stage=%s",
                    operation_id,
                    item.get("type"),
                    item.get("stage"),
                )
                yield progress_manager.encode_event(item)
                last_heartbeat = time.monotonic()
        finally:
            logger.debug("LOG01 progress client disconnected operation_id=%s", operation_id)
            progress_manager.unsubscribe(operation_id)
    headers = {
        # Streaming NDJSON: evitar buffering/transformaciones (sin gzip).
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(
        event_stream(),
        media_type="application/x-ndjson; charset=utf-8",
        headers=headers,
    )


@router.post("/cancel/{operation_id}")
def log01_cancel(operation_id: str):
    if not cancel_manager.cancel(operation_id):
        raise HTTPException(
            status_code=404,
            detail="Operacion no encontrada.",
            headers={"X-Code": "NOT_FOUND"},
        )
    _emit(operation_id, {"type": "status", "stage": "cancelled", "message": "Cancelado por el usuario"})
    progress_manager.finish(operation_id)
    return {"ok": True}


# ----------------------------
# Start + result (async)
# ----------------------------
@router.post("/start")
def log01_start(
    files: List[UploadFile] = File(...),
    operation_id: Optional[str] = Form(None),
    output_filename: Optional[str] = Form(None),
):
    _cleanup_log01_jobs()
    op_id = (operation_id or "").strip() or str(uuid.uuid4())
    logger.info("LOG01 start operation_id=%s", op_id)

    if not files:
        raise HTTPException(status_code=400, detail="Debes seleccionar al menos 1 Excel.")

    with LOG01_JOBS_LOCK:
        if op_id in LOG01_JOBS:
            raise HTTPException(status_code=409, detail="Operacion ya existe.")

    work_dir = tempfile.mkdtemp(prefix=f"log01_{op_id}_")
    try:
        file_items = _persist_upload_files(files, work_dir)
    except Exception:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise

    cancel_manager.create(op_id)
    progress_manager.ensure(op_id)

    job = Log01Job(
        operation_id=op_id,
        created_at=time.time(),
        status="running",
        work_dir=work_dir,
    )
    with LOG01_JOBS_LOCK:
        LOG01_JOBS[op_id] = job

    thread = threading.Thread(
        target=_run_log01_job,
        args=(job, file_items, output_filename),
        daemon=True,
    )
    thread.start()
    return {"operation_id": op_id, "status": "started"}


@router.get("/result/{operation_id}")
def log01_result(operation_id: str):
    _cleanup_log01_jobs()
    with LOG01_JOBS_LOCK:
        job = LOG01_JOBS.get(operation_id)

    if job is None:
        raise HTTPException(status_code=404, detail="Resultado no encontrado.")

    if job.status == "running":
        return JSONResponse(status_code=202, content={"status": "processing"})

    if job.status == "cancelled":
        return JSONResponse(status_code=409, content={"detail": "Operacion cancelada."})

    if job.status == "error":
        return JSONResponse(status_code=409, content={"detail": job.error or "Error de procesamiento."})

    if not job.result_path or not os.path.exists(job.result_path):
        raise HTTPException(status_code=404, detail="Resultado no disponible.")

    filename = job.output_name or "BD_CONSOLIDADO.xlsx"
    headers = {
        "X-File-Name": filename,
    }
    return FileResponse(
        job.result_path,
        filename=filename,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )


# ----------------------------
# Upload + procesamiento + respuesta XLSX (sync)
# ----------------------------
@router.post("/upload")
def log01_upload(
    files: List[UploadFile] = File(...),
    operation_id: Optional[str] = Form(None),
    output_filename: Optional[str] = Form(None),
):
    logger.info("LOG01 upload operation_id=%s", operation_id)
    cancel_token = cancel_manager.create(operation_id) if operation_id else None
    if operation_id:
        progress_manager.ensure(operation_id)

    file_items: List[Log01InputFile] = []
    for idx, up in enumerate(files, start=1):
        name = up.filename or f"archivo_{idx}.xlsx"
        data = up.file.read()
        up.file.close()
        file_items.append(Log01InputFile(name=name, data=data))

    try:
        xlsx_bytes, out_name, _summary = _process_log01_files(
            file_items,
            operation_id,
            output_filename,
            cancel_token,
        )
    except Log01Cancelled:
        progress_manager.finish(operation_id)
        raise HTTPException(
            status_code=499,
            detail="Operacion cancelada por el usuario.",
            headers={"X-Code": "CANCELLED"},
        )
    finally:
        if operation_id:
            cancel_manager.remove(operation_id)

    progress_manager.finish(operation_id)

    headers = {
        "X-File-Name": out_name,
        "Content-Disposition": f'attachment; filename="{out_name}"',
    }
    return Response(
        content=xlsx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )
