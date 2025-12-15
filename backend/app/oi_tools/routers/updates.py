from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Depends
from fastapi.responses import StreamingResponse, Response
from typing import List, Optional, Dict
import os
import json

from app.oi_tools.services.updates.update_base_by_model import (
    OIFile,
    PasswordBundle,
    UpdateOptions,
    probe_open_all_ois,
    dry_run_update_base_from_ois,
    execute_update_base_from_ois,
    PasswordRequiredError,
    WrongPasswordError,
)
from app.oi_tools.services.progress_manager import progress_manager

from app.api.auth import get_current_user_session

router = APIRouter(prefix="/bases/actualizar", tags=["actualizacion-bases"], dependencies=[Depends(get_current_user_session)])

def ndjson_stream(events):
    def _iter():
        for ev in events:
            yield (json.dumps(ev, ensure_ascii=False) + "\n").encode("utf-8")
    return StreamingResponse(_iter(), media_type="application/x-ndjson")

def to_bool(s: str) -> bool:
    """Normaliza flags tipo 'true/false', 'yes/no' '1/0' desde FormData."""
    return str(s).strip().lower() in ("1", "true", "yes", "y", "on")

def parse_overrides(raw: Optional[str]) -> Dict[str, str]:
    """
    Acepta JSON {"Nombre.xlsx":"clave"} o texto con líneas "Nombre.xlsx: clave".
    Normaliza nombre con os.path.basename
    """
    if not raw:
        return {}
    # 1) Intento JSON
    try:
        obj = json.loads(raw)
        if isinstance(obj, dict):
            return {os.path.basename(k): str(v) for k, v in obj.items()}
    except json.JSONDecodeError:
        pass
    # 2) Formato por líneas: "Nombre.xlsx: clave"
    out: Dict[str, str] = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        name, pwd = line.split(":", 1)
        name = os.path.basename(name).strip()
        pwd = pwd.strip()
        if name and pwd:
            out[name] = pwd
    return out

@router.post("/dry-run-upload")
def dry_run_upload(
    base_file: UploadFile = File(...),
    oi_files: List[UploadFile] = File(...),
    default_password: Optional[str] = Form(None),
    per_file_passwords_json: Optional[str] = Form(None),
    oi_pattern: str = Form(r"^OI-(\d+)-(\d{4})$"),
    oi_start_row: int = Form(9),
    base_sheet: Optional[str] = Form(None),
):
    # Leer binarios
    base_file.file.seek(0)
    base_bytes = base_file.file.read()
    oi_payload: List[OIFile] = []
    for f in oi_files:
        # filename puede ser Optional[str]; validamos y normalizamos
        if not f.filename:
            raise HTTPException(status_code=400, detail="Cada OI debe tener nombre de archivo.")
        safe_name = os.path.basename(f.filename)
        f.file.seek(0)
        oi_payload.append({"name": safe_name, "bytes": f.file.read()})

    # Overrides (JSON o líneas "Nombre.xlsx: clave")
    overrides: Dict[str, str] = parse_overrides(per_file_passwords_json)
    
    # Normalizar patrón (escapes dobles de FormData)
    oi_pattern = oi_pattern.replace("\\\\", "\\")

    pw = PasswordBundle(default=default_password, per_file=overrides)

    # Preflight para disparar modal si hace falta
    try:
        probe_open_all_ois(oi_payload, pw, oi_pattern)
    except PasswordRequiredError as e:
        raise HTTPException(status_code=401, detail=str(e), headers={"X-Code": "PASSWORD_REQUIRED"})
    except WrongPasswordError as e:
        raise HTTPException(status_code=403, detail=str(e), headers={"X-Code": "WRONG_PASSWORD"})

    # Opciones y stream real
    opt = UpdateOptions(
        oi_pattern=oi_pattern,
        oi_start_row=int(oi_start_row),
        base_start_row=9,
        # Por defecto, usar "ERROR FINAL" en la Base
        target_sheet_name=base_sheet or "ERROR FINAL",
    )
    events = dry_run_update_base_from_ois(base_bytes, oi_payload, pw, opt)
    return ndjson_stream(events)

