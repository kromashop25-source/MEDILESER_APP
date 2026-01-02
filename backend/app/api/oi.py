import csv
import re
from io import BytesIO, StringIO
from typing import List, Sequence, cast
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Header
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select, delete
from sqlalchemy import func, desc, update
from sqlalchemy.sql.elements import ColumnElement
from zoneinfo import ZoneInfo

from ..core.db import engine
from ..core.rbac import is_admin_like_for_oi, is_technician_role
from ..models import OI, Bancada, User
from ..schemas import (
    OICreate,
    OIRead,
    OIUpdate,
    OiWithBancadasRead,
    BancadaCreate,
    BancadaRead,
    BancadaUpdate,
    OIListResponse,
    OIListSummary,
    NumerationType,
)
from ..services.excel_service import generate_excel as build_excel_file
from ..services.rules_service import pma_to_pressure
from pydantic import BaseModel
from .auth import _SESSIONS, get_full_name_by_tech_number

router = APIRouter()

LOCK_EXPIRATION_MINUTES = 60
LOCK_EXPIRATION_DELTA = timedelta(minutes=LOCK_EXPIRATION_MINUTES)
DRAFT_CREATED_AT_MAX_AGE = timedelta(hours=48)
DRAFT_CREATED_AT_FUTURE_SKEW = timedelta(minutes=5)

