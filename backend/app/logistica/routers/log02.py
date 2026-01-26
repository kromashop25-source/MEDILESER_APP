from __future__ import annotations

from typing import Any, Dict, List, Optional, Set
import os
import json
import re
import unicodedata
import tempfile
import queue
import threading
import uuid
import time
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from app.api.auth import get_current_user_session
from pydantic import BaseModel, Field
from app.core.settings import get_settings
from sqlmodel import Session, select
from app.core.db import engine
from app.models import Log01Artifact
from app.oi_tools.services.progress_manager import progress_manager, SENTINEL as PM_SENTINEL
from app.oi_tools.services.cancel_manager import cancel_manager, CancelToken



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
    roots_abs = _allowed_roots_abs()

    # Normalizar + limitar para evitar abuso accidental
    rutas_origen = [_clean_path(x) for x in (payload.rutas_origen or []) if _clean_path(x)]
    if len(rutas_origen) == 0:
        # Permitimos que UI valide y muestre mensaje claro desde backend también
        origenes = [Log02RutaCheck(ruta="", existe=False, es_directorio=False, lectura=False, detalle="Debe ingresar al menos una ruta de origen.")]
    else:
        if len(rutas_origen) > 20:
            rutas_origen = rutas_origen[:20]
        origenes = []
        for x in rutas_origen:
            detail = _check_allowed_detail(x, roots_abs)
            if detail:
                origenes.append(
                    Log02RutaCheck(
                        ruta=_clean_path(x),
                        existe=False,
                        es_directorio=False,
                        lectura=False,
                        detalle=detail,
                    )
                )
            else:
                origenes.append(_check_read_dir(x))
        
    dest_detail = _check_allowed_detail(payload.ruta_destino, roots_abs)
    if dest_detail:
        destino = Log02RutaCheck(
            ruta=_clean_path(payload.ruta_destino),
            existe=False,
            es_directorio=False,
            lectura=False,
            escritura=False,
            detalle=dest_detail,
        )
    else:
        destino = _check_dest_dir(payload.ruta_destino)

    ok_origen = all(o.existe and o.es_directorio and o.lectura for o in origenes) if rutas_origen else False
    ok_destino = bool(destino.existe and destino.es_directorio and destino.lectura and destino.escritura)
    ok = bool(ok_origen and ok_destino)

    return Log02ValidarRutasUncResponse(ok=ok, origenes=origenes, destino=destino)


# ====================================
# Explorador de carpetas (server-side)
# ====================================
class Log02ExplorerRootsResponse(BaseModel):
    roots: List[str]


class Log02ExplorerListItem(BaseModel):
    name: str
    path: str


class Log02ExplorerListResponse(BaseModel):
    path: str
    folders: List[Log02ExplorerListItem]


def _norm_abs(p: str) -> str:
    # Normalización simple para Windows/UNC.
    # No "resolve()" para evitar cambios extra; se apoya en normpath + abspath.
    s = (p or "").strip()
    if not s:
        return ""
    return os.path.normpath(os.path.abspath(s))


def _is_within_allowed(path_abs: str, roots_abs: List[str]) -> bool:
    if not path_abs:
        return False
    for r in roots_abs:
        try:
            common = os.path.commonpath([path_abs, r])
            if common == r:
                return True
        except Exception:
            continue
    return False


@router.get("/explorador/roots", response_model=Log02ExplorerRootsResponse)
def log02_explorer_roots() -> Log02ExplorerRootsResponse:
    settings = get_settings()
    roots = [(x or "").strip() for x in (settings.log02_unc_roots or []) if (x or "").strip()]
    return Log02ExplorerRootsResponse(roots=roots)


@router.get("/explorador/listar", response_model=Log02ExplorerListResponse)
def log02_explorer_listar(path: str = Query(..., description="Ruta absoluta dentro de raíces permitidas")) -> Log02ExplorerListResponse:
    settings = get_settings()
    roots = [(x or "").strip() for x in (settings.log02_unc_roots or []) if (x or "").strip()]
    if not roots:
        raise HTTPException(status_code=400, detail="No hay raíces configuradas para LOG-02. Configure VI_LOG02_UNC_ROOTS.")

    roots_abs = [_norm_abs(r) for r in roots]
    path_abs = _norm_abs(path)

    if not _is_within_allowed(path_abs, roots_abs):
        raise HTTPException(status_code=403, detail="Ruta fuera de las áreas permitidas (VI_LOG02_UNC_ROOTS).")
    
    p = Path(path_abs)
    if not p.exists():
        raise HTTPException(status_code=404, detail="La carpeta no existe.")
    if not p.is_dir():
        raise HTTPException(status_code=400, detail="La ruta no es una carpeta.")
    
    try:
        folders: List[Log02ExplorerListItem] = []
        with os.scandir(path_abs) as it:
            for entry in it:
                # solo en carpetas
                try:
                    if entry.is_dir(follow_symlinks=False):
                        folders.append(Log02ExplorerListItem(name=entry.name, path=os.path.join(path_abs, entry.name)))
                except Exception:
                    continue
        # orden alfabético
        folders.sort(key=lambda x: x.name.lower())
        return Log02ExplorerListResponse(path=path_abs, folders=folders)
    except PermissionError:
        raise HTTPException(status_code=403, detail="Sin permisos de lectura para listar en carpeta.")


# =============================================
# Copiado de PDFs conformes por OI (PB-LOG-015)
# =============================================

class Log02CopyConformesStartRequest(BaseModel):
    run_id: int = Field(..., description="ID de corrida de LOG-01 (historial) para usar sus artefactos (MANIFIESTO/NO_CONFORME_FINAL).")
    rutas_origen: List[str] = Field(default_factory=list, description="Rutas origen (lectura). Se buscarán carpetas OI-####-YYYY-LOTE-#### dentro de estas rutas.")
    ruta_destino: str = Field(..., description="Ruta destino (lectura/escritura). Se crearán carpetas por OI (mismo nombre exacto del lote).")

class Log02CopyConformesStartResponse(BaseModel):
    operation_id: str

class Log02CopyConformesPollResponse(BaseModel):
    cursor_next: int = -1
    events: List[dict] = []
    done: bool = False
    summary: Optional[Any] = None

def _norm_str(v: Any) -> str:
    return ("" if v is None else str(v)).strip()

