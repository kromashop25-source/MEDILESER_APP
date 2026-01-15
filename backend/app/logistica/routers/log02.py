from __future__ import annotations

from typing import Any, Dict, List, Optional
import os
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends
from app.api.auth import get_current_user_session
from pydantic import BaseModel, Field


router = APIRouter(
    prefix="/logistica/log02",
    tags=["logistica/log02"],
    dependencies=[Depends(get_current_user_session)],

)

@router.get("/ping")
def log02_ping() -> Dict[str, Any]:
    return {"ok": True, "module": "LOG-02"}

class Log02RutaCheck(BaseModel):
    ruta: str
    existe: bool
    es_directorio: bool
    lectura: bool
    escritura: Optional[bool] = None
    detalle: Optional[str] = None

class Log02ValidarRutasUncRequest(BaseModel):
    rutas_origen: List[str] = Field(default_factory=list, description= "Lista de rutas origen (lectura)")
    ruta_destino: str = Field(..., description="Ruta destino (lesctura/escritura)")

class Log02ValidarRutasUncResponse(BaseModel):
    ok: bool
    origenes: List[Log02RutaCheck]
    destino: Log02RutaCheck

def _clean_path(value: str) -> str:
    return (value or "").strip()

def _check_read_dir(path_str: str) -> Log02RutaCheck:
    ruta = _clean_path(path_str)
    if not ruta:
        return Log02RutaCheck(
            ruta="",
            existe=False,
            es_directorio=False,
            lectura=False,
            detalle="Ruta vacia.",
        )
    try:
        p = Path(ruta)
        exists = p.exists()
        is_dir = p.is_dir() if exists else False
        if not exists:
            return Log02RutaCheck(ruta=ruta, existe=False, es_directorio=False, lectura=False, detalle="No existe.")
        if not is_dir:
            return Log02RutaCheck(ruta=ruta, existe=True, es_directorio=False, lectura=False, detalle="No es una carpeta.")
        
        # Lectura: intenta listar (puede fallar por permisos)
        try:
            os.listdir(ruta)
            return Log02RutaCheck(ruta=ruta, existe=True, es_directorio=True, lectura=True, detalle=None)
        except PermissionError:
            return Log02RutaCheck(
                ruta=ruta,
                existe=True,
                es_directorio=True,
                lectura=False,
                detalle="No tiene permisos de lectura.",
            )
        except Exception as e:
            return Log02RutaCheck(
                ruta=ruta,
                existe=True,
                es_directorio=True,
                lectura=False,
                detalle=f"No se puede leer la carpeta. {type(e).__name__}: {e}",
            )
    except Exception as e:
        return Log02RutaCheck(
            ruta=ruta,
            existe=False,
            es_directorio=False,
            lectura=False,
            detalle=f"Ruta inválida. {type(e).__name__}: {e}",
        )
    
def _check_dest_dir(path_str: str) -> Log02RutaCheck:
    base = _check_read_dir(path_str)
    # Si ya falló por no existir / no ser dir, no intentamos escribir.
    if not base.existe or not base.es_directorio:
        base.escritura = False
        return base
    
    # Escritura: crear archivos temporal y borrarl
    try:
        tmp_fd, tmp_path = tempfile.mkstemp(prefix="log02_check", suffix=".tmp", dir=base.ruta)
        try:
            with os.fdopen(tmp_fd, "wb") as f:
                f.write(b"ok")
        finally:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
        base.escritura = True
        return base
    except PermissionError:
        base.escritura = False
        base.detalle = "Sin permisos de escritura."
        return base
    except Exception as e:
        base.escritura = False
        base.detalle = f"No se pudo escribir en la carpeta. {type(e).__name__}: {e}"
        return base


@router.post("/validar-rutas-unc", response_model=Log02ValidarRutasUncResponse)
def log02_validar_rutas_unc(payload: Log02ValidarRutasUncRequest) -> Log02ValidarRutasUncResponse:
    # Normalizar + limitar para evitar abuso accidental
    rutas_origen = [_clean_path(x) for x in (payload.rutas_origen or []) if _clean_path(x)]
    if len(rutas_origen) == 0:
        # Permitimos que UI valide y muestre mensaje claro desde backend también
        origenes = [Log02RutaCheck(ruta="", existe=False, es_directorio=False, lectura=False, detalle="Debe ingresar al menos una ruta de origen.")]
    else:
        if len(rutas_origen) > 20:
            rutas_origen = rutas_origen[:20]
        origenes = [_check_read_dir(x) for x in rutas_origen]
        
    destino = _check_dest_dir(payload.ruta_destino)

    ok_origen = all(o.existe and o.es_directorio and o.lectura for o in origenes) if rutas_origen else False
    ok_destino = bool(destino.existe and destino.es_directorio and destino.lectura and destino.escritura)
    ok = bool(ok_origen and ok_destino)

    return Log02ValidarRutasUncResponse(ok=ok, origenes=origenes, destino=destino)