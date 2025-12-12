from __future__ import annotations

from typing import List

from fastapi import APIRouter, File, UploadFile, Query

# Reutilizamos la logica probada del mini-servicio oi_merge_b
from app.modules.oi_merge_b import main as legacy_merge

router = APIRouter()


@router.get("/config/upload-limits")
async def get_upload_limits():
    """
    Delegamos en el modulo legado para mantener un unico lugar
    donde se calculan los limites (usa variables de entorno y defaults).
    """
    return await legacy_merge.get_upload_limits()


@router.post("/merge")
async def merge(
    master: UploadFile = File(...),
    technicians: List[UploadFile] = File(...),
    mode: str = Query("correlativo"),
):
    """
    Reutiliza la implementacion establecida en oi_merge_b.main.merge,
    que maneja escritura temporal, validaciones y genera el XLS final.
    """
    return await legacy_merge.merge(master=master, technicians=technicians, mode=mode)
