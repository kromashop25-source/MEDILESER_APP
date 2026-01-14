import secrets
from datetime import datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Header, Body
from sqlmodel import Session, select
from sqlalchemy import func, or_, cast, String

from ..core.db import engine
from ..core.permissions import get_effective_allowed_modules
from ..core.rbac import can_manage_users, is_superuser, normalize_role
from ..core.security import get_password_hash, verify_password
from ..models import User, OI
from ..schemas import UserRead, UserCreate, UserUpdatePassword
from pydantic import BaseModel

router = APIRouter()

# Almacén de sesiones en memoria (Token -> UserDict)
_SESSIONS = {}

def get_full_name_by_tech_number(tech_number: int) -> Optional[str]:
    """Devuelve 'Nombre Apellido' para el técnico dado, o None si no existe."""
    with Session(engine) as session:
        user = session.exec(select(User).where(User.tech_number == tech_number)).first()
        if not user:
            return None
        full_name = f"{user.first_name} {user.last_name}".strip()
        return full_name or None

class LoginRequest(BaseModel):
    username: str
    password: str
    bancoId: Optional[int] = None

class LoginOut(BaseModel):
    user: str
    userId: int
    username: str
    firstName: str
    lastName: str
    fullName: str
    bancoId: Optional[int] = None
    techNumber: int
    role: str
    token: str
    allowedModules: List[str] = []


class SetBancoRequest(BaseModel):
    bancoId: int

class UserPagedOut(BaseModel):
    items: List[UserRead]
    total: int
    limit: int
    offset: int

class UserUpdateRequest(BaseModel):
    username: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    tech_number: Optional[int] = None
    role: Optional[str] = None
    password: Optional[str] = None

def get_session():
    with Session(engine) as session:
        yield session

def _purge_expired_sessions(now: datetime):
    expired = [k for k, v in _SESSIONS.items() if v["expiresAt"] < now]
    for k in expired:
        del _SESSIONS[k]

def get_current_user_session(authorization: str | None = Header(default=None)) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Token requerido")
    token = authorization.split(" ", 1)[1]
    sess = _SESSIONS.get(token)
    if not sess:
        raise HTTPException(status_code=401, detail="Sesión inválida o expirada")
    if sess["expiresAt"] < datetime.utcnow():
        # No removemos la sesión aquí para permitir cierres best-effort (p.ej. liberar lock OI)
        raise HTTPException(status_code=401, detail="Sesión inválida o expirada")
    return sess

# --- AUTENTICACIÓN ---

@router.post("/login", response_model=LoginOut)
def login(payload: LoginRequest, session: Session = Depends(get_session)):
    # 1. Buscar usuario en BD
    user = session.exec(select(User).where(User.username == payload.username.lower())).first()
    
    # 2. Validar usuario y contraseña
    if not user or not verify_password(payload.password, user.password_hash):
        # HARDCODED BOOTSTRAP: Si es "admin" y no existe en BD, crearlo al vuelo (solo primera vez)
        if payload.username.lower() == "admin" and not user:
            admin_user = User(
                username="admin",
                first_name="Administrador",
                last_name="Sistema",
                password_hash=get_password_hash("1234"), # Default password
                tech_number=0,
                role="admin"
            )
            session.add(admin_user)
            session.commit()
            session.refresh(admin_user)
            user = admin_user
            # Validar pwd de nuevo por si acaso
            if payload.password != "1234":
                 raise HTTPException(status_code=401, detail="Credenciales inválidas (Admin creado por defecto: 1234)")
        else:
            raise HTTPException(status_code=401, detail="Credenciales inválidas")

    if not user.is_active:
        raise HTTPException(status_code=403, detail="Usuario inactivo")

    # 3. Crear Sesión
    role = normalize_role(user.role, user.username)

    token = secrets.token_hex(32)
    now = datetime.utcnow()
    expires_at = now + timedelta(hours=12)
    
    full_name = f"{user.first_name} {user.last_name}".strip()
    
    banco_id: Optional[int] = payload.bancoId if payload.bancoId and payload.bancoId > 0 else None
    if is_superuser(user.username):
        # Para el superusuario el banco no es obligatorio; mantenemos 0 por compatibilidad.
        banco_id = banco_id or 0

    allowed_modules = get_effective_allowed_modules(
        role,
        getattr(user, "allowed_modules", None),
        username=user.username,
    )

    sess_data = {
        "userId": user.id,
        "username": user.username,
        "firstName": user.first_name,
        "lastName": user.last_name,
        "fullName": full_name,
        "bancoId": banco_id,
        "techNumber": user.tech_number,
        "role": role,
        "token": token,
        "allowedModules": allowed_modules,
        "createdAt": now,
        "expiresAt": expires_at,
        "user": user.username # compatibilidad
    }
    
    _purge_expired_sessions(now)
    _SESSIONS[token] = sess_data
    return sess_data

