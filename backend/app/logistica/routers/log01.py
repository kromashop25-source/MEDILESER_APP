from __future__ import annotations

import asyncio
import json
import logging
import queue
import re
import time
import unicodedata
from copy import copy
from dataclasses import dataclass
from datetime import date, datetime
from io import BytesIO
from typing import Any, Dict, List, Optional, Tuple, cast

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response, StreamingResponse
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


# ----------------------------
# Progreso (NDJSON stream)
# ----------------------------
@router.get("/progress/{operation_id}")
async def log01_progress_stream(operation_id: str):
    logger.info("LOG01 progress subscribe operation_id=%s", operation_id)
    deadline = time.monotonic() + 1.5
    subscribed = progress_manager.subscribe_existing(operation_id)
    while subscribed is None and time.monotonic() < deadline:
        await asyncio.sleep(0.1)
        subscribed = progress_manager.subscribe_existing(operation_id)
    if subscribed is None:
        raise HTTPException(
            status_code=404,
            detail="Operacion no encontrada.",
            headers={"X-Code": "NOT_FOUND"},
        )
    channel, history = subscribed

    async def event_stream():
        last_heartbeat = time.monotonic()
        try:
            for event in history:
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
                yield progress_manager.encode_event(item)
                last_heartbeat = time.monotonic()
        finally:
            progress_manager.unsubscribe(operation_id)
    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(
        event_stream(),
        media_type="application/x-ndjson",
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
# Upload + procesamiento + respuesta XLSX
# ----------------------------
@router.post("/upload")
def log01_upload(
    files: List[UploadFile] = File(...),
    operation_id: Optional[str] = Form(None),
    output_filename: Optional[str] = Form(None),
):
    logger.info("LOG01 upload operation_id=%s", operation_id)
    # token de cancelación (opcional)
    cancel_token = cancel_manager.create(operation_id) if operation_id else None
    cancel_emitted = False
    if operation_id:
        progress_manager.ensure(operation_id)

    def _raise_cancelled() -> None:
        nonlocal cancel_emitted
        if cancel_token and cancel_token.is_cancelled():
            if not cancel_emitted:
                _emit(
                    operation_id,
                    {"type": "status", "stage": "cancelled", "message": "Cancelado por el usuario"},
                )
                cancel_emitted = True
            raise HTTPException(
                status_code=499,
                detail="Operación cancelada por el usuario.",
                headers={"X-Code": "CANCELLED"},
            )

    try:
        _emit(operation_id, {"type": "status", "stage": "received", "message": "Archivos recibidos", "progress": 0})
        time.sleep(0.01) # Yield para permitir flush del primer evento

        # 1) Consolidar serie -> (oi mayor, estado final)
        series: Dict[str, SerieInfo] = {}
        total_files = len(files)
        ok_files = 0
        bad_files = 0

        for idx, up in enumerate(files, start=1):
            _raise_cancelled()
            time.sleep(0.01) # Yield entre archivos

            fname = up.filename or f"archivo_{idx}.xlsx"
            _emit(operation_id, {"type": "status", "stage": "file_start", "message": f"Procesando: {fname}", "progress": int((idx-1)*100/max(total_files,1))})

            try:
                oi_num = _parse_oi_number_from_filename(fname)
                data = up.file.read()
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
                        time.sleep(0.001) # Yield crítico: libera GIL durante lectura pesada
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
                _emit(operation_id, {"type": "status", "stage": "file_ok", "message": f"OK: {fname} (registros leídos: {extracted})", "progress": int(idx*100/max(total_files,1))})
                time.sleep(0.01) # Yield tras archivo exitoso

            except Exception as e:
                bad_files += 1
                _emit(operation_id, {"type": "error", "stage": "file_error", "message": f"Error en {fname}", "detail": str(e), "code": "FILE_INVALID"})
                # Importante: continuar con el lote
                time.sleep(0.01) # Yield tras error de archivo
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
            r = i + 1 # inicia en fila 2
            if r != 2:
                for c in cols_to_fill:
                    src = ws_out.cell(row=2, column=c)
                    dst = ws_out.cell(row=r, column=c)
                    _copy_cell_style(src, dst)

            ws_out.row_dimensions[r].height = 15

            info = series[serie]
            item_cell = cast(Cell, ws_out.cell(row=r, column=col_item, value=i))           # item
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

        time.sleep(0.01) # Yield antes de completar
        _emit(operation_id, {"type": "complete", "message": "Consolidación completada", "percent": 100.0, "result": summary})
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
    
    finally:
        if operation_id:
            cancel_manager.remove(operation_id)
            


        

        
