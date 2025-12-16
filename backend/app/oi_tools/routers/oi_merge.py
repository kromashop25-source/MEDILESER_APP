from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, File, UploadFile, Query, Depends, Form, HTTPException

# Reutilizamos la logica probada del mini-servicio oi_merge_b
from app.api.auth import get_current_user_session
from app.oi_tools.modules.oi_merge_b import main as legacy_merge
from app.oi_tools.services.cancel_manager import cancel_manager
from app.oi_tools.services.progress_manager import progress_manager

router = APIRouter(prefix="/merge", tags=["merge"], dependencies=[Depends(get_current_user_session)])


@router.get("/config/upload-limits")
async def get_upload_limits():
    """
    Delegamos en el modulo legado para mantener un unico lugar
    donde se calculan los limites (usa variables de entorno y defaults).
    """
    return await legacy_merge.get_upload_limits()


@router.post("/")
async def merge(
    master: UploadFile = File(...),
    technicians: List[UploadFile] = File(...),
    mode: str = Query("correlativo"),
    operation_id: Optional[str] = Form(None),
):
    """
    Reutiliza la implementacion establecida en oi_merge_b.main.merge,
    que maneja escritura temporal, validaciones y genera el XLS final.
    """
    return await legacy_merge.merge(
        master=master,
        technicians=technicians,
        mode=mode,
        operation_id=operation_id,
    )


@router.post("/cancel/{operation_id}")
async def cancel_merge(operation_id: str):
    """
    Solicita cancelación cooperativa para una operación de consolidación en curso.
    """
    ok = cancel_manager.cancel(operation_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Operación no encontrada")

    # Emitir y cerrar el stream para que el frontend pare rápidamente.
    progress_manager.emit(
        operation_id,
        {
            "type": "status",
            "stage": "cancelled",
            "message": "Cancelación solicitada",
        },
    )
    progress_manager.finish(operation_id)
    return {"ok": True}
