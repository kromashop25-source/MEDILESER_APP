from __future__ import annotations
from fastapi import APIRouter, UploadFile, File, HTTPException, status, Form
from pathlib import Path
from typing import Optional
import uuid
import shutil

from app.utils.refs import sanitize_filename

router = APIRouter()

ALLOWED_EXTS = {".xlsx", ".xlsm"}
UPLOAD_DIR = Path("data")/"uploads"

@router.post("/upload", status_code=status.HTTP_201_CREATED)
async def upload_file(file: UploadFile = File(...), suggested_name: Optional[str] = Form(None)):
    """
    Sube un archivo Excel y lo guarda en data/uploads con nombe seguro.
    Retorna la ruta relativa para usarla luego em /excel/inspect o /excel/update.
    """
    # --- Normalizar filename (UploadFile.filename puede ser None) ---
    incoming_name: str = (file.filename or "").strip()
    if not incoming_name:
        # Fallback segur si el cliente no envió nombre
        incoming_name = "upload.xlsx"

    # validar extensión
    ext = Path(incoming_name).suffix.lower()
    if ext not in ALLOWED_EXTS:
        raise HTTPException(status_code=400, detail=f"Extensión no permitida: {ext}. Usa xlsx o xlsm.")
    # destino seguro
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    # limpiar suggested_name (puede venir none)
    suggested_clean: Optional[str] = suggested_name.strip() if suggested_name else None
    base_name: str = sanitize_filename(suggested_name or incoming_name)
    unique = f"{uuid.uuid4().hex[:8]}__{base_name}"
    dest: Path = UPLOAD_DIR / unique

    # guardar al disco (streaming)
    try:
        with dest.open("wb") as out:
            shutil.copyfileobj(file.file, out)
    except Exception as ex:
        raise HTTPException(status_code=500, detail=f"Error guardando archivo: {type(ex).__name__}: {ex}") from ex
    finally:
        await file.close()
    
    return {
        "saved": True,
        "relative_path": dest.as_posix(),
        "filename": base_name,
        "size_bytes": dest.stat().st_size,
        "hint_next": "Usa este 'relative_path' en /excel/inspect o /excel/update"
    }
    