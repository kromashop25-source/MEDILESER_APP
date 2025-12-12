from __future__ import annotations
import re
import unicodedata
from typing import Optional

_CELL_RE = re.compile(r"^[A-Z]{1,3}[1-9][0-9]{0,5}$")

def is_valid_cell_ref(cell:str) -> bool:
    """
    Valida referencias tipo A1. Columnas A-ZZZ y filas 1..999999.
    """
    if not isinstance(cell, str):
        return False
    return bool(_CELL_RE.fullmatch(cell.strip().upper()))

def sanitize_filename(name: str, max_len: int = 120) -> str:
    """
    Normaliza a ASCII, reemplaza caracteres problemáticos y recorta logitud.
    No elimina la extensión (si existe).
    """
    if not name:
        return "file"
    # separa extensión
    parts = name.rsplit(".", 1)
    base = parts[0]
    ext = f".{parts[1]}" if len(parts) == 2 else ""
    # normaliza
    base = unicodedata.normalize("NFKD", base)
    base = base.encode("ascii", "ignore").decode("ascii")
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._-") or "file"
    # recorta
    if len(base) > max_len:
        base = base[:max_len]
    return base + ext.lower()