@router.get("/me", response_model=LoginOut)
def me(sess: dict = Depends(get_current_user_session)):
    return sess

@router.post("/logout")
def logout(authorization: str | None = Header(default=None)):
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1]
        _SESSIONS.pop(token, None)
    return {"ok": True}


@router.put("/banco", response_model=LoginOut)
def set_banco(
    payload: SetBancoRequest,
    sess: dict = Depends(get_current_user_session),
):
    """
    Permite seleccionar/actualizar el banco de trabajo luego del login.
    Se guarda en la sesiÇün (in-memory) y aplica a filtros/ownership en /oi.
    """
    if payload.bancoId <= 0:
        raise HTTPException(status_code=422, detail="Banco invÇ­lido")

    sess["bancoId"] = int(payload.bancoId)
    return sess


# --- GESTIÓN DE USUARIOS (CRUD) ---

@router.get("/users", response_model=List[UserRead])
def list_users(
    sess: dict = Depends(get_current_user_session),
    session: Session = Depends(get_session)
):
    requester_username = (sess.get("username") or sess.get("user") or "").lower()
    if not can_manage_users(sess.get("role"), requester_username):
        raise HTTPException(status_code=403, detail="Requiere privilegios de administrador")
    
    users = session.exec(select(User)).all()
    return users

@router.get("/users/paged", response_model=UserPagedOut)
def list_users_paged(
    limit: int = 20,
    offset: int = 0,
    q: Optional[str] = None,
    role: Optional[str] = None,
    sess: dict = Depends(get_current_user_session),
    session: Session = Depends(get_session)
):
    requester_username = (sess.get("username") or sess.get("user") or "").lower()
    if not can_manage_users(sess.get("role"), requester_username):
        raise HTTPException(status_code=403, detail="Requiere privilegios de administrador")

    limit = max(1, min(int(limit or 20), 200))
    offset = max(0, int(offset or 0))

    where = []
    q_clean = (q or "").strip().lower()
    if q_clean:
        like = f"%{q_clean}%"
        where.append(
            or_(
                func.lower(cast(User.username, String)).like(like),
                func.lower(cast(User.first_name, String)).like(like),
                func.lower(cast(User.last_name, String)).like(like),
                func.lower(cast(User.role, String)).like(like),
            )
        )

    role_clean = (role or "").strip().lower()
    if role_clean:
        where.append(func.lower(cast(User.role, String)) == role_clean)

    total = session.exec(select(func.count()).select_from(User).where(*where)).one()
    users = session.exec(
        select(User)
        .where(*where)
        .order_by(cast(User.username, String).asc())
        .offset(offset)
        .limit(limit)
    ).all()
    return UserPagedOut(items=users, total=int(total or 0), limit=limit, offset=offset)

