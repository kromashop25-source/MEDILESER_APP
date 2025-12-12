import secrets
from datetime import datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Header, Body
from sqlmodel import Session, select

from ..core.db import engine
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
    bancoId: int

class LoginOut(BaseModel):
    user: str
    userId: int
    username: str
    firstName: str
    lastName: str
    fullName: str
    bancoId: int
    techNumber: int
    role: str
    token: str

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
        _SESSIONS.pop(token, None)
        raise HTTPException(status_code=401, detail="Sesión expirada")
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
    token = secrets.token_hex(32)
    now = datetime.utcnow()
    expires_at = now + timedelta(hours=12)
    
    full_name = f"{user.first_name} {user.last_name}".strip()
    
    sess_data = {
        "userId": user.id,
        "username": user.username,
        "firstName": user.first_name,
        "lastName": user.last_name,
        "fullName": full_name,
        "bancoId": payload.bancoId,
        "techNumber": user.tech_number,
        "role": user.role,
        "token": token,
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


# --- GESTIÓN DE USUARIOS (CRUD) ---

@router.get("/users", response_model=List[UserRead])
def list_users(
    sess: dict = Depends(get_current_user_session),
    session: Session = Depends(get_session)
):
    if sess["role"] != "admin":
        raise HTTPException(status_code=403, detail="Requiere privilegios de administrador")
    
    users = session.exec(select(User)).all()
    return users

@router.post("/users", response_model=UserRead)
def create_user(
    payload: UserCreate,
    sess: dict = Depends(get_current_user_session),
    session: Session = Depends(get_session)
):
    if sess["role"] != "admin":
        raise HTTPException(status_code=403, detail="Requiere privilegios de administrador")

    # Verificar duplicados
    existing = session.exec(select(User).where(User.username == payload.username.lower())).first()
    if existing:
        raise HTTPException(status_code=400, detail="El nombre de usuario ya existe")
    
    # Verificar tech_number único (opcional, pero recomendado)
    existing_tech = session.exec(select(User).where(User.tech_number == payload.tech_number)).first()
    if existing_tech and payload.tech_number != 0: # 0 suele ser admin genérico
        raise HTTPException(status_code=400, detail=f"El número de técnico {payload.tech_number} ya está asignado a {existing_tech.username}")

    new_user = User(
        username=payload.username.lower(),
        first_name=payload.first_name,
        last_name=payload.last_name,
        tech_number=payload.tech_number,
        role=payload.role,
        password_hash=get_password_hash(payload.password),
        is_active=True
    )
    session.add(new_user)
    session.commit()
    session.refresh(new_user)
    return new_user

@router.delete("/users/{user_id}")
def delete_user(
    user_id: int,
    sess: dict = Depends(get_current_user_session),
    session: Session = Depends(get_session)
):
    if sess["role"] != "admin":
        raise HTTPException(status_code=403, detail="Requiere privilegios de administrador")

    target_user = session.get(User, user_id)
    if not target_user:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")

    # Regla: Solo el usuario 'admin' puede tocar a otros admins (opcional, pero buena práctica)
    if target_user.role == "admin" and sess["username"] != "admin":
         raise HTTPException(status_code=403, detail="Solo el superusuario 'admin' puede eliminar a otros administradores")

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
    if sess["role"] != "admin":
        raise HTTPException(status_code=403, detail="Acceso denegado")

    target_user = session.get(User, user_id)
    if not target_user:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")

    # Solo el superadmin 'admin' puede modificar a usuarios admin
    if target_user.role == "admin" and sess["username"] != "admin":
        raise HTTPException(status_code=403, detail="Solo el usuario principal 'admin' puede cambiar contraseñas de administradores")

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