def _read_artifact_bytes(run_id: int, kind: str) -> bytes:
    """
    Lee en artefacto LOG-01 desde Log01Artifact (storage_rel_path relativo a settings.data_dir).

    """
    st = get_settings()
    with Session(engine) as session:
        art = session.exec(
            select(Log01Artifact).where(Log01Artifact.run_id == run_id, Log01Artifact.kind == kind)
        ).first()
        if not art:
            raise HTTPException(
                status_code=404,
                detail=f"No se encontró el artefacto requerido ({kind}) para la corrida {run_id}.",
            )
        abs_path = (st.data_dir / art.storage_rel_path).resolve()
        if not abs_path.exists():
            raise HTTPException(
                status_code=404,
                detail=f"El artefacto {kind} no existe en disco. Ruta: {abs_path}",
            )
        try:
            return abs_path.read_bytes()
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"No se pudo leer el artefacto {kind}. {type(e).__name__}: {e}",
            )
        
def _allowed_roots_abs() -> List[str]:
    st = get_settings()
    roots = [(x or "").strip() for x in (st.log02_unc_roots or []) if (x or "").strip()]
    return [_norm_abs(r) for r in roots] if roots else []

def _check_allowed_detail(path_str: str, roots_abs: List[str]) -> Optional[str]:
    """
    Devuelve un mensaje de detalle si la ruta NO está permitida por VI_LOG02_UNC_ROOTS.
    - Si no hay roots configuradas, devolvemos detalle (para que el usuario lo corrija).
    - Si está dentro, devuelve None.
    """
    ruta = _clean_path(path_str)
    if not ruta:
        return None
    if not roots_abs:
        return "No hay raíces configuradas para LOG-02. Configure VI_LOG02_UNC_ROOTS."
    path_abs = _norm_abs(ruta)
    if not _is_within_allowed(path_abs, roots_abs):
        return "Ruta fuera de las áreas permitidas (VI_LOG02_UNC_ROOTS)."
    return None


def _ensure_within_allowed_or_400(path_abs: str, roots_abs: List[str], label: str) -> None:
    if not roots_abs:
        return # si no hay allowlist configurada, no bloqueamos (misma lógica que ya usas en roots/listar)
    p_abs = _norm_abs(path_abs)
    if not _is_within_allowed(p_abs, roots_abs):
        raise HTTPException(status_code=403, detail=f"{label}: ruta fuera de las áreas permitidas.")
    

def _emit(operation_id: str, ev: Dict[str, Any]) -> None:
    progress_manager.emit(operation_id, ev)

def _record_oi_error(
        audit: Dict[str, Any],
        operation_id: str,
        *,
        oi_tag: str,
        code: str,
        detail: str,
) -> None:
    audit["ois_error"].append({"oi": oi_tag, "code": code, "detail": detail})
    _emit(operation_id, {"type": "oi_error", "oi": oi_tag, "code": code, "message": detail})

def _record_oi_warn(
        operation_id: str,
        *,
        oi_tag: str,
        code: str,
        detail: str,
) -> None:
    _emit(operation_id, {"type": "oi_warn", "oi": oi_tag, "code": code, "message": detail})


def _cleanup_dest_folder(dest_folder: Path) -> None:
    try:
        if dest_folder.exists():
            shutil.rmtree(dest_folder)
    except Exception:
        pass

def _emit_progress(
        operation_id: str,
        *,
        i: int,
        total_ois: int,
        oi_tag: str,
        processed_in_oi: int | None = None,
        total_in_oi: int | None = None,
        message: str | None = None,
) -> None:
    """
    Emite progreso 0..100.
     - Si processed_in_oi/total_in_oi están presentes -> progreso fino dentro de la OI.
     - Si no -> progreso por OI (i/total_ois).
    """
    tot = max(int(total_ois), 1)
    base = (max(int(i), 1) -1) / tot # inicio de la OI actual (0..1)

    if processed_in_oi is not None and total_in_oi is not None and total_in_oi > 0:
        frac_oi = min(max(processed_in_oi / total_in_oi, 0.0), 1.0)
        pct = (base + (frac_oi / tot)) * 100.0
    else:
        pct = (max(int(i), 1) / tot) * 100.0

    msg = message
    if not msg:
        if processed_in_oi is not None and total_in_oi is not None and total_in_oi > 0:
            msg = f"{oi_tag}: {processed_in_oi}/{total_in_oi} PDFs •  {i}/{tot}"
        else:
            msg = f"Procesadas {i}/{tot} OIs"

    _emit(
        operation_id,
        {
            "type": "status",
            "stage": "progreso",
            "progress": float(round(pct, 2)),
            "percent": float(round(pct, 2)),
            "message": msg,
        },
    )

    


def _series_from_filename(name:str) -> str:
    # Serie = nombre del PDF sin extensión
    p = Path(name)
    return p.stem.strip()

_SERIE_RANGE_RE = re.compile(r"([A-Z]+)\s*(\d{2,})\s*(?:AL|-|A)\s*([A-Z]+)?\s*(\d{2,})", re.IGNORECASE)
_SERIE_RANGE_MAX = 200000

def _expand_series_from_text(value: str) -> List[str]:
    """
    Intenta extraer y expandir un rango de series dentro de un texto (p.ej. "PA0001 AL PA0100").
    Si no hay rango válido, devuelve [].
    """
    raw = _norm_str(value)
    if not raw:
        return []
    s = raw.replace("–", "-").replace("—", "-").upper()
    for m in _SERIE_RANGE_RE.finditer(s):
        prefix1 = (m.group(1) or "").upper()
        start_s = m.group(2) or ""
        prefix2 = (m.group(3) or prefix1).upper()
        end_s = m.group(4) or ""
        if not prefix1 or not start_s or not end_s:
            continue
        if prefix2 and prefix2 != prefix1:
            continue
        try:
            start_n = int(start_s)
            end_n = int(end_s)
        except ValueError:
            continue
        if end_n < start_n:
            start_n, end_n = end_n, start_n
        total = end_n - start_n + 1
        if total <= 0 or total > _SERIE_RANGE_MAX:
            continue
        width = max(len(start_s), len(end_s))
        return [f"{prefix1}{str(n).zfill(width)}" for n in range(start_n, end_n + 1)]
    return []

def _expand_conforme_set(conforme_set: Set[str]) -> Set[str]:
    """
    Expande entradas tipo rango (p.ej. "PA0001 AL PA0100") a series individuales.
    Si no se puede expandir, mantiene la serie original.
    """
    expanded: Set[str] = set()
    for serie in conforme_set:
        series_from_range = _expand_series_from_text(serie)
        if series_from_range:
            expanded.update(series_from_range)
        else:
            expanded.add(serie)
    return expanded