@router.post("/users", response_model=UserRead)
def create_user(
    payload: UserCreate,
    sess: dict = Depends(get_current_user_session),
    session: Session = Depends(get_session)
):
    requester_username = (sess.get("username") or sess.get("user") or "").lower()
    if not can_manage_users(sess.get("role"), requester_username):
        raise HTTPException(status_code=403, detail="Requiere privilegios de administrador")

    username = payload.username.lower()
    if username == "admin":
        raise HTTPException(status_code=400, detail="El usuario 'admin' estÇ­ reservado para el superusuario")

    requested_role = normalize_role(payload.role, username)
    if not is_superuser(requester_username) and requested_role == "administrator":
        raise HTTPException(status_code=403, detail="Solo el superusuario puede crear usuarios administradores")

    # Verificar duplicados
    existing = session.exec(select(User).where(User.username == username)).first()
    if existing:
        raise HTTPException(status_code=400, detail="El nombre de usuario ya existe")
    
    # Verificar tech_number único (opcional, pero recomendado)
    existing_tech = session.exec(select(User).where(User.tech_number == payload.tech_number)).first()
    if existing_tech and payload.tech_number != 0: # 0 suele ser admin genérico
        raise HTTPException(status_code=400, detail=f"El número de técnico {payload.tech_number} ya está asignado a {existing_tech.username}")

    new_user = User(
        username=username,
        first_name=payload.first_name,
        last_name=payload.last_name,
        tech_number=payload.tech_number,
        role=requested_role,
        password_hash=get_password_hash(payload.password),
        is_active=True
    )
    session.add(new_user)
    session.commit()
    session.refresh(new_user)
    return new_user

@router.put("/users/{user_id}", response_model=UserRead)
def update_user(
    user_id: int,
    payload: UserUpdateRequest,
    sess: dict = Depends(get_current_user_session),
    session: Session = Depends(get_session)
):
    requester_username = (sess.get("username") or sess.get("user") or "").lower()
    if not can_manage_users(sess.get("role"), requester_username):
        raise HTTPException(status_code=403, detail="Requiere privilegios de administrador")

    target_user = session.get(User, user_id)
    if not target_user:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")

    target_norm_role = normalize_role(target_user.role, target_user.username)
    requester_is_superuser = is_superuser(requester_username)
    if target_norm_role in ("admin", "administrator") and not requester_is_superuser:
        raise HTTPException(status_code=403, detail="Solo el superusuario puede actualizar usuarios administradores")

    if not requester_is_superuser:
        if payload.password:
            target_user.password_hash = get_password_hash(payload.password)
            session.add(target_user)
            session.commit()
            session.refresh(target_user)
            return target_user
        if any(
            value is not None
            for value in (
                payload.username,
                payload.first_name,
                payload.last_name,
                payload.tech_number,
                payload.role,
            )
        ):
            raise HTTPException(status_code=403, detail="Solo el superusuario puede actualizar datos del usuario")
        raise HTTPException(status_code=400, detail="Debe ingresar una nueva contraseña")

    next_username = target_user.username
    if payload.username is not None:
        username = payload.username.strip().lower()
        if not username:
            raise HTTPException(status_code=400, detail="Nombre de usuario inválido")
        if username == "admin" and target_user.username != "admin":
            raise HTTPException(status_code=400, detail="El usuario 'admin' está reservado para el superusuario")
        if username != target_user.username:
            existing = session.exec(select(User).where(User.username == username)).first()
            if existing:
                raise HTTPException(status_code=400, detail="El nombre de usuario ya existe")
        target_user.username = username
        next_username = username

    if payload.first_name is not None:
        target_user.first_name = payload.first_name
    if payload.last_name is not None:
        target_user.last_name = payload.last_name
    if payload.tech_number is not None:
        if payload.tech_number != target_user.tech_number:
            existing_tech = session.exec(select(User).where(User.tech_number == payload.tech_number)).first()
            if existing_tech and payload.tech_number != 0:
                raise HTTPException(
                    status_code=400,
                    detail=f"El número de técnico {payload.tech_number} ya está asignado a {existing_tech.username}",
                )
        target_user.tech_number = payload.tech_number

    if payload.role is not None:
        requested_role = normalize_role(payload.role, next_username)
        if requested_role == "admin" and next_username != "admin":
            raise HTTPException(status_code=400, detail="El rol admin es exclusivo del superusuario")
        target_user.role = requested_role

    if payload.password:
        target_user.password_hash = get_password_hash(payload.password)

    session.add(target_user)
    session.commit()
    session.refresh(target_user)
    return target_user