@router.post("/upload")
def run_upload(
    base_file: UploadFile = File(...),
    oi_files: List[UploadFile] = File(...),
    default_password: Optional[str] = Form(None),
    per_file_passwords_json: Optional[str] = Form(None),
    oi_pattern: str = Form(r"^OI-(\d+)-(\d{4})$"),
    oi_start_row: int = Form(9),
    replicate_merges: str = Form("true"),
    replicate_row_heights: str = Form("false"),
    replicate_col_widths: str = Form("false"),
    base_sheet: Optional[str] = Form(None),
    operation_id: Optional[str] = Form(None),
):
    # Helpers: usamos el to_bool definido a nivel de módulo
    
    # Leer binarios
    base_file.file.seek(0)
    base_bytes = base_file.file.read()
    oi_payload: List[OIFile] = []
    for f in oi_files:
        if not f.filename:
            raise HTTPException(status_code=400, detail="Cada OI debe tener nombre de archivo.")
        safe_name = os.path.basename(f.filename)
        f.file.seek(0)
        oi_payload.append({"name": safe_name, "bytes": f.file.read()})
    
    # Overrides (JSON o líneas "Nombre.xlsx: clave")
    overrides: Dict[str, str] = parse_overrides(per_file_passwords_json)
    
    
    # Normalizar patrón (escapes dobles de FormData)
    oi_pattern = oi_pattern.replace("\\\\", "\\")
    pw = PasswordBundle(default=default_password, per_file=overrides)

    # Preflight para disparar modal si hace falta
    try:
        probe_open_all_ois(oi_payload, pw, oi_pattern)
    except PasswordRequiredError as e:
        raise HTTPException(status_code=401, detail=str(e), headers={"X-Code": "PASSWORD_REQUIRED"})
    except WrongPasswordError as e:
        raise HTTPException(status_code=403, detail=str(e), headers={"X-Code": "WRONG_PASSWORD"})
    
    # Progreso: recibido
    if operation_id:
        progress_manager.emit(operation_id, {
            "type": "status",
            "stage": "received",
            "message": "Archivos preparados",
            "progress": 0
        })
    
    # Ejecutar integración real
    opt = UpdateOptions(
        oi_pattern=oi_pattern,
        oi_start_row=int(oi_start_row),
        base_start_row=9,
        # Por defecto, usar "ERROR FINAL" en la Base
        target_sheet_name=base_sheet or "ERROR FINAL",
    )
    rep_merges  = to_bool(replicate_merges)
    rep_heights = to_bool(replicate_row_heights)
    rep_widths  = to_bool(replicate_col_widths)

    def forward(p: Dict):
        if not operation_id:
            return
        progress_manager.emit(operation_id, {"type": "progress", **p})

    try:
        xlsx_bytes, summary = execute_update_base_from_ois(
        base_bytes,
        oi_payload,
        pw,
        opt,
        replicate_merges=rep_merges,
        replicate_row_heights=rep_heights,
        replicate_col_widths=rep_widths,
        progress_cb=forward,
        enforce_excel_limit=True,
    )
    except ValueError as e:
        # p.ej. overflow de filas de Excel
        raise HTTPException(status_code=400, detail=str(e))

    # Completar y responder
    if operation_id:
        progress_manager.emit(operation_id, {
            "type": "complete",
            "message": "Actualización completada",
            "percent": 100.0,
            "result": summary,
        })
        progress_manager.finish(operation_id)

    fname = base_file.filename or "base_actualizada.xlsx"
    headers = {
        "X-File-Name": fname,
        "Content-Disposition": f'attachment; filename="{os.path.basename(fname)}"',
    }
    return Response(
        content=xlsx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers
    )