def _get_session_from_header(authorization: str | None, *, allow_expired: bool = False) -> dict:
    """Recupera la sesión (usuario logueado) a partir del header Authorization."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Token requerido")

    token = authorization.split(" ", 1)[1]
    sess = _SESSIONS.get(token)
    if not sess:
        raise HTTPException(status_code=401, detail="Sesión inválida o expirada")

    expires_at = sess.get("expiresAt")
    try:
        if isinstance(expires_at, datetime) and expires_at < datetime.utcnow() and not allow_expired:
            raise HTTPException(status_code=401, detail="Sesión inválida o expirada")
    except HTTPException:
        raise
    except Exception:
        if not allow_expired:
            raise HTTPException(status_code=401, detail="Sesión inválida o expirada")

    # Normalizar claves user/username igual que en /auth/me
    if "username" not in sess and "user" in sess:
        sess["username"] = sess["user"]
    if "user" not in sess and "username" in sess:
        sess["user"] = sess["username"]

    # Banco obligatorio solo para usuarios técnicos.
    role = (sess.get("role") or "").lower()
    username = (sess.get("username") or sess.get("user") or "").lower()
    if is_technician_role(role, username):
        banco_id = sess.get("bancoId")
        try:
            banco_id_int = int(banco_id) if banco_id is not None else None
        except Exception:
            banco_id_int = None
        if banco_id_int is None or banco_id_int <= 0:
            raise HTTPException(status_code=403, detail="Debe seleccionar un banco para continuar")

    return sess

OI_CODE_RE = re.compile(r"^OI-\d{4}-\d{4}$")

def _oi_bancada_onclause() -> ColumnElement:
    return cast(ColumnElement, Bancada.oi_id == OI.id)

def _is_admin(sess: dict) -> bool:
    """Determina si la sesión corresponde a un usuario administrador."""
    username = (sess.get("username") or sess.get("user") or "").lower()
    role = (sess.get("role") or "").lower()
    return is_admin_like_for_oi(role, username)

def _normalize_numeration_type(raw: str | NumerationType | None) -> NumerationType:
    """
    Normaliza el tipo de numeración aceptando variantes con guión bajo
    (no_correlativo) y devolviendo siempre el enum oficial.
    """
    if raw is None:
        return NumerationType.correlativo
    try:
        enum_val = raw if isinstance(raw, NumerationType) else NumerationType(raw)
    except Exception:
        candidate = NumerationType._missing_(raw)
        if candidate is None:
            raise HTTPException(
                status_code=422,
                detail="Tipo de numeración inválido; use 'correlativo' o 'no correlativo'.",
            )
        enum_val = candidate
    return enum_val

def _ensure_oi_access(oi: OI, sess: dict) ->  None:
    """
    Veerifica que el usuario de la sesión pueda acceder a la OI.
    - admin: puede acceder a todas las OI.
    - resto: solo OI con mismo tech_number y banco_id que la sesión.
    """
    if _is_admin(sess):
        return

    tech_number = sess.get("techNumber")
    banco_id = sess.get("bancoId")

    if tech_number is not None and oi.tech_number != tech_number:
        raise HTTPException(status_code=403, detail="No tiene permisos sobre esta OI")
    if banco_id is not None and oi.banco_id != banco_id:
        raise HTTPException(status_code=403, detail="No tiene permisos sobre esta OI")

def _format_name_for_filename(full_name: str) -> str:
    """
    Normaliza 'Nombre Apellido' para usarlo en el nombre del archivo:
    - MAYÚSCULAS
    - solo letras y espacios
    - sin guiones entre nombre y apellido
    """
    base = full_name.strip().upper()
    # conservar solo letras (incluye acentos) y espacios
    cleaned = "".join(ch for ch in base if ch.isalpha() or ch == " ")
    # colapsar espacios múltiples
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned or "SIN NOMBRE"
    

def _normalize_dt(dt: datetime | None) -> datetime | None:
    """Remueve tzinfo para comparar marcas de tiempo en SQLite."""
    if dt is None:
        return None
    if dt.tzinfo is not None:
        return dt.replace(tzinfo=None)
    return dt

def _resolve_bancada_created_at(draft_dt: datetime | None) -> datetime:
    now = datetime.utcnow()
    if not draft_dt:
        return now
    normalized = _normalize_dt(draft_dt)
    if normalized is None:
        return now
    if normalized > now + DRAFT_CREATED_AT_FUTURE_SKEW:
        return now
    if normalized < now - DRAFT_CREATED_AT_MAX_AGE:
        return now
    return normalized


def _is_lock_active(oi: OI, now: datetime | None = None) -> bool:
    """Determina si el lock de la OI sigue vigente (no expirado)."""
    if oi.locked_by_user_id is None or oi.locked_at is None:
        return False
    current = now or datetime.utcnow()
    locked_at = _normalize_dt(oi.locked_at)
    if locked_at is None:
        return False
    return locked_at > current - LOCK_EXPIRATION_DELTA


def _clear_expired_lock(oi: OI, session: Session, now: datetime | None = None) -> None:
    if oi.locked_by_user_id is None or oi.locked_at is None:
        return
    if _is_lock_active(oi, now):
        return
    oi.locked_by_user_id = None
    oi.locked_at = None
    session.add(oi)


def _get_lock_state(
    oi: OI,
    session: Session,
    current_sess: dict | None = None,
) -> dict:
    """
    Devuelve el estado del lock (activo/expirado) y datos del dueЁo.
    - locked_by_user_id / locked_by_full_name solo se devuelven si el lock estЁ activo.
    - read_only_for_current_user: True si el admin ve un lock activo de un tЁ©cnico distinto.
    """
    now = datetime.utcnow()
    active = _is_lock_active(oi, now)
    owner = session.get(User, oi.locked_by_user_id) if oi.locked_by_user_id else None
    locked_by_full_name = None
    owner_role = None
    if owner:
        locked_by_full_name = f"{owner.first_name} {owner.last_name}".strip() or None
        owner_role = (owner.role or "").lower()

    locked_by_user_id = cast(int, owner.id) if owner else None
    locked_at = oi.locked_at if active else None
    if not active:
        locked_by_user_id = None
        locked_by_full_name = None

    read_only = False
    if (
        active
        and current_sess
        and _is_admin(current_sess)
        and is_technician_role(owner_role, owner.username if owner else None)
        and locked_by_user_id != current_sess.get("userId")
    ):
        read_only = True

    return {
        "active": active,
        "locked_by_user_id": locked_by_user_id,
        "locked_by_full_name": locked_by_full_name,
        "locked_at": locked_at,
        "owner": owner,
        "owner_role": owner_role,
        "read_only": read_only,
    }


def _ensure_lock_allows_write(oi: OI, sess: dict, session: Session) -> dict:
    """
    Valida que el usuario actual pueda modificar la OI segЁ́n el lock.
    - Si hay lock activo de otro usuario: 423.
    - Admin en lock de tЁ©cnico: 423 (solo lectura).
    Devuelve el lock_state calculado para reutilizar.
    """
    _clear_expired_lock(oi, session)
    lock_state = _get_lock_state(oi, session, sess)
    if not lock_state["active"]:
        return lock_state

    owner_id = lock_state["locked_by_user_id"]
    current_user_id = sess.get("userId")

    if _is_admin(sess):
        if owner_id is not None and owner_id != current_user_id and is_technician_role(
            lock_state.get("owner_role"),
            getattr(lock_state.get("owner"), "username", None),
        ):
            name = lock_state["locked_by_full_name"] or "otro usuario"
            raise HTTPException(
                status_code=423,
                detail=f"La OI estЁЎ siendo editada por {name}.",
            )
        return lock_state

    if owner_id is not None and owner_id != current_user_id:
        name = lock_state["locked_by_full_name"] or "otro usuario"
        raise HTTPException(
            status_code=423,
            detail=f"La OI estЁЎ siendo editada por {name}.",
        )
    return lock_state


def _touch_or_take_lock(oi: OI, sess: dict, lock_state: dict | None = None) -> None:
    """
    Refresca el lock si pertenece al usuario actual o lo toma si estaba libre/expirado.
    Se usa al guardar para extender la ventana de ediciЁn.
    """
    current_user_id = sess.get("userId")
    if current_user_id is None:
        return
    now = datetime.utcnow()
    state = lock_state or {"active": _is_lock_active(oi, now), "locked_by_user_id": oi.locked_by_user_id}
    if state.get("active") and state.get("locked_by_user_id") == current_user_id:
        oi.locked_at = now
    elif not state.get("active"):
        oi.locked_by_user_id = current_user_id
        oi.locked_at = now

def _recalc_oi_saved_at(session: Session, oi: OI) -> None:
    if oi.id is None:
        return
    oi_id_col = cast(ColumnElement, Bancada.oi_id)
    max_saved_at = session.exec(
        select(func.max(Bancada.saved_at)).where(oi_id_col == oi.id)
    ).one()
    oi.saved_at = max_saved_at

def _release_user_locks(session: Session, user_id: int | None) -> None:
    if user_id is None:
        return
    session.exec(
        update(OI)
        .where(cast(ColumnElement, OI.locked_by_user_id) == user_id)
        .values(locked_by_user_id=None, locked_at=None)
    )

def _parse_date(date_str: str | None) -> datetime | None:
    """
    Parsea una fecha en formato YYYY-MM-DD desde la querystring.
    Devuelve datetime a medianoche; lanza 400 si el formato es inválido.
    """
    if not date_str:
        return None
    try:
        return datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="Formato de fecha inválido; use YYYY-MM-DD",
        )

def _build_oi_filters(
    session: Session,
    sess: dict,
    q: str | None,
    date_from: str | None,
    date_to: str | None,
    responsable_tech_number: int | None,
) -> tuple[list[ColumnElement], set[int] | None]:
    conditions: list[ColumnElement] = []
    oi_id_col: ColumnElement = cast(ColumnElement, OI.id)
    oi_code_col: ColumnElement = cast(ColumnElement, OI.code)
    oi_tech_number_col: ColumnElement = cast(ColumnElement, OI.tech_number)
    oi_banco_id_col: ColumnElement = cast(ColumnElement, OI.banco_id)

    tech_number = sess.get("techNumber")
    banco_id = sess.get("bancoId")
    is_admin = _is_admin(sess)

    if not is_admin:
        if tech_number is not None:
            conditions.append(oi_tech_number_col == tech_number)
        if banco_id is not None:
            conditions.append(oi_banco_id_col == banco_id)

    start_dt = _parse_date(date_from)
    end_dt = _parse_date(date_to)
    if start_dt:
        conditions.append(OI.created_at >= start_dt)  # type: ignore[arg-type]
    if end_dt:
        end_dt_plus = end_dt + timedelta(days=1)
        conditions.append(OI.created_at < end_dt_plus)  # type: ignore[arg-type]

    if responsable_tech_number is not None:
        try:
            resp_tech = int(responsable_tech_number)
        except Exception:
            raise HTTPException(status_code=400, detail="responsable_tech_number inválido")
        if resp_tech > 0:
            conditions.append(oi_tech_number_col == resp_tech)

    search = (q or "").strip()
    if not search:
        return conditions, None

    code_conditions = list(conditions)
    code_conditions.append(oi_code_col.ilike(f"%{search}%"))
    code_stmt = select(OI.id)
    if code_conditions:
        code_stmt = code_stmt.where(*code_conditions)
    code_ids = set(session.exec(code_stmt).all())

    medidor_ids: set[int] = set()
    search_lc = search.lower()
    medidor_stmt = (
        select(Bancada.oi_id, Bancada.medidor, Bancada.rows_data)
        .join(OI, _oi_bancada_onclause())
    )
    if conditions:
        medidor_stmt = medidor_stmt.where(*conditions)
    for oi_id, medidor, rows_data in session.exec(medidor_stmt).all():
        if _medidor_matches(search_lc, medidor, rows_data):
            medidor_ids.add(int(oi_id))

    matched_ids = code_ids | medidor_ids
    return conditions, matched_ids


def _row_medidor_value(row: object) -> str:
    if row is None:
        return ""
    if isinstance(row, dict):
        value = row.get("medidor")
    else:
        value = getattr(row, "medidor", None)
    if value is None:
        return ""
    return str(value).strip()


def _medidor_matches(search_lc: str, medidor: str | None, rows_data: Sequence[object] | None) -> bool:
    if medidor:
        if search_lc in str(medidor).strip().lower():
            return True
    if not rows_data:
        return False
    for row in rows_data:
        value = _row_medidor_value(row)
        if value and search_lc in value.lower():
            return True
    return False


def _build_oi_read(
    oi: OI,
    session: Session | None = None,
    current_sess: dict | None = None,
    lock_state: dict | None = None,
    medidores_usuario: int = 0,
    medidores_total_code: int = 0,
) -> OIRead:
    full_name = get_full_name_by_tech_number(oi.tech_number) or ""
    oi_id_int = cast(int, oi.id)
    numeration_type = _normalize_numeration_type(
        oi.numeration_type.value if isinstance(oi.numeration_type, NumerationType) else str(oi.numeration_type)
    )
    lock_state = lock_state or (_get_lock_state(oi, session, current_sess) if session else None)
    locked_by_user_id = lock_state["locked_by_user_id"] if lock_state else None
    locked_by_full_name = lock_state["locked_by_full_name"] if lock_state else None
    locked_at = lock_state["locked_at"] if lock_state else None
    read_only_for_current_user = lock_state["read_only"] if lock_state else False
    return OIRead(
        id=oi_id_int,
        code=oi.code,
        q3=oi.q3,
        alcance=oi.alcance,
        pma=oi.pma,
        presion_bar=oi.presion_bar,
        banco_id=oi.banco_id,
        tech_number=oi.tech_number,
        numeration_type=numeration_type,
        created_at=oi.created_at,
        updated_at=oi.updated_at,
        saved_at=oi.saved_at,
        creator_name=full_name,
        locked_by_user_id=locked_by_user_id,
        locked_by_full_name=locked_by_full_name,
        locked_at=locked_at,
        read_only_for_current_user=read_only_for_current_user,
        medidores_usuario=medidores_usuario,
        medidores_total_code=medidores_total_code,
    )

def get_session():
    with Session(engine) as session:
        yield session

@router.post("", response_model=OIRead)
def create_oi(
    payload: OICreate,
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
):
    # Sesión obligatoria: el owner de la OI se toma SIEMPRE de la sesión,
    # ignorando banco_id y tech_number que vengan en el payload.
    sess = _get_session_from_header(authorization)
    tech_number = sess.get("techNumber")
    banco_id = sess.get("bancoId")
    if tech_number is None or banco_id is None:
        raise HTTPException(status_code=400, detail="Sesión inválida (techNumber/bancoId faltan)")
    # Validación estricta del patrón OI
    if not OI_CODE_RE.match(payload.code):
        raise HTTPException(status_code=422, detail="Código OI inválido (formato OI-####-YYYY).")
    presion = pma_to_pressure(payload.pma)
    if presion is None:
        raise HTTPException(status_code=422, detail="PMA inválido (solo se aceptan 10 o 16).")
    numeration_type = _normalize_numeration_type(payload.numeration_type)
    _release_user_locks(session, sess.get("userId"))
    now = datetime.utcnow()
    oi = OI(
        code=payload.code,
        q3=payload.q3,
        alcance=payload.alcance,
        pma=payload.pma,
        presion_bar=presion,
        banco_id=banco_id,
        tech_number=tech_number,
        numeration_type=numeration_type,
        created_at=now,
        updated_at=now,
    )
    session.add(oi)
    session.commit()
    session.refresh(oi)
    return _build_oi_read(oi, session, sess)

@router.put("/{oi_id:int}", response_model=OIRead)
def update_oi(
    oi_id: int,
    payload: OIUpdate,
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
):
    """
    Actualiza los valores técnicos de la OI (q3, alcance, pma) y recalcula la presión.
    El código de la OI no se modifica en esta operación.
    """
    oi = session.get(OI, oi_id)
    if not oi:
        raise HTTPException(status_code=404, detail="OI no encontrada")

    # Verificar ownership/rol antes de modificar
    sess = _get_session_from_header(authorization)
    _ensure_oi_access(oi, sess)
    lock_state = _ensure_lock_allows_write(oi, sess, session)

    # --- Control de concurrencia optimista ---
    # Si el updated_at que envía el cliente no coincide con el de la BD,
    # significa que alguien modificó la OI entre lectura y escritura.
    current_version = _normalize_dt(oi.updated_at or oi.created_at)
    payload_version = _normalize_dt(payload.updated_at)
    if current_version is not None and payload_version != current_version:
        raise HTTPException(
            status_code=409,
            detail="La OI fue modificada por otro usuario. Recargue antes de guardar.",
        )

    code_payload = payload.code.strip() if payload.code else None
    if code_payload and code_payload != oi.code:
        if not _is_admin(sess):
            raise HTTPException(
                status_code=403,
                detail="Solo administradores pueden modificar el código de OI.",
            )
        if not OI_CODE_RE.match(code_payload):
            raise HTTPException(
                status_code=422,
                detail="Código OI inválido (formato OI-####-YYYY).",
            )
        existing_id = session.exec(
            select(OI.id)
            .where(OI.code == code_payload)
            .where(OI.id != oi_id)
        ).first()
        if existing_id is not None:
            raise HTTPException(status_code=409, detail="OI ya existe.")
        oi.code = code_payload

    presion = pma_to_pressure(payload.pma)
    if presion is None:
        raise HTTPException(status_code=422, detail="PMA inválido (solo se aceptan 10 o 16).")
    numeration_type = _normalize_numeration_type(payload.numeration_type)

    now = datetime.utcnow()
    oi.q3 = payload.q3
    oi.alcance = payload.alcance
    oi.pma = payload.pma
    oi.presion_bar = presion
    oi.numeration_type = numeration_type
    oi.updated_at = now
    _touch_or_take_lock(oi, sess, lock_state)
    session.add(oi)
    session.commit()
    session.refresh(oi)
    return _build_oi_read(oi, session, sess)


@router.get("/{oi_id:int}", response_model=OIRead)
def get_oi(
    oi_id: int,
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
):
    oi = session.get(OI, oi_id)
    if not oi:
        raise HTTPException(status_code=404, detail="OI no encontrada")

    sess = _get_session_from_header(authorization)
    _ensure_oi_access(oi, sess)
    medidores_usuario_raw = session.exec(
        select(func.coalesce(func.sum(Bancada.rows), 0)).where(Bancada.oi_id == oi_id)
    ).one()
    medidores_usuario = int(medidores_usuario_raw or 0)
    medidores_total_code_raw = session.exec(
        select(func.coalesce(func.sum(Bancada.rows), 0))
        .select_from(OI)
        .join(Bancada, _oi_bancada_onclause(), isouter=True)
        .where(OI.code == oi.code)
    ).one()
    medidores_total_code = int(medidores_total_code_raw or 0)
    return _build_oi_read(
        oi,
        session,
        sess,
        medidores_usuario=medidores_usuario,
        medidores_total_code=medidores_total_code,
    )


@router.post("/{oi_id:int}/lock", response_model=OIRead)
def acquire_lock(
    oi_id: int,
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
):
    """
    Solicita o refresca el lock de edición de una OI.
    - Técnico: solo obtiene lock si está libre/expirado o ya es suyo.
    - Admin: no sobreescribe lock activo de técnico; si existe lo abre en lectura.
    """
    oi = session.get(OI, oi_id)
    if not oi:
        raise HTTPException(status_code=404, detail="OI no encontrada")

    sess = _get_session_from_header(authorization)
    _ensure_oi_access(oi, sess)
    _clear_expired_lock(oi, session)
    lock_state = _get_lock_state(oi, session, sess)
    is_admin = _is_admin(sess)
    current_user_id = sess.get("userId")

    if not is_admin:
        if not lock_state["active"] or lock_state["locked_by_user_id"] == current_user_id:
            now = datetime.utcnow()
            oi.locked_by_user_id = current_user_id
            oi.locked_at = now
            session.add(oi)
            session.commit()
            session.refresh(oi)
            lock_state = _get_lock_state(oi, session, sess)
            return _build_oi_read(oi, session, sess, lock_state)
        name = lock_state["locked_by_full_name"] or "otro usuario"
        raise HTTPException(status_code=423, detail=f"La OI está siendo editada por {name}.")

    # Admin
    if not lock_state["active"] or lock_state["locked_by_user_id"] == current_user_id:
        now = datetime.utcnow()
        oi.locked_by_user_id = current_user_id
        oi.locked_at = now
        session.add(oi)
        session.commit()
        session.refresh(oi)
        lock_state = _get_lock_state(oi, session, sess)
        return _build_oi_read(oi, session, sess, lock_state)

    # Lock activo de otro (técnico u otro admin): no se sobreescribe; admin queda en lectura.
    return _build_oi_read(oi, session, sess, lock_state)


@router.delete("/{oi_id:int}/lock")
def release_lock(
    oi_id: int,
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
    reason: str | None = None,
):
    oi = session.get(OI, oi_id)
    if not oi:
        raise HTTPException(status_code=404, detail="OI no encontrada")

    sess = _get_session_from_header(authorization)
    _ensure_oi_access(oi, sess)

    if oi.locked_by_user_id is None:
        return {"ok": True}

    is_admin = _is_admin(sess)
    current_user_id = sess.get("userId")
    if not is_admin and oi.locked_by_user_id != current_user_id:
        raise HTTPException(status_code=403, detail="No puede liberar el lock de otro usuario")

    oi.locked_by_user_id = None
    oi.locked_at = None
    session.add(oi)
    session.commit()
    return {"ok": True}


@router.post("/{oi_id:int}/close")
def close_oi(
    oi_id: int,
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
):
    """
    Libera el lock de una OI si pertenece al usuario autenticado.
    Endpoint idempotente: si ya está libre, devuelve OK.
    """
    oi = session.get(OI, oi_id)
    if not oi:
        raise HTTPException(status_code=404, detail="OI no encontrada")

    # allow_expired: best-effort para liberar locks aun si la sesión expiró
    sess = _get_session_from_header(authorization, allow_expired=True)
    _ensure_oi_access(oi, sess)

    if oi.locked_by_user_id is None:
        return {"ok": True}

    is_admin = _is_admin(sess)
    current_user_id = sess.get("userId")
    if not is_admin and oi.locked_by_user_id != current_user_id:
        raise HTTPException(status_code=403, detail="No puede liberar el lock de otro usuario")

    oi.locked_by_user_id = None
    oi.locked_at = None
    session.add(oi)
    session.commit()
    return {"ok": True}

class ResponsableOut(BaseModel):
    tech_number: int
    full_name: str

class BancadaRestorePayload(BaseModel):
    medidor: str | None = None
    estado: int = 0
    rows: int
    rows_data: List[dict] | None = None
    current_updated_at: datetime
    restore_updated_at: datetime | None = None
    restore_saved_at: datetime | None = None

class BancadaSavedAtUpdate(BaseModel):
    saved_at: datetime

class OISavedAtUpdate(BaseModel):
    saved_at: datetime
    propagate_to_bancadas: bool = True

class OIRestoreUpdatedAtPayload(BaseModel):
    current_updated_at: datetime
    restore_updated_at: datetime | None = None


@router.patch("/{oi_id:int}/saved_at", response_model=OIRead)
def update_oi_saved_at(
    oi_id: int,
    payload: OISavedAtUpdate,
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
):
    oi = session.get(OI, oi_id)
    if not oi:
        raise HTTPException(status_code=404, detail="OI no encontrada")

    sess = _get_session_from_header(authorization)
    if not _is_admin(sess):
        raise HTTPException(status_code=403, detail="Solo admin puede editar la fecha de guardado")

    if payload.propagate_to_bancadas:
        oi_id_col = cast(ColumnElement, Bancada.oi_id)
        session.exec(
            update(Bancada)
            .where(oi_id_col == oi_id)
            .values(saved_at=payload.saved_at)
        )
        session.flush()

    _recalc_oi_saved_at(session, oi)
    oi.updated_at = datetime.utcnow()
    session.add(oi)
    session.commit()
    session.refresh(oi)
    return _build_oi_read(oi, session, sess)

@router.patch("/{oi_id:int}/restore-updated-at", response_model=OIRead)
def restore_oi_updated_at(
    oi_id: int,
    payload: OIRestoreUpdatedAtPayload,
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
):
    oi = session.get(OI, oi_id)
    if not oi:
        raise HTTPException(status_code=404, detail="OI no encontrada")

    sess = _get_session_from_header(authorization)
    _ensure_oi_access(oi, sess)
    _ensure_lock_allows_write(oi, sess, session)

    current_version = _normalize_dt(oi.updated_at or oi.created_at)
    payload_version = _normalize_dt(payload.current_updated_at)
    if current_version is not None and payload_version != current_version:
        raise HTTPException(
            status_code=409,
            detail="La OI fue modificada por otro usuario. Recargue antes de guardar.",
        )

    oi.updated_at = payload.restore_updated_at
    session.add(oi)
    session.commit()
    session.refresh(oi)
    return _build_oi_read(oi, session, sess)


@router.get("/responsables", response_model=List[ResponsableOut])
def list_responsables(
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
):
    """
    Devuelve lista de técnicos para poblar el filtro 'Responsable'.
    - Admin: ve todos los técnicos activos.
    - Técnico/otros: devuelve solo su propio usuario (si aplica).
    """
    sess = _get_session_from_header(authorization)
    is_admin = _is_admin(sess)

    if not is_admin:
        tech_number = sess.get("techNumber")
        if not tech_number:
            return []
        name = get_full_name_by_tech_number(int(tech_number)) or ""
        return [ResponsableOut(tech_number=int(tech_number), full_name=name)]

    role_col = func.lower(User.role)
    stmt = (
        select(User)
        .where(User.is_active == True)  # noqa: E712
        .where(User.tech_number > 0)
        .where(role_col.in_(["technician", "user", "tecnico", "técnico"]))
        .order_by(User.first_name, User.last_name)
    )

    users = session.exec(stmt).all()
    out: list[ResponsableOut] = []
    for u in users:
        full_name = f"{u.first_name} {u.last_name}".strip()
        out.append(ResponsableOut(tech_number=u.tech_number, full_name=full_name))
    return out


@router.get("", response_model=OIListResponse)
def list_oi(
    q: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int = 20,
    offset: int = 0,
    responsable_tech_number: int | None = None,
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
):
    """
    Listado de OI con visibilidad por rol + filtros:
    - admin: ve todas las OI
    - resto: solo sus OI (mismo tech_number y banco_id)
    Filtros:
    - q: búsqueda parcial por código de OI (case-insensitive)
    - date_from, date_to: rango de fechas (creación) en formato YYYY-MM-DD
    Paginación:
    - limit / offset, devolviendo también el total de registros.
    """
    sess = _get_session_from_header(authorization)
    is_admin = _is_admin(sess)

    # Normalizar y acotar limit
    if limit <= 0:
        limit = 20
    if limit > 100:
        limit = 100

    oi_id_col: ColumnElement = cast(ColumnElement, OI.id)
    oi_code_col: ColumnElement = cast(ColumnElement, OI.code)
    bancada_oi_id_col: ColumnElement = cast(ColumnElement, Bancada.oi_id)
    conditions, matched_ids = _build_oi_filters(
        session,
        sess,
        q,
        date_from,
        date_to,
        responsable_tech_number,
    )
    if matched_ids is not None:
        if not matched_ids:
            return OIListResponse(
                items=[],
                total=0,
                limit=limit,
                offset=offset,
                summary=OIListSummary(),
            )
        conditions = conditions + [oi_id_col.in_(list(matched_ids))]

    # --- Consulta base con filtros ---
    base_stmt = select(OI)
    if conditions:
        base_stmt = base_stmt.where(*conditions)

    # Total para la paginación
    count_stmt = select(func.count()).select_from(OI)
    if conditions:
        count_stmt = count_stmt.where(*conditions)
    total = session.exec(count_stmt).one()

    sum_stmt = select(func.coalesce(func.sum(Bancada.rows), 0)).select_from(OI).join(
        Bancada, _oi_bancada_onclause(), isouter=True
    )
    if conditions:
        sum_stmt = sum_stmt.where(*conditions)
    medidores_resultado_raw = session.exec(sum_stmt).one()
    medidores_resultado = int(medidores_resultado_raw or 0)

    distinct_stmt = select(func.count(func.distinct(OI.code))).select_from(OI)
    if conditions:
        distinct_stmt = distinct_stmt.where(*conditions)
    oi_unicas_raw = session.exec(distinct_stmt).one()
    oi_unicas = int(oi_unicas_raw or 0)

    totals_by_code = (
        select(
            oi_code_col.label("code"),
            func.coalesce(func.sum(Bancada.rows), 0).label("total_medidores"),
        )
        .select_from(OI)
        .join(Bancada, _oi_bancada_onclause(), isouter=True)
        .group_by(oi_code_col)
        .subquery()
    )
    filtered_codes = select(func.distinct(oi_code_col).label("code")).select_from(OI)
    if conditions:
        filtered_codes = filtered_codes.where(*conditions)
    filtered_codes = filtered_codes.subquery()
    sum_totals_stmt = select(func.coalesce(func.sum(totals_by_code.c.total_medidores), 0)).select_from(
        totals_by_code.join(filtered_codes, totals_by_code.c.code == filtered_codes.c.code)
    )
    medidores_total_oi_unicas_raw = session.exec(sum_totals_stmt).one()
    medidores_total_oi_unicas = int(medidores_total_oi_unicas_raw or 0)
    summary = OIListSummary(
        medidores_resultado=medidores_resultado,
        oi_unicas=oi_unicas,
        medidores_total_oi_unicas=medidores_total_oi_unicas,
    )

    # Ordenar por "más reciente":
    # usamos coalesce(updated_at, created_at) para considerar última modificación
    sort_expr = func.coalesce(OI.updated_at, OI.created_at).desc()
    data_stmt = (
        base_stmt
        .order_by(sort_expr, desc(oi_id_col))
        .limit(limit)
        .offset(offset)
    )

    rows = session.exec(data_stmt).all()
    page_oi_ids = [cast(int, oi.id) for oi in rows if oi.id is not None]
    page_codes = list({oi.code for oi in rows if oi.code})

    medidores_usuario_by_id: dict[int, int] = {}
    if page_oi_ids:
        user_stmt = (
            select(Bancada.oi_id, func.coalesce(func.sum(Bancada.rows), 0))
            .where(bancada_oi_id_col.in_(page_oi_ids))
            .group_by(bancada_oi_id_col)
        )
        for oi_id, total_rows in session.exec(user_stmt).all():
            medidores_usuario_by_id[int(oi_id)] = int(total_rows or 0)

    medidores_total_by_code: dict[str, int] = {}
    if page_codes:
        total_stmt = (
            select(OI.code, func.coalesce(func.sum(Bancada.rows), 0))
            .select_from(OI)
            .join(Bancada, _oi_bancada_onclause(), isouter=True)
            .where(oi_code_col.in_(page_codes))
            .group_by(oi_code_col)
        )
        for code, total_rows in session.exec(total_stmt).all():
            medidores_total_by_code[str(code)] = int(total_rows or 0)

    items = [
        _build_oi_read(
            oi,
            session,
            sess,
            medidores_usuario=medidores_usuario_by_id.get(cast(int, oi.id), 0),
            medidores_total_code=medidores_total_by_code.get(oi.code, 0),
        )
        for oi in rows
    ]

    return OIListResponse(
        items=items,
        total=total,
        limit=limit,
        offset=offset,
        summary=summary,
    )


@router.get("/export/csv")
def export_oi_csv(
    q: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    responsable_tech_number: int | None = None,
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
):
    sess = _get_session_from_header(authorization)
    if not _is_admin(sess):
        raise HTTPException(status_code=403, detail="No autorizado")

    def format_dt(value: datetime | None) -> str:
        if not value:
            return ""
        return value.strftime("%d/%m/%Y %H:%M")

    oi_id_col: ColumnElement = cast(ColumnElement, OI.id)
    oi_code_col: ColumnElement = cast(ColumnElement, OI.code)
    bancada_oi_id_col: ColumnElement = cast(ColumnElement, Bancada.oi_id)

    conditions, matched_ids = _build_oi_filters(
        session,
        sess,
        q,
        date_from,
        date_to,
        responsable_tech_number,
    )
    if matched_ids is not None:
        if not matched_ids:
            output = StringIO()
            writer = csv.writer(output)
            writer.writerow(
                [
                    "ID",
                    "OI",
                    "Medidores",
                    "Q3",
                    "Alcance",
                    "PMA",
                    "Banco",
                    "Técnico",
                    "Responsable",
                    "Creación",
                    "Guardado",
                    "Últ. mod.",
                ]
            )
            csv_bytes = output.getvalue().encode("utf-8-sig")
            output.close()
            headers = {
                "Content-Disposition": f'attachment; filename="oi_list_{datetime.utcnow().strftime("%Y%m%d_%H%M")}.csv"'
            }
            return StreamingResponse(
                BytesIO(csv_bytes),
                media_type="text/csv; charset=utf-8",
                headers=headers,
            )
        conditions = conditions + [oi_id_col.in_(list(matched_ids))]

    base_stmt = select(OI)
    if conditions:
        base_stmt = base_stmt.where(*conditions)

    sort_expr = func.coalesce(OI.updated_at, OI.created_at).desc()
    data_stmt = base_stmt.order_by(sort_expr, desc(oi_id_col))
    rows = session.exec(data_stmt).all()

    oi_ids = [cast(int, oi.id) for oi in rows if oi.id is not None]
    codes = list({oi.code for oi in rows if oi.code})

    medidores_usuario_by_id: dict[int, int] = {}
    if oi_ids:
        user_stmt = (
            select(Bancada.oi_id, func.coalesce(func.sum(Bancada.rows), 0))
            .where(bancada_oi_id_col.in_(oi_ids))
            .group_by(bancada_oi_id_col)
        )
        for oi_id, total_rows in session.exec(user_stmt).all():
            medidores_usuario_by_id[int(oi_id)] = int(total_rows or 0)

    medidores_total_by_code: dict[str, int] = {}
    if codes:
        total_stmt = (
            select(OI.code, func.coalesce(func.sum(Bancada.rows), 0))
            .select_from(OI)
            .join(Bancada, _oi_bancada_onclause(), isouter=True)
            .where(oi_code_col.in_(codes))
            .group_by(oi_code_col)
        )
        for code, total_rows in session.exec(total_stmt).all():
            medidores_total_by_code[str(code)] = int(total_rows or 0)

    output = StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "ID",
            "OI",
            "Medidores",
            "Q3",
            "Alcance",
            "PMA",
            "Banco",
            "Técnico",
            "Responsable",
            "Creación",
            "Guardado",
            "Últ. mod.",
        ]
    )
    for oi in rows:
        medidores_usuario = medidores_usuario_by_id.get(cast(int, oi.id), 0)
        medidores_total = medidores_total_by_code.get(oi.code, 0)
        medidores_display = f"{medidores_usuario} / {medidores_total}"
        responsable = get_full_name_by_tech_number(oi.tech_number) or ""
        writer.writerow(
            [
                oi.id or "",
                oi.code or "",
                medidores_display,
                oi.q3 or "",
                oi.alcance or "",
                oi.pma or "",
                oi.banco_id or "",
                oi.tech_number or "",
                responsable,
                format_dt(oi.created_at),
                format_dt(oi.saved_at),
                format_dt(oi.updated_at),
            ]
        )
    csv_bytes = output.getvalue().encode("utf-8-sig")
    output.close()

    headers = {
        "Content-Disposition": f'attachment; filename="oi_list_{datetime.utcnow().strftime("%Y%m%d_%H%M")}.csv"'
    }
    return StreamingResponse(
        BytesIO(csv_bytes),
        media_type="text/csv; charset=utf-8",
        headers=headers,
    )


@router.delete("/{oi_id:int}")
def delete_oi(
    oi_id: int,
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
):
    """ Elimina una OI y sus bacandas. Solo permitido para admin."""
    sess = _get_session_from_header(authorization)
    username = (sess.get("username") or sess.get("user") or "").lower()

    if username != "admin":
        raise HTTPException(status_code=403, detail="Solo admin puede eliminar OI")
    
    oi = session.get(OI, oi_id)
    if not oi:
        raise HTTPException(status_code=404, detail="OI no encontrada")
    
    # Borrar bancadas asociadas primero (bulk delete correcto)
    stmt = delete(Bancada).where(Bancada.oi_id == oi_id)  # type: ignore[arg-type]  # Pylance ve bool, pero es una expresión SQL
    session.exec(stmt)
    session.delete(oi)
    session.commit()
    return {"ok": True}


class ExcelRequest(BaseModel):
    password: str

def _dump_rows_data(rows):
    if rows is None:
        return None
    dumped = []
    for row in rows:
        dumped.append(row.model_dump(exclude_none=True) if hasattr(row, "model_dump") else row)
    return dumped


@router.post("/{oi_id:int}/bancadas", response_model=BancadaRead)
def add_bancada(
    oi_id: int,
    payload: BancadaCreate,
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
):
    oi = session.get(OI, oi_id)
    if not oi:
        raise HTTPException(status_code=404, detail="OI no encontrada")

    # El usuario solo puede agregar bancadas a sus propias OI (salvo admin)
    sess = _get_session_from_header(authorization)
    _ensure_oi_access(oi, sess)
    lock_state = _ensure_lock_allows_write(oi, sess, session)
    # Autonumeración segura
    existing_items = session.exec(
        select(Bancada.item).where(Bancada.oi_id == oi_id)
    ).all()
    next_item = (max([x or 0 for x in existing_items]) if existing_items else 0) + 1
    rows_data = _dump_rows_data(payload.rows_data)
    now = datetime.utcnow()
    created_at = _resolve_bancada_created_at(payload.draft_created_at)
    b = Bancada(
        oi_id=oi_id,
        item=next_item,
        medidor=payload.medidor,
        estado=payload.estado,
        rows=payload.rows,
        # Mini-planilla completa de la bancada (si el frontend la envía)
        rows_data=rows_data,
        created_at=created_at,
        updated_at=now,
        saved_at=now,
    )
    session.add(b)
    # marcar modificacion de la OI
    oi.updated_at = now
    _touch_or_take_lock(oi, sess, lock_state)
    session.add(oi)
    session.flush()
    _recalc_oi_saved_at(session, oi)
    session.commit()
    session.refresh(b)
    return BancadaRead.model_validate(b)

@router.get("/{oi_id:int}/with-bancadas", response_model=OiWithBancadasRead)
def get_oi_with_bancadas(
    oi_id: int,
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
):
    oi = session.get(OI, oi_id)
    if not oi:
        raise HTTPException(status_code=404, detail="OI no encontrada")

    sess = _get_session_from_header(authorization)
    _ensure_oi_access(oi, sess)
    lock_state = _get_lock_state(oi, session, sess)
    rows = list(session.exec(select(Bancada).where(Bancada.oi_id == oi_id)))
    rows.sort(key=lambda x: (x.item or 0))
    medidores_usuario_raw = session.exec(
        select(func.coalesce(func.sum(Bancada.rows), 0)).where(Bancada.oi_id == oi_id)
    ).one()
    medidores_usuario = int(medidores_usuario_raw or 0)
    medidores_total_code_raw = session.exec(
        select(func.coalesce(func.sum(Bancada.rows), 0))
        .select_from(OI)
        .join(Bancada, _oi_bancada_onclause(), isouter=True)
        .where(OI.code == oi.code)
    ).one()
    medidores_total_code = int(medidores_total_code_raw or 0)
    base = _build_oi_read(
        oi,
        session,
        sess,
        lock_state,
        medidores_usuario=medidores_usuario,
        medidores_total_code=medidores_total_code,
    )
    return OiWithBancadasRead(
        **base.model_dump(),
        bancadas=[BancadaRead.model_validate(b) for b in rows],
    )

# Alias para el frontend: /oi/{id}/full → mismo payload que /with-bancadas
@router.get("/{oi_id:int}/full", response_model=OiWithBancadasRead)
def get_oi_full(
    oi_id: int,
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
):
    return get_oi_with_bancadas(oi_id, session, authorization)

@router.put("/bancadas/{bancada_id}", response_model=BancadaRead)
def update_bancada(
    bancada_id: int,
    payload: BancadaUpdate,
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
):
    b = session.get(Bancada, bancada_id)
    if not b:
        raise HTTPException(status_code=404, detail="Bancada no encontrada")

    oi = session.get(OI, b.oi_id)
    if not oi:
        raise HTTPException(status_code=404, detail="OI no encontrada")

    sess = _get_session_from_header(authorization)
    _ensure_oi_access(oi, sess)
    lock_state = _ensure_lock_allows_write(oi, sess, session)
    current_version = _normalize_dt(b.updated_at or b.created_at)
    payload_version = _normalize_dt(payload.updated_at)
    if current_version is not None and payload_version != current_version:
        # Control optimista por bancada (actividad 19.1.6)
        raise HTTPException(
            status_code=409,
            detail="La bancada fue modificada por otro usuario. Recargue la OI y vuelva a intentar.",
        )

    now = datetime.utcnow()
    saved_at_was_null = b.saved_at is None
    b.medidor = payload.medidor
    b.estado = payload.estado or 0
    b.rows = payload.rows
    # Reemplazar grid por la versión más reciente que viene del modal.
    # Si el frontend aún no envía rows_data, esto quedará en None.
    b.rows_data = _dump_rows_data(payload.rows_data)
    # Marcar fecha/hora de última modificación de la bancada
    b.updated_at = now
    if saved_at_was_null:
        b.saved_at = now
    session.add(b)

    # Actualizar también la OI padre
    oi.updated_at = now
    _touch_or_take_lock(oi, sess, lock_state)
    session.add(oi)
    session.flush()
    if saved_at_was_null:
        _recalc_oi_saved_at(session, oi)
    session.commit()
    session.refresh(b)
    return BancadaRead.model_validate(b)

@router.patch("/bancadas/{bancada_id}/saved_at", response_model=BancadaRead)
def update_bancada_saved_at(
    bancada_id: int,
    payload: BancadaSavedAtUpdate,
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
):
    b = session.get(Bancada, bancada_id)
    if not b:
        raise HTTPException(status_code=404, detail="Bancada no encontrada")

    oi = session.get(OI, b.oi_id)
    if not oi:
        raise HTTPException(status_code=404, detail="OI no encontrada")

    sess = _get_session_from_header(authorization)
    if not _is_admin(sess):
        raise HTTPException(status_code=403, detail="Solo admin puede editar la fecha de guardado")
    _ensure_oi_access(oi, sess)
    lock_state = _ensure_lock_allows_write(oi, sess, session)

    now = datetime.utcnow()
    b.saved_at = payload.saved_at
    b.updated_at = now
    session.add(b)

    oi.updated_at = now
    _touch_or_take_lock(oi, sess, lock_state)
    session.add(oi)
    session.flush()
    _recalc_oi_saved_at(session, oi)
    session.commit()
    session.refresh(b)
    return BancadaRead.model_validate(b)

@router.put("/bancadas/{bancada_id}/restore", response_model=BancadaRead)
def restore_bancada(
    bancada_id: int,
    payload: BancadaRestorePayload,
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
):
    b = session.get(Bancada, bancada_id)
    if not b:
        raise HTTPException(status_code=404, detail="Bancada no encontrada")

    oi = session.get(OI, b.oi_id)
    if not oi:
        raise HTTPException(status_code=404, detail="OI no encontrada")

    sess = _get_session_from_header(authorization)
    _ensure_oi_access(oi, sess)
    _ensure_lock_allows_write(oi, sess, session)

    current_version = _normalize_dt(b.updated_at or b.created_at)
    payload_version = _normalize_dt(payload.current_updated_at)
    if current_version is not None and payload_version != current_version:
        raise HTTPException(
            status_code=409,
            detail="La bancada fue modificada por otro usuario. Recargue la OI y vuelva a intentar.",
        )

    b.medidor = payload.medidor
    b.estado = payload.estado or 0
    b.rows = payload.rows
    b.rows_data = _dump_rows_data(payload.rows_data)
    b.updated_at = payload.restore_updated_at
    b.saved_at = payload.restore_saved_at
    session.add(b)
    session.flush()
    _recalc_oi_saved_at(session, oi)
    session.add(oi)
    session.commit()
    session.refresh(b)
    return BancadaRead.model_validate(b)

@router.delete("/bancadas/{bancada_id}")
def delete_bancada(
    bancada_id: int,
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
):
    b = session.get(Bancada, bancada_id)
    if not b:
        raise HTTPException(status_code=404, detail="Bancada no encontrada")
    oi = session.get(OI, b.oi_id)
    if not oi:
        raise HTTPException(status_code=404, detail="OI no encontrada")

    sess = _get_session_from_header(authorization)
    _ensure_oi_access(oi, sess)
    lock_state = _ensure_lock_allows_write(oi, sess, session)
    now = datetime.utcnow()
    session.delete(b)
    oi.updated_at = now
    _touch_or_take_lock(oi, sess, lock_state)
    session.add(oi)
    session.flush()
    _recalc_oi_saved_at(session, oi)
    session.commit()
    return {"ok": True}

@router.post("/{oi_id:int}/excel")
def export_excel(
    oi_id: int,
    req: ExcelRequest,
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
):
    oi = session.get(OI, oi_id)
    if not oi:
        raise HTTPException(status_code=404, detail="OI no encontrada")

    sess = _get_session_from_header(authorization)
    _ensure_oi_access(oi, sess)
    bancadas = list(session.exec(select(Bancada).where(Bancada.oi_id == oi_id)))
    bancadas.sort(key=lambda x: (x.item or 0))
    # Si la plantilla no encuentra coincidencias exactas en E4/O4, devolver 422 (no 500)
    work_dt = oi.saved_at or oi.created_at or datetime.utcnow()
    try:
        data, _ = build_excel_file(oi, bancadas, password=req.password, work_dt=work_dt)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    # ----- Construcción del nombre de archivo según 18.1.4 -----
    # Patrón: OI-####-YYYY-nombre-apellido-YYYY-MM-DD.xlsx
    # La fecha corresponde a la fecha operativa de la OI (saved_at);
    # si aún no tiene saved_at, se usa created_at.
    if work_dt.tzinfo is None:
        dt_utc = work_dt.replace(tzinfo=timezone.utc)
    else:
        dt_utc = work_dt.astimezone(timezone.utc)
    dt_pe = dt_utc.astimezone(ZoneInfo("America/Lima"))
    date_str = dt_pe.strftime("%Y-%m-%d")

    # Nombre y apellido del técnico (creador del OI) usando el helper existente
    full_name = get_full_name_by_tech_number(oi.tech_number) or ""
    name_for_file = _format_name_for_filename(full_name)

    filename = f"{oi.code}-{name_for_file}-{date_str}.xlsx"
    return StreamingResponse(
        BytesIO(data),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )

@router.get("/{oi_id:int}/bancadas-list", response_model=List[BancadaRead])
def list_bancadas(
    oi_id: int,
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
):
    oi = session.get(OI, oi_id)
    if not oi:
        raise HTTPException(status_code=404, detail="OI no encontrada")

    sess = _get_session_from_header(authorization)
    _ensure_oi_access(oi, sess)

    rows = list(session.exec(select(Bancada).where(Bancada.oi_id == oi_id)))
    rows.sort(key=lambda x: (x.item or 0))
    # Asegura serialización consistente con el schema
    return [BancadaRead.model_validate(b) for b in rows]