def _gaselag_key_from_name(name: str) -> str:
    """
    Normaliza nombre BD_/CD_ para match Gaselag:
    - quita prefijo BD_/CD_
    quita extensión
    elimina diacrítios
    elimina separadores (espacios, guines, puntos, etc.)
    """
    s = Path(name).stem
    s = s.strip()
    if not s:
        return ""
    s = re.sub(r"^(BD|CD)[-_\\s]+", "", s, flags=re.IGNORECASE)
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.upper()
    s = re.sub(r"[^A-Z0-9]+", "", s)
    return s

def _gaselag_display_name(name: str) -> str:
    # Para mensajes legibles: quita BD_/CD_ y extensión, conserva separadores
    s = Path(name).stem
    s = re.sub(r"^(BD|CD)[-_\\s]+", "", s, flags=re.IGNORECASE)
    return s.strip()

def _build_gaselag_serie_map(manifest_payload: Dict[str, Any]) -> Dict[str, List[str]]:
    """
    Retorna: serie_key_normalizada -> [source_files BD_*]
    Basado en MANIFIESTO.by_oi_origen donde oi == GASELAG
    """
    out: Dict[str, List[str]] = {}
    items = manifest_payload.get("by_oi_origen")
    if not isinstance(items, list):
        return out
    for it in items:
        if not isinstance(it, dict):
            continue
        oi = _norm_str(it.get("oi")).upper()
        if oi != "GASELAG":
            continue
        files = it.get("source_files")
        if not isinstance(files, list):
            continue
        for fname in files:
            if not isinstance(fname, str):
                continue
            key = _gaselag_key_from_name(fname)
            if not key:
                continue
            out.setdefault(key, []).append(fname)
    return out

def _find_gaselag_folders_in_origins(series_keys: set[str], rutas_origen: List[str]) -> Dict[str, List[Path]]:
    """
    Busca carpetas Gaselag a 1 nivel dentro de cada origen,
    y las agrupa por clave normalizada.
    """
    found: Dict[str, List[Path]] = {k: [] for k in series_keys}
    if not series_keys:
        return found
    for root in rutas_origen:
        try:
            base = Path(root)
            if not base.exists() or not base.is_dir():
                continue
            for entry in base.iterdir():
                try:
                    if not entry.is_dir():
                        continue
                    key = _gaselag_key_from_name(entry.name)
                    if key in found:
                        found[key].append(entry)
                except Exception:
                    continue
        except Exception:
            continue
    for k in found:
        found[k].sort(key=lambda p: str(p).lower())
    return found


def _build_no_conforme_map(no_conforme_payload: Dict[str, Any]) -> Dict[str, set[str]]:
    """
    Retorna: oi_tag -> set(series_no_conforme)
    Basado en NO_CONFORME_FINAL.items: [{oi, serie, ...}]
    """
    out: Dict[str, set[str]] = {}
    items = no_conforme_payload.get("items")
    if not isinstance(items, list):
        return out
    for it in items:
        if not isinstance(it, dict):
            continue
        oi = _norm_str(it.get("oi"))
        serie = _norm_str(it.get("serie"))
        if not oi or not serie:
            continue
        out.setdefault(oi, set()).add(serie)
    return out


def _build_conforme_map(manifest_payload: Dict[str, Any]) -> Dict[str, set[str]]:
    """
    Retorna: oi_tag -> set(series_conforme)
    Basado en MANIFIESTO.by_oi: [{oi, series_conforme, ...}]
    """
    out: Dict[str, set[str]] = {}
    items = manifest_payload.get("by_oi")
    if not isinstance(items, list):
        return out
    for it in items:
        if not isinstance(it, dict):
            continue
        oi = _norm_str(it.get("oi"))
        if not oi:
            continue
        series_list = it.get("series_conforme")
        if not isinstance(series_list, list):
            continue
        series_set: set[str] = set()
        for s in series_list:
            serie = _norm_str(s)
            if serie:
                series_set.add(serie)
        out[oi] = series_set
    return out


def _is_log02_verbose() -> bool:
    v = os.getenv("VI_LOG02_VERBOSE", "").strip().lower()
    return v in ("1", "true", "yes", "on")

def _find_oi_folders_in_origins(oi_tag: str, rutas_origen: List[str]) -> List[Path]:
    """
    Busca carpetas tipo: {oi_tag}-LOTE-#### (o variantes que empiecen con oi_tag + '-')
    solo a 1 nivel dentro de cada ruta origen.
    """
    found: List[Path] = []
    prefix = f"{oi_tag}-".lower()
    for root in rutas_origen:
        try:
            base = Path(root)
            if not base.exists() or not base.is_dir():
                continue
            for entry in base.iterdir():
                try:
                    if not entry.is_dir():
                        continue
                    name = entry.name.strip()
                    if name.lower().startswith(prefix):
                        # prioriza patrón con "LOTE"
                        found.append(entry)
                except Exception:
                    continue
        except Exception:
            continue
    # Orden determístico por ruta
    found.sort(key=lambda p: str(p).lower())
    return found


