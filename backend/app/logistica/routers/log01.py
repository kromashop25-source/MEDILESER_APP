from __future__ import annotations

import asyncio
import json
import queue
import re
from dataclasses import dataclass
from io import BytesIO
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response, StreamingResponse
from openpyxl import load_workbook

from app.api.auth import get_current_user_session
from app.core.settings import get_settings
from app.oi_tools.services.progress_manager import progress_manager, _SENTINEL as SENTINEL # mismo sentinel
from app.oi_tools.services.cancel_manager import cancel_manager

router = APIRouter(
    prefix="/logistica/log01",
    tags=["logistica/log01"],
    dependencies=[Depends(get_current_user_session)],
)

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

def _natural_key(s: str):
    # Natural sort: divide digitos y texto
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r'(\d+)', s)]