@router.delete("/users/{user_id}")
def delete_user(
    user_id: int,
    sess: dict = Depends(get_current_user_session),
    session: Session = Depends(get_session)
):
    requester_username = (sess.get("username") or sess.get("user") or "").lower()
    if not can_manage_users(sess.get("role"), requester_username):
        raise HTTPException(status_code=403, detail="Requiere privilegios de administrador")

    target_user = session.get(User, user_id)
    if not target_user:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")

    # Regla: Solo el usuario 'admin' puede tocar a otros admins (opcional, pero buena práctica)
    target_norm_role = normalize_role(target_user.role, target_user.username)
    if target_norm_role in ("admin", "administrator") and not is_superuser(requester_username):
        raise HTTPException(status_code=403, detail="Solo el superusuario puede eliminar usuarios administradores")

    if target_user.username == "admin":
        raise HTTPException(status_code=400, detail="No se puede eliminar al usuario admin principal")

    # Regla: Validar si tiene registros (OIs)
    has_ois = session.exec(select(OI).where(OI.tech_number == target_user.tech_number)).first()
    if has_ois:
        raise HTTPException(status_code=400, detail="No se puede eliminar: El usuario tiene OIs registradas.")

    session.delete(target_user)
    session.commit()
    return {"ok": True}


# --- CAMBIO DE CONTRASEÑA ---

@router.put("/users/{user_id}/password")
def admin_change_password(
    user_id: int,
    payload: UserUpdatePassword,
    sess: dict = Depends(get_current_user_session),
    session: Session = Depends(get_session)
):
    """
    Permite cambiar contraseñas desde un contexto de administrador con reglas:
    - Solo usuarios con role 'admin' acceden a este endpoint.
    - El superadmin 'admin' puede cambiar cualquier usuario.
    - Otros admin solo pueden cambiar a técnicos (role='user'); no pueden tocar a otros admin.
    """
    requester_username = (sess.get("username") or sess.get("user") or "").lower()
    if not can_manage_users(sess.get("role"), requester_username):
        raise HTTPException(status_code=403, detail="Acceso denegado")

    target_user = session.get(User, user_id)
    if not target_user:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")

    target_norm_role = normalize_role(target_user.role, target_user.username)
    if target_norm_role in ("admin", "administrator") and not is_superuser(requester_username):
        raise HTTPException(status_code=403, detail="Solo el superusuario puede cambiar contraseñas de administradores")

    target_user.password_hash = get_password_hash(payload.new_password)
    session.add(target_user)
    session.commit()
    return {"ok": True, "message": "Contraseña actualizada por administrador"}


@router.put("/password")
def change_own_password(
    payload: UserUpdatePassword,
    sess: dict = Depends(get_current_user_session),
    session: Session = Depends(get_session)
):
    """Permite a cualquier usuario (técnico o admin) cambiar SU PROPIA contraseña."""
    user = session.get(User, sess["userId"])
    if not user:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")

    # Validar contraseña anterior obligatoria para cambio propio
    if not payload.old_password:
        raise HTTPException(status_code=400, detail="Debe ingresar su contraseña actual")
    
    if not verify_password(payload.old_password, user.password_hash):
        raise HTTPException(status_code=400, detail="La contraseña actual es incorrecta")

    user.password_hash = get_password_hash(payload.new_password)
    session.add(user)
    session.commit()
    return {"ok": True, "message": "Su contraseña ha sido actualizada"}