def _copy_conformes_worker(
        *,
        operation_id: str,
        cancel_token: CancelToken,
        run_id: int,
        rutas_origen: List[str],
        ruta_destino: str,
) -> None:
    """
    Worker en hilo: copia PDFs conformes por OI, emitiendo progreso NDJSON.
    Reglas:
    - Match de carpeta por prefijo OI-####-YYYY (sin lote) sobre carpetas OI-####-YYYY-LOTE-####.
    - Si una OI tiene 0 carpetas => auditoría 'faltante'
    - Si una OI tiene >1 carpeta => auditoría 'duplicada' (no copiar)
    - Destino: crear carpeta con el mismo nombre exacto del lote.
      Si ya existe => auditoría 'destino duplicado' (no copiar)
    - Copia solo PDFs cuyo nombre (serie) NO esté en NO_CONFORME para esa OI.
      (Si hay otros archivos: se omiten.)
    """
    try:
        _emit(
            operation_id,
            {
                "type": "status",
                "stage": "inicio",
                "message": "Iniciando copiado de PDFs conformes...",
                "progress": 0,
                "percent": 0,
            },
        )

        # 1) Cargar artefactos (MANIFIESTO + NO_CONFORME_FINAL) desde LOG-01
        manifest_bytes = _read_artifact_bytes(run_id, "JSON_MANIFIESTO")
        no_conf_bytes = _read_artifact_bytes(run_id, "JSON_NO_CONFORME_FINAL")

        try:
            manifest = json.loads(manifest_bytes.decode("utf-8"))
        except Exception as e:
            raise RuntimeError(f"MANIFIESTO inválido. {type(e).__name__}: {e}")
        try:
            no_conf = json.loads(no_conf_bytes.decode("utf-8"))
        except Exception as e:
            raise RuntimeError(f"NO_CONFORME_FINAL inválido. {type(e).__name__}: {e}")

        by_oi = manifest.get("by_oi")
        if not isinstance(by_oi, list):
            raise RuntimeError("MANIFIESTO no contiene 'by_oi' válido.")
        
        no_conf_map = _build_no_conforme_map(no_conf)
        conformes_map = _build_conforme_map(manifest)
        use_conforme_allowlist = bool(conformes_map)
        verbose_events = _is_log02_verbose()
        
        gaselag_series_map = _build_gaselag_serie_map(manifest)
        gaselag_keys = sorted(gaselag_series_map.keys())

        # 2) Preparar lista de OIs BASES a procesar (excluye GASELAG)
        oi_tags: List[str] = []
        for b in by_oi:
            if not isinstance(b, dict):
                continue
            oi = _norm_str(b.get("oi"))
            if not oi:
                continue
            if oi.upper() == "GASELAG":
                continue
            oi_tags.append(oi)
        # único + orden estable
        seen: set[str] = set()
        oi_tags_u: List[str] = []
        for oi in oi_tags:
            if oi in seen:
                continue
            seen.add(oi)
            oi_tags_u.append(oi)
        oi_tags = oi_tags_u

        total_ois = len(oi_tags) + len(gaselag_keys)
        if total_ois == 0:
            raise RuntimeError("No hay OIs BASES ni GASELAG en el manifiesto (by_oi)")
        
        audit: Dict[str, Any] = {
            "run_id": run_id,
            "total_ois": total_ois,
            "ois_ok": 0,
            "series_duplicadas": [],
            "series_faltantes": [],
            "ois_faltantes": [],
            "ois_duplicadas": [],
            "destinos_duplicados": [],
            "ois_error": [],
            "archivos": {
                "pdf_detectados": 0,
                "pdf_copiados": 0,
                "pdf_omitidos_no_conforme": 0,
                "pdf_omitidos_duplicados": 0,
                "pdf_omitidos_no_encontrado": 0,  # series esperadas sin PDF
                "archivos_no_pdf_omitidos": 0,
            },
        }

        # 3) Procesar por OI (BASES)
        for i, oi_tag in enumerate(oi_tags, start=1):
            if cancel_token.is_cancelled():
                _emit(operation_id, {"type": "status", "stage": "cancelado", "message": "Cancelado por el usuario"})
                return
            
            _emit(operation_id, {"type": "status", "stage": "oi", "oi": oi_tag, "message": f"Buscando carpeta para {oi_tag} ({i}/{total_ois})"})

            folders = _find_oi_folders_in_origins(oi_tag, rutas_origen)
            if len(folders) == 0:
                audit["ois_faltantes"].append({"oi": oi_tag, "detalle": "No se encontró carpeta de lote en rutas origen."})
                _emit(operation_id, {"type": "oi_warn", "oi": oi_tag, "code": "OI_SIN_CARPETA", "message": "No se encontró carpeta para la OI en los orígenes."})
                _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_tag)
                continue
            if len(folders) > 1:
                audit["ois_duplicadas"].append({"oi": oi_tag, "carpetas": [str(p) for p in folders]})
                _emit(operation_id, {"type": "oi_warn", "oi": oi_tag, "code": "OI_CARPETA_DUPLICADA", "message": "Se encontraron múltiples carpetas para la misma OI. No se copiará hasta corregir."})
                _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_tag)
                continue

            src_folder = folders[0]
            dest_folder = Path(ruta_destino) / src_folder.name
            if dest_folder.exists():
                audit["destinos_duplicados"].append({"oi": oi_tag, "destino": str(dest_folder)})
                _emit(operation_id, {"type": "oi_warn", "oi": oi_tag, "code": "DESTINO_DUPLICADO", "message": "La carpeta destino ya existe. No se copiará hasta corregir."})
                _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_tag)
                continue

            dest_created = False
            oi_ok = False
            file_error_count = 0
            copied = 0
            omitted_nc = 0
            detected_pdf = 0
            omitted_nonpdf = 0
            total_pdfs_in_oi = 0

            try:
                try:
                    dest_folder.mkdir(parents=True, exist_ok=False)
                    dest_created = True
                except FileExistsError:
                    audit["destinos_duplicados"].append({"oi": oi_tag, "destino": str(dest_folder)})
                    _emit(operation_id, {"type": "oi_warn", "oi": oi_tag, "code": "DESTINO_DUPLICADO", "message": "La carpeta destino ya existe. No se copiará hasta corregir."})
                    _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_tag)
                    continue
                except PermissionError as e:
                    detail = f"Sin permisos para crear la carpeta destino. {type(e).__name__}: {e}"
                    _record_oi_error(audit, operation_id, oi_tag=oi_tag, code="DESTINO_PERMISOS", detail=detail)
                    _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_tag)
                    continue
                except Exception as e:
                    detail = f"No se pudo crear la carpeta destino. {type(e).__name__}: {e}"
                    _record_oi_error(audit, operation_id, oi_tag=oi_tag, code="DESTINO_NO_CREADO", detail=detail)
                    _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_tag)
                    continue

                no_conf_set = no_conf_map.get(oi_tag, set())
                raw_conforme_set = conformes_map.get(oi_tag) if use_conforme_allowlist else None
                conforme_set = _expand_conforme_set(raw_conforme_set) if raw_conforme_set is not None else None

                # tracking por OI (duplicados/faltantes)
                serie_files: dict[str, list[str]] = {}
                series_present: set[str] = set()
                dup_primary: dict[str, str] = {}


                # 1) Primera pasada: contar PDFs (para poder emitir progreso fino)
                try:
                    with os.scandir(src_folder) as it:
                        for entry in it:
                            if cancel_token.is_cancelled():
                                _emit(operation_id, {"type": "status", "stage": "cancelado", "message": "Cancelado por el usuario"})
                                return
                            try:
                                if not entry.is_file(follow_symlinks=False):
                                    continue
                                if entry.name.lower().endswith(".pdf"):
                                    total_pdfs_in_oi += 1
                                    # contruir mapa serie -> archivos y set de series presentes
                                    serie0 = _series_from_filename(entry.name)
                                    if serie0:
                                        series_present.add(serie0)
                                        serie_files.setdefault(serie0, []).append(entry.name)
                            except Exception:
                                continue
                except PermissionError as e:
                    detail = f"Sin permisos para listar la carpeta origen. {type(e).__name__}: {e}"
                    _record_oi_error(audit, operation_id, oi_tag=oi_tag, code="LISTADO_PERMISOS", detail=detail)
                    _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_tag)
                    continue
                except Exception as e:
                    detail = f"No se pudo listar la carpeta origen. {type(e).__name__}: {e}"
                    _record_oi_error(audit, operation_id, oi_tag=oi_tag, code="LISTADO_ERROR", detail=detail)
                    _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_tag)
                    continue

                # Detectar duplicados (misma serie repetida en la carpeta)
                dup_series = {s: names for s, names in serie_files.items() if len(names) > 1}
                if dup_series:
                    for s, names in dup_series.items():
                        chosen = sorted(names, key=lambda x: x.lower())[0] # determinístico
                        dup_primary[s] = chosen
                        audit["series_duplicadas"].append({"oi": oi_tag, "serie": s, "files": names})
                    _record_oi_warn(
                        operation_id,
                        oi_tag=oi_tag,
                        code="SERIE_DUPLICADA",
                        detail=f"Se detectaron {len(dup_series)} serie(s) duplicada(s) en la carpeta. Se copiará solo 1 PDF por serie.",
                    )

                # Detectar faltantes SOLO si hay allowlist (MANIFIESTO -> series_conforme)
                # Nota: si no hay allowlist, no hay "lista esperada" confiable para marcar faltantes.
                if conforme_set is not None and conforme_set:
                    missing = sorted([s for s in conforme_set if s not in series_present], key=lambda x: x)
                    if missing:
                        audit["series_faltantes"].append({"oi": oi_tag, "count": len(missing), "series": missing[:50]})
                        audit["archivos"]["pdf_omitidos_no_encontrado"] += len(missing)
                        sample = ", ".join(missing[:6])
                        more = "" if len(missing) <= 6 else f" (+{len(missing) - 6} más)"
                        _record_oi_warn(
                            operation_id,
                            oi_tag=oi_tag,
                            code="SERIE_SIN_PDF",
                            detail=f"Faltan {len(missing)} serie(s) conforme(s) sin PDF en carpeta. Ej: {sample}{more}",
                        )
                        

                # Emite primer tick dentro de la OI (si hay PDFs)
                if total_pdfs_in_oi > 0:
                    _emit_progress(
                        operation_id,
                        i=i,
                        total_ois=total_ois,
                        oi_tag=oi_tag,
                        processed_in_oi=0,
                        total_in_oi=total_pdfs_in_oi,
                        message=f"{oi_tag}: iniciando copiado 0/{total_pdfs_in_oi} PDFs • OI {i}/{total_ois}",
                    )

                try:
                    processed_in_oi = 0
                    EMIT_EVERY = 25
                    with os.scandir(src_folder) as it:
                        for entry in it:
                            if cancel_token.is_cancelled():
                                _emit(operation_id, {"type": "status", "stage": "cancelado", "message": "Cancelado por el usuario"})
                                return
                            try:
                                if not entry.is_file(follow_symlinks=False):
                                    continue
                                if not entry.name.lower().endswith(".pdf"):
                                    omitted_nonpdf += 1
                                    continue
                            except Exception:
                                continue

                            detected_pdf += 1
                            processed_in_oi += 1
                            serie = _series_from_filename(entry.name)
                            if not serie:
                                omitted_nonpdf += 1
                                if total_pdfs_in_oi > 0 and (processed_in_oi % EMIT_EVERY == 0 or processed_in_oi == total_pdfs_in_oi):
                                    _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_tag, processed_in_oi=processed_in_oi, total_in_oi=total_pdfs_in_oi)
                                continue

                            # Omitir copias extra si la serie está duplicada (se copia solo el “primary”)
                            if serie in dup_primary and entry.name != dup_primary[serie]:
                                audit["archivos"]["pdf_omitidos_duplicados"] += 1
                                if verbose_events:
                                    _emit(operation_id, {"type": "file_skip", "oi": oi_tag, "serie": serie, "file": entry.name, "reason": "DUPLICADO"})
                                if total_pdfs_in_oi > 0 and (processed_in_oi % EMIT_EVERY == 0 or processed_in_oi == total_pdfs_in_oi):
                                    _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_tag, processed_in_oi=processed_in_oi, total_in_oi=total_pdfs_in_oi)
                                continue
                            
                            if conforme_set is not None:
                                if serie not in conforme_set:
                                    omitted_nc += 1
                                    if verbose_events:
                                        _emit(operation_id, {"type": "file_skip", "oi": oi_tag, "serie": serie, "reason": "NO_EN_MANIFIESTO"})
                                    if total_pdfs_in_oi > 0 and (processed_in_oi % EMIT_EVERY == 0 or processed_in_oi == total_pdfs_in_oi):
                                        _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_tag, processed_in_oi=processed_in_oi, total_in_oi=total_pdfs_in_oi)
                                    continue
                            elif serie in no_conf_set:
                                omitted_nc += 1
                                if verbose_events:
                                    _emit(operation_id, {"type": "file_skip", "oi": oi_tag, "serie": serie, "reason": "NO_CONFORME"})
                                if total_pdfs_in_oi > 0 and (processed_in_oi % EMIT_EVERY == 0 or processed_in_oi == total_pdfs_in_oi):
                                    _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_tag, processed_in_oi=processed_in_oi, total_in_oi=total_pdfs_in_oi)
                                continue

                            try:
                                shutil.copy2(str(entry.path), str(dest_folder / entry.name))
                                copied += 1
                                if verbose_events:
                                    _emit(operation_id, {"type": "file_ok", "oi": oi_tag, "serie": serie, "file": entry.name})
                            except Exception as e:
                                file_error_count += 1
                                _emit(operation_id, {"type": "file_error", "oi": oi_tag, "serie": serie, "file": entry.name, "message": f"Error copiando PDF. {type(e).__name__}: {e}"})
                                if total_pdfs_in_oi > 0 and (processed_in_oi % EMIT_EVERY == 0 or processed_in_oi == total_pdfs_in_oi):
                                    _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_tag, processed_in_oi=processed_in_oi, total_in_oi=total_pdfs_in_oi)
                                continue

                            if total_pdfs_in_oi > 0 and (processed_in_oi % EMIT_EVERY == 0 or processed_in_oi == total_pdfs_in_oi):
                                _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_tag, processed_in_oi=processed_in_oi, total_in_oi=total_pdfs_in_oi)
                except PermissionError as e:
                    detail = f"Sin permisos para leer la carpeta origen. {type(e).__name__}: {e}"
                    _record_oi_error(audit, operation_id, oi_tag=oi_tag, code="LECTURA_PERMISOS", detail=detail)
                    _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_tag)
                    continue
                except Exception as e:
                    detail = f"Error leyendo la carpeta origen. {type(e).__name__}: {e}"
                    _record_oi_error(audit, operation_id, oi_tag=oi_tag, code="LECTURA_ERROR", detail=detail)
                    _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_tag)
                    continue

                if file_error_count > 0:
                    detail = f"{file_error_count} archivo(s) con error de copia."
                    _record_oi_error(audit, operation_id, oi_tag=oi_tag, code="FILE_ERROR", detail=detail)
                else:
                    oi_ok = True

                audit["archivos"]["pdf_detectados"] += detected_pdf
                audit["archivos"]["pdf_copiados"] += copied
                audit["archivos"]["pdf_omitidos_no_conforme"] += omitted_nc
                audit["archivos"]["archivos_no_pdf_omitidos"] += omitted_nonpdf
                if oi_ok:
                    audit["ois_ok"] += 1

                _emit(operation_id, {"type": "oi_done", "oi": oi_tag, "copiados": copied, "omitidos_no_conforme": omitted_nc, "pdf_detectados": detected_pdf})

                # Progreso por OI (cierra al valor exacto i/total_ois)
                _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_tag, message=f"Carpetas procesadas {i}/{total_ois}")
            finally:
                if dest_created and not oi_ok:
                    _cleanup_dest_folder(dest_folder)
            
        # 4) Procesar lotes GASELAG (match por serie BD_/CD_)
        if gaselag_keys:
            gaselag_folders = _find_gaselag_folders_in_origins(set(gaselag_keys), rutas_origen)
            base_count = len(oi_tags)
            for gi, serie_key in enumerate(gaselag_keys, start=1):
                if cancel_token.is_cancelled():
                    _emit(operation_id, {"type": "status", "stage": "cancelado", "message": "Cancelado por el usuario"})
                    return
                
                i = base_count + gi
                serie_sources = gaselag_series_map.get(serie_key, [])
                serie_label = _gaselag_display_name(serie_sources[0]) if serie_sources else serie_key
                oi_label = f"GASELAG:{serie_label}"
                oi_key = "GASELAG"

                _emit(operation_id, {"type": "status", "stage": "oi", "oi": oi_label, "message": f"Buscando carpeta Gaselag para {serie_label} ({i}/{total_ois})"})

                folders = gaselag_folders.get(serie_key, [])
                if len(folders) == 0:
                    audit["ois_faltantes"].append({"oi": oi_label, "detalle": "No se encontró carpeta de lote Gaselag en rutas origen."})
                    _emit(operation_id, {"type": "oi_warn", "oi": oi_label, "code": "GASELAG_SIN_CARPETA", "message": "No se encontró carpeta Gaselag para la serie en los orígenes."})
                    _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_label)
                    continue
                if len(folders) > 1:
                    audit["ois_duplicadas"].append({"oi": oi_label, "carpetas": [str(p) for p in folders]})
                    _emit(operation_id, {"type": "oi_warn", "oi": oi_label, "code": "GASELAG_CARPETA_DUPLICADA", "message": "Se encontraron múltiples carpetas Gaselag para la misma serie. No se copiará hasta corregir."})
                    _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_label)
                    continue

                src_folder = folders[0]
                dest_folder = Path(ruta_destino) / src_folder.name
                if dest_folder.exists():
                    audit["destinos_duplicados"].append({"oi": oi_label, "destino": str(dest_folder)})
                    _emit(operation_id, {"type": "oi_warn", "oi": oi_label, "code": "DESTINO_DUPLICADO", "message": "La carpeta destino ya existe. No se copiará hasta corregir."})
                    _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_label)
                    continue

                dest_created = False
                oi_ok = False
                file_error_count = 0
                copied = 0
                omitted_nc = 0
                detected_pdf = 0
                omitted_nonpdf = 0
                total_pdfs_in_oi = 0

                try:
                    try:
                        dest_folder.mkdir(parents=True, exist_ok=False)
                        dest_created = True
                    except FileExistsError:
                        audit["destinos_duplicados"].append({"oi": oi_label, "destino": str(dest_folder)})
                        _emit(operation_id, {"type": "oi_warn", "oi": oi_label, "code": "DESTINO_DUPLICADO", "message": "La carpeta destino ya existe. No se copiará hasta corregir."})
                        _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_label)
                        continue
                    except PermissionError as e:
                        detail = f"Sin permisos para crear la carpeta destino. {type(e).__name__}: {e}"
                        _record_oi_error(audit, operation_id, oi_tag=oi_label, code="DESTINO_PERMISOS", detail=detail)
                        _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_label)
                        continue
                    except Exception as e:
                        detail = f"No se pudo crear la carpeta destino. {type(e).__name__}: {e}"
                        _record_oi_error(audit, operation_id, oi_tag=oi_label, code="DESTINO_ERROR", detail=detail)
                        _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_label)
                        continue

                    no_conf_set = no_conf_map.get(oi_key, set())
                    raw_conforme_set = conformes_map.get(oi_key) if use_conforme_allowlist else None
                    conforme_set = _expand_conforme_set(raw_conforme_set) if raw_conforme_set is not None else None

                    # Gaselag: duplicados y faltantes por serie (PDF individual)
                    serie_files: dict[str, list[str]] = {}
                    series_present: set[str] = set()
                    dup_primary: dict[str, str] = {}

                    # 1) Primera pasada: contar PDFs
                    try:
                        with os.scandir(src_folder) as it:
                            for entry in it:
                                if cancel_token.is_cancelled():
                                    _emit(operation_id, {"type": "status", "stage": "cancelado", "message": "Cancelado por el usuario"})
                                    return
                                try:
                                    if not entry.is_file(follow_symlinks=False):
                                        continue
                                    if entry.name.lower().endswith(".pdf"):
                                        total_pdfs_in_oi += 1
                                        serie0 = _series_from_filename(entry.name)
                                        if serie0:
                                            series_present.add(serie0)
                                            serie_files.setdefault(serie0, []).append(entry.name)
                                except Exception:
                                    continue
                    except PermissionError as e:
                        detail = f"Sin permisos para listar la carpeta origen. {type(e).__name__}: {e}"
                        _record_oi_error(audit, operation_id, oi_tag=oi_label, code="LISTADO_PERMISOS", detail=detail)
                        _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_label)
                        continue
                    except Exception as e:
                        detail = f"No se pudo listar la carpeta origen. {type(e).__name__}: {e}"
                        _record_oi_error(audit, operation_id, oi_tag=oi_label, code="LISTADO_ERROR", detail=detail)
                        _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_label)
                        continue

                    dup_series = {s: names for s, names in serie_files.items() if len(names) > 1}
                    if dup_series:
                        for s, names in dup_series.items():
                            chosen = sorted(names, key=lambda x: x.lower())[0]
                            dup_primary[s] = chosen
                            audit["series_duplicadas"].append({"oi": oi_label, "serie": s, "files": names})
                        _record_oi_warn(
                            operation_id,
                            oi_tag=oi_label,
                            code="SERIE_DUPLICADA",
                            detail=f"Se detectaron {len(dup_series)} serie(s) duplicada(s) en la carpeta. Se copiará solo 1 PDF por serie.",
                        )

                    # Faltantes: series esperadas (conformes) sin PDF presente en carpeta OI
                    if conforme_set is not None and conforme_set:
                        missing = sorted([s for s in conforme_set if s not in series_present], key=lambda x: x)
                        if missing:
                            audit["series_faltantes"].append({"oi": oi_label, "count": len(missing), "series": missing[:50]})
                            audit["archivos"]["pdf_omitidos_no_encontrado"] += len(missing)
                            sample = ", ".join(missing[:6])
                            more = "" if len(missing) <= 6 else f" (+{len(missing) - 6} m?s)"
                            _record_oi_warn(
                                operation_id,
                                oi_tag=oi_label,
                                code="SERIE_SIN_PDF",
                                detail=f"Faltan {len(missing)} serie(s) conforme(s) sin PDF en carpeta. Ej: {sample}{more}",
                            )

                    if total_pdfs_in_oi > 0:
                        _emit_progress(
                            operation_id,
                            i=i,
                            total_ois=total_ois,
                            oi_tag=oi_label,
                            processed_in_oi=0,
                            total_in_oi=total_pdfs_in_oi,
                            message=f"{oi_label}: iniciando copiado 0/{total_pdfs_in_oi} PDFs • OI {i}/{total_ois}",
                        )
                    try:
                        processed_in_oi = 0
                        EMIT_EVERY = 25
                        with os.scandir(src_folder) as it:
                            for entry in it:
                                if cancel_token.is_cancelled():
                                    _emit(operation_id, {"type": "status", "stage": "cancelado", "message": "Cancelado por el usuario"})
                                    return
                                try:
                                    if not entry.is_file(follow_symlinks=False):
                                        continue
                                    if not entry.name.lower().endswith(".pdf"):
                                        omitted_nonpdf += 1
                                        continue
                                except Exception:
                                    continue

                                detected_pdf += 1
                                processed_in_oi += 1
                                serie = _series_from_filename(entry.name)
                                if not serie:
                                    omitted_nonpdf += 1
                                    if total_pdfs_in_oi > 0 and (processed_in_oi % EMIT_EVERY == 0 or processed_in_oi == total_pdfs_in_oi):
                                        _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_label, processed_in_oi=processed_in_oi, total_in_oi=total_pdfs_in_oi)
                                        continue

                                # Omitir copiar extra por duplicado
                                if serie in dup_primary and entry.name != dup_primary[serie]:
                                    audit["archivos"]["pdf_omitidos_duplicados"] += 1
                                    if verbose_events:
                                        _emit(operation_id, {"type": "file_skip", "oi": oi_label, "serie": serie, "file": entry.name, "reason": "DUPLICADO"})
                                    if total_pdfs_in_oi > 0 and (processed_in_oi % EMIT_EVERY == 0 or processed_in_oi == total_pdfs_in_oi):
                                        _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_label, processed_in_oi=processed_in_oi, total_in_oi=total_pdfs_in_oi)
                                    continue
                                    

                                if conforme_set is not None:
                                    if serie not in conforme_set:
                                        omitted_nc += 1
                                        if verbose_events:
                                            _emit(operation_id, {"type": "file_skip", "oi": oi_label, "serie": serie, "reason": "NO_EN_MANIFIESTO"})
                                        if total_pdfs_in_oi > 0 and (processed_in_oi % EMIT_EVERY == 0 or processed_in_oi == total_pdfs_in_oi):
                                            _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_label, processed_in_oi=processed_in_oi, total_in_oi=total_pdfs_in_oi)
                                        continue
                                elif serie in no_conf_set:
                                    omitted_nc += 1
                                    if verbose_events:
                                        _emit(operation_id, {"type": "file_skip", "oi": oi_label, "serie": serie, "reason": "NO_CONFORME"})
                                    if total_pdfs_in_oi > 0 and (processed_in_oi % EMIT_EVERY == 0 or processed_in_oi == total_pdfs_in_oi):
                                        _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_label, processed_in_oi=processed_in_oi, total_in_oi=total_pdfs_in_oi)
                                    continue

                                try:
                                    shutil.copy2(str(entry.path), str(dest_folder / entry.name))
                                    copied += 1
                                    if verbose_events:
                                        _emit(operation_id, {"type": "file_ok", "oi": oi_label, "serie": serie, "file": entry.name})
                                except Exception as e:
                                    file_error_count += 1
                                    _emit(operation_id, {"type": "file_error", "oi": oi_label, "serie": serie, "file": entry.name, "message": f"Error copiando PDF. {type(e).__name__}: {e}"})
                                    if total_pdfs_in_oi > 0 and (processed_in_oi % EMIT_EVERY == 0 or processed_in_oi == total_pdfs_in_oi):
                                        _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_label, processed_in_oi=processed_in_oi, total_in_oi=total_pdfs_in_oi)
                                    continue

                                if total_pdfs_in_oi > 0 and (processed_in_oi % EMIT_EVERY == 0 or processed_in_oi == total_pdfs_in_oi):
                                    _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_label, processed_in_oi=processed_in_oi, total_in_oi=total_pdfs_in_oi)
                    except PermissionError as e:
                        detail = f"Sin permisos para leer la carpeta origen. {type(e).__name__}: {e}"
                        _record_oi_error(audit, operation_id, oi_tag=oi_label, code="LECTURA_PERMISOS", detail=detail)
                        _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_label)
                        continue
                    except Exception as e:
                        detail = f"Error leyendo la carpeta origen. {type(e).__name__}: {e}"
                        _record_oi_error(audit, operation_id, oi_tag=oi_label, code="LECTURA_ERROR", detail=detail)
                        _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_label)
                        continue

                    if file_error_count > 0:
                        detail = f"{file_error_count} archivo(s) con error de copia."
                        _record_oi_error(audit, operation_id, oi_tag=oi_label, code="FILE_ERROR", detail=detail)
                    else:
                        oi_ok = True

                    audit["archivos"]["pdf_detectados"] += detected_pdf
                    audit["archivos"]["pdf_copiados"] += copied
                    audit["archivos"]["pdf_omitidos_no_conforme"] += omitted_nc
                    audit["archivos"]["archivos_no_pdf_omitidos"] += omitted_nonpdf
                    if oi_ok:
                        audit["ois_ok"] += 1

                    _emit(operation_id, {"type": "oi_done", "oi": oi_label, "copiados": copied, "omitidos_no_conforme": omitted_nc, "pdf_detectados": detected_pdf})
                    _emit_progress(operation_id, i=i, total_ois=total_ois, oi_tag=oi_label, message=f"Carpetas procesadas {i}/{total_ois}")
                finally:
                    if dest_created and not oi_ok:
                        _cleanup_dest_folder(dest_folder)

        _emit(operation_id, {"type": "complete", "message": "Copiado finalizado.", "audit": audit, "percent": 100.0})
    except Exception as e:
        _emit(operation_id, {"type": "error", "message": f"Fallo en copiado: {type(e).__name__}: {e}"})
    finally:
        try:
            progress_manager.finish(operation_id)
        except Exception:
            pass
        try:
            cancel_manager.remove(operation_id)
        except Exception:
            pass


