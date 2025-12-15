import re
from io import BytesIO
from typing import List, cast
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Header
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select, delete
from sqlalchemy import func, desc
from sqlalchemy.sql.elements import ColumnElement

from ..core.db import engine
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
    NumerationType,
)
from ..services.excel_service import generate_excel as build_excel_file
from ..services.rules_service import pma_to_pressure
from pydantic import BaseModel
from .auth import _SESSIONS, get_full_name_by_tech_number

router = APIRouter()

LOCK_EXPIRATION_MINUTES = 15
LOCK_EXPIRATION_DELTA = timedelta(minutes=LOCK_EXPIRATION_MINUTES)

def _get_session_from_header(authorization: str | None) -> dict:
    """Recupera la sesión (usuario logueado) a partir del header Authorization."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Token requerido")

    token = authorization.split(" ", 1)[1]
    sess = _SESSIONS.get(token)
    if not sess:
        raise HTTPException(status_code=401, detail="Token inválido")

    # Normalizar claves user/username igual que en /auth/me
    if "username" not in sess and "user" in sess:
        sess["username"] = sess["user"]
    if "user" not in sess and "username" in sess:
        sess["user"] = sess["username"]

    # Para usuarios no-admin, exigimos banco seleccionado para evitar operar sin contexto.
    role = (sess.get("role") or "").lower()
    username = (sess.get("username") or sess.get("user") or "").lower()
    is_admin = role == "admin" or username == "admin"
    if not is_admin:
        banco_id = sess.get("bancoId")
        try:
            banco_id_int = int(banco_id) if banco_id is not None else None
        except Exception:
            banco_id_int = None
        if banco_id_int is None or banco_id_int <= 0:
            raise HTTPException(status_code=403, detail="Debe seleccionar un banco para continuar")

    return sess

OI_CODE_RE = re.compile(r"^OI-\d{4}-\d{4}$")

def _is_admin(sess: dict) -> bool:
    """Determina si la sesión corresponde a un usuario administrador."""
    username = (sess.get("username") or sess.get("user") or "").lower()
    role = (sess.get("role") or "").lower()
    return role == "admin" or username == "admin"

def _normalize_numeration_type(raw: str | NumerationType | None) -> str:
    """
    Normaliza el tipo de numeración aceptando variantes con guión bajo
    (no_correlativo) y devolviendo siempre el valor oficial con espacio.
    """
    if raw is None:
        return NumerationType.correlativo.value
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
    return enum_val.value

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


def _is_lock_active(oi: OI, now: datetime | None = None) -> bool:
    """Determina si el lock de la OI sigue vigente (no expirado)."""
    if oi.locked_by_user_id is None or oi.locked_at is None:
        return False
    current = now or datetime.utcnow()
    locked_at = _normalize_dt(oi.locked_at)
    if locked_at is None:
        return False
    return locked_at > current - LOCK_EXPIRATION_DELTA


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
        and owner_role == "user"
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
    lock_state = _get_lock_state(oi, session, sess)
    if not lock_state["active"]:
        return lock_state

    owner_id = lock_state["locked_by_user_id"]
    current_user_id = sess.get("userId")

    if _is_admin(sess):
        if owner_id is not None and owner_id != current_user_id and lock_state["owner_role"] == "user":
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


def _build_oi_read(
    oi: OI,
    session: Session | None = None,
    current_sess: dict | None = None,
    lock_state: dict | None = None,
) -> OIRead:
    full_name = get_full_name_by_tech_number(oi.tech_number) or ""
    oi_id_int = cast(int, oi.id)
    numeration_type = (
        oi.numeration_type.value
        if isinstance(oi.numeration_type, NumerationType)
        else str(oi.numeration_type)
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
        creator_name=full_name,
        locked_by_user_id=locked_by_user_id,
        locked_by_full_name=locked_by_full_name,
        locked_at=locked_at,
        read_only_for_current_user=read_only_for_current_user,
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

@router.put("/{oi_id}", response_model=OIRead)
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


@router.get("/{oi_id}", response_model=OIRead)
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
    return _build_oi_read(oi, session, sess)


@router.post("/{oi_id}/lock", response_model=OIRead)
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


@router.delete("/{oi_id}/lock")
def release_lock(
    oi_id: int,
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
):
    oi = session.get(OI, oi_id)
    if not oi:
        raise HTTPException(status_code=404, detail="OI no encontrada")

    sess = _get_session_from_header(authorization)
    _ensure_oi_access(oi, sess)

    if oi.locked_by_user_id is None:
        return {"ok": True}

    if not _is_admin(sess) and oi.locked_by_user_id != sess.get("userId"):
        raise HTTPException(status_code=403, detail="No puede liberar el lock de otro usuario")

    oi.locked_by_user_id = None
    oi.locked_at = None
    session.add(oi)
    session.commit()
    return {"ok": True}

@router.get("", response_model=OIListResponse)
def list_oi(
    q: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int = 20,
    offset: int = 0,
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
    tech_number = sess.get("techNumber")
    banco_id = sess.get("bancoId")
    is_admin = _is_admin(sess)

    # Normalizar y acotar limit
    if limit <= 0:
        limit = 20
    if limit > 100:
        limit = 100

    # Construir condiciones comunes (rol, búsqueda, rango de fechas)
    conditions = []

    if not is_admin:
        if tech_number is not None:
            conditions.append(OI.tech_number == tech_number)
        if banco_id is not None:
            conditions.append(OI.banco_id == banco_id)

    # Búsqueda por código de OI (parcial, insensitive)
    search = (q or "").strip()
    if search:
        code_col: ColumnElement = cast(ColumnElement, OI.code)  # normaliza tipo para linters
        conditions.append(code_col.ilike(f"%{search}%"))

    # Filtro por rango de fechas (creación)
    start_dt = _parse_date(date_from)
    end_dt = _parse_date(date_to)
    if start_dt:
        conditions.append(OI.created_at >= start_dt)  # type: ignore[arg-type]
    if end_dt:
        # incluir todo el día date_to → < date_to + 1 día
        end_dt_plus = end_dt + timedelta(days=1)
        conditions.append(OI.created_at < end_dt_plus)  # type: ignore[arg-type]

    # --- Consulta base con filtros ---
    base_stmt = select(OI)
    if conditions:
        base_stmt = base_stmt.where(*conditions)

    # Total para la paginación
    count_stmt = select(func.count()).select_from(OI)
    if conditions:
        count_stmt = count_stmt.where(*conditions)
    total = session.exec(count_stmt).one()

    # Ordenar por "más reciente":
    # usamos coalesce(updated_at, created_at) para considerar última modificación
    sort_expr = func.coalesce(OI.updated_at, OI.created_at).desc()
    id_column: ColumnElement = cast(ColumnElement, OI.id)  # normaliza tipo para linters
    data_stmt = (
        base_stmt
        .order_by(sort_expr, desc(id_column))
        .limit(limit)
        .offset(offset)
    )

    rows = session.exec(data_stmt).all()
    items = [_build_oi_read(oi, session, sess) for oi in rows]

    return OIListResponse(
        items=items,
        total=total,
        limit=limit,
        offset=offset,
    )


@router.delete("/{oi_id}")
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


@router.post("/{oi_id}/bancadas", response_model=BancadaRead)
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
    b = Bancada(
        oi_id=oi_id,
        item=next_item,
        medidor=payload.medidor,
        estado=payload.estado,
        rows=payload.rows,
        # Mini-planilla completa de la bancada (si el frontend la envía)
        rows_data=rows_data,
        created_at=now,
        updated_at=now,
    )
    session.add(b)
    # marcar modificacion de la OI
    oi.updated_at = now
    _touch_or_take_lock(oi, sess, lock_state)
    session.add(oi)
    session.commit()
    session.refresh(b)
    return BancadaRead.model_validate(b)

@router.get("/{oi_id}/with-bancadas", response_model=OiWithBancadasRead)
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
    base = _build_oi_read(oi, session, sess, lock_state)
    return OiWithBancadasRead(
        **base.model_dump(),
        bancadas=[BancadaRead.model_validate(b) for b in rows],
    )

# Alias para el frontend: /oi/{id}/full → mismo payload que /with-bancadas
@router.get("/{oi_id}/full", response_model=OiWithBancadasRead)
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
    b.medidor = payload.medidor
    b.estado = payload.estado or 0
    b.rows = payload.rows
    # Reemplazar grid por la versión más reciente que viene del modal.
    # Si el frontend aún no envía rows_data, esto quedará en None.
    b.rows_data = _dump_rows_data(payload.rows_data)
    # Marcar fecha/hora de última modificación de la bancada
    b.updated_at = now
    session.add(b)

    # Actualizar también la OI padre
    oi.updated_at = now
    _touch_or_take_lock(oi, sess, lock_state)
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
    session.commit()
    return {"ok": True}

@router.post("/{oi_id}/excel")
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
    try:
        data, _ = build_excel_file(oi, bancadas, password=req.password)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    # ----- Construcción del nombre de archivo según 18.1.4 -----
    # Patrón: OI-####-YYYY-nombre-apellido-YYYY-MM-DD.xlsx
    # La fecha corresponde a la última modificación de la OI;
    # si aún no tiene updated_at, se usa created_at.
    effective_dt = oi.updated_at or oi.created_at
    if effective_dt is None:
        effective_dt = datetime.utcnow()
    date_str = effective_dt.strftime("%Y-%m-%d")

    # Nombre y apellido del técnico (creador del OI) usando el helper existente
    full_name = get_full_name_by_tech_number(oi.tech_number) or ""
    name_for_file = _format_name_for_filename(full_name)

    filename = f"{oi.code}-{name_for_file}-{date_str}.xlsx"
    return StreamingResponse(
        BytesIO(data),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )

@router.get("/{oi_id}/bancadas-list", response_model=List[BancadaRead])
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