@router.post("/copiar-conformes/start", response_model=Log02CopyConformesStartResponse)
def log02_copiar_conformes_start(payload: Log02CopyConformesStartRequest) -> Log02CopyConformesStartResponse:
    rutas_origen = [_clean_path(x) for x in (payload.rutas_origen or []) if _clean_path(x)]
    if not rutas_origen:
        raise HTTPException(status_code=400, detail="Debe ingresar al menos una ruta de origen.")
    if len(rutas_origen) > 20:
        rutas_origen = rutas_origen[:20]

    ruta_destino = _clean_path(payload.ruta_destino)
    if not ruta_destino:
        raise HTTPException(status_code=400, detail="Debe ingresar una ruta de destino.")
    
    # Validaciones rápida de accesos (mismas reglas que S2-T07)
    origen_checks = [_check_read_dir(x) for x in rutas_origen]
    if not all(o.existe and o.es_directorio and o.lectura for o in origen_checks):
        raise HTTPException(status_code=400, detail="Una o más rutas de origen no son accesibles (lectura).")
    dest_check = _check_dest_dir(ruta_destino)
    if not (dest_check.existe and dest_check.es_directorio and dest_check.lectura and dest_check.escritura):
        raise HTTPException(status_code=400, detail="La ruta destino no es accesible (lectura/escritura).")

    # Enforce allowlist si existe
    roots_abs = _allowed_roots_abs()
    for r in rutas_origen:
        _ensure_within_allowed_or_400(r, roots_abs, "Origen")
    _ensure_within_allowed_or_400(ruta_destino, roots_abs, "Destino")

    operation_id = str(uuid.uuid4())
    cancel_token = cancel_manager.create(operation_id)

    # Inicializa canal y lanza hilo
    progress_manager.ensure(operation_id)
    th = threading.Thread(
        target=_copy_conformes_worker,
        kwargs={
            "operation_id": operation_id,
            "cancel_token": cancel_token,
            "run_id": int(payload.run_id),
            "rutas_origen": rutas_origen,
            "ruta_destino": ruta_destino,
        },
        daemon=True,
    )
    th.start()
    return Log02CopyConformesStartResponse(operation_id=operation_id)


def _ndjson_stream(operation_id: str):
    sub = progress_manager.subscribe_existing(operation_id)
    if sub is None:
        # si no existe aún, lo creamos para poder devolver algo claro
        channel, history = progress_manager.subscribe(operation_id)
    else:
        channel, history = sub

    try:
        # 1) Primer chunk inmediato para que el navegador "abra" la respuesta (evita headers provisionales)
        # Incluimos padding para atravesar posibles buffers (gzip/proxy) que esperan mínimo tamaño.
        yield progress_manager.encode_event(
            {
                "type": "hello",
                "operation_id": operation_id,
                "ts": time.time(),
                "pad": " " * 2048,
            }
        )
        # enviar historial primero
        for ev in history:
            yield progress_manager.encode_event(ev)

        # Empujón inicial para que el navegador "abra" el stream (y evitar buffering por chunks pequeños)
        yield b"\n"

        # luego stream en vivo
        while True:
            try:
                item = channel.queue.get(timeout=1.0)
            except queue.Empty:
                # heartbeat: fuerza flush/chunks en Chrome y mantiene viva la conexión
                yield progress_manager.encode_event({"type": "ping", "ts": time.time()})
                continue
            
            if item is PM_SENTINEL:
                break
            if isinstance(item, dict):
                yield progress_manager.encode_event(item)

            try:
                item = channel.queue.get(timeout=1.0)
            except queue.Empty:
                # Heartbeat: mantiene viva la conexión y fuerza flush continuo.
                yield progress_manager.encode_event({"type": "ping", "ts": time.time()})
                continue

            if item is PM_SENTINEL:
                break
            if isinstance(item, dict):
                yield progress_manager.encode_event(item)
    finally:
        try:
            progress_manager.unsubscribe(operation_id)
        except Exception:
            pass


@router.get("/copiar-conformes/progress/{operation_id}")
def log02_copiar_conformes_progress(operation_id: str):
    # Headers anti-buffering: ayudan si hay proxies/middlewares (p.ej. GZip) que agrupan chunks.
    headers = {
        "Cache-Control": "no-cache, no-store, must-revalidate, no-transform",
        "Pragma": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
        # Si existe GZipMiddleware u otro compresor, esto suele evitar que bufferice el stream
        "Content-Encoding": "identity",
    }
    return StreamingResponse(
        _ndjson_stream(operation_id),
        media_type="application/x-ndjson; charset=utf-8",
        headers=headers,
    )


@router.get("/copiar-conformes/poll/{operation_id}", response_model=Log02CopyConformesPollResponse)
def log02_copiar_conformes_poll(operation_id: str, cursor: int = -1) -> Log02CopyConformesPollResponse:
    channel, events, cursor_next = progress_manager.get_events_since(operation_id, cursor)
    done = channel.closed
    summary = None
    if events:
        for ev in reversed(events):
            if ev.get("type") == "complete":
                summary = ev.get("audit")
                break
    if summary is None and done and channel.history:
        for ev in reversed(channel.history):
            if ev.get("type") == "complete":
                summary = ev.get("audit")
                break
    return Log02CopyConformesPollResponse(cursor_next=cursor_next, events=events, done=done, summary=summary)


@router.post("/copiar-conformes/cancel/{operation_id}")
def log02_copiar_conformes_cancel(operation_id: str) -> Dict[str, Any]:
    ok = cancel_manager.cancel(operation_id)
    return {"ok": bool(ok)}
