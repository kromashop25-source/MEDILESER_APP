from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select
from sqlalchemy import func, or_, cast, String

from ..core.db import engine
from ..core.permissions import get_effective_allowed_modules, validate_known_modules
from ..core.rbac import is_superuser
from ..models import User
from .auth import _SESSIONS, get_current_user_session

router = APIRouter()


def get_session():
    with Session(engine) as session:
        yield session


class UserPermissionsOut(BaseModel):
    id: int
    username: str
    role: str
    allowedModules: List[str]

class UserPermissionsPagedOut(BaseModel):
    items: List[UserPermissionsOut]
    total: int
    limit: int
    offset: int


class UserPermissionsUpdate(BaseModel):
    allowedModules: List[str]


@router.get("/permisos", response_model=List[UserPermissionsOut])
def list_user_permissions(
    sess: dict = Depends(get_current_user_session),
    session: Session = Depends(get_session),
):
    requester_username = (sess.get("username") or sess.get("user") or "").lower()
    if not is_superuser(requester_username):
        raise HTTPException(status_code=403, detail="Requiere privilegios de superusuario")

    users = session.exec(select(User)).all()
    return [
        UserPermissionsOut(
            id=u.id or 0,
            username=u.username,
            role=u.role,
            allowedModules=get_effective_allowed_modules(
                u.role,
                getattr(u, "allowed_modules", None),
                username=u.username,
            ),
        )
        for u in users
    ]

@router.get("/permisos/paged", response_model=UserPermissionsPagedOut)
def list_user_permissions_paged(
    limit: int = 20,
    offset: int = 0,
    q: str | None = None,
    role: str | None = None,
    sess: dict = Depends(get_current_user_session),
    session: Session = Depends(get_session),
):
    requester_username = (sess.get("username") or sess.get("user") or "").lower()
    if not is_superuser(requester_username):
        raise HTTPException(status_code=403, detail="Requiere privilegios de superusuario")

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

    items = [
        UserPermissionsOut(
            id=u.id or 0,
            username=u.username,
            role=u.role,
            allowedModules=get_effective_allowed_modules(
                u.role,
                getattr(u, "allowed_modules", None),
                username=u.username,
            ),
        )
        for u in users
    ]
    return UserPermissionsPagedOut(items=items, total=int(total or 0), limit=limit, offset=offset)



@router.put("/permisos/{user_id}", response_model=UserPermissionsOut)
def update_user_permissions(
    user_id: int,
    payload: UserPermissionsUpdate,
    sess: dict = Depends(get_current_user_session),
    session: Session = Depends(get_session),
):
    requester_username = (sess.get("username") or sess.get("user") or "").lower()
    if not is_superuser(requester_username):
        raise HTTPException(status_code=403, detail="Requiere privilegios de superusuario")

    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    if is_superuser(user.username):
        raise HTTPException(status_code=400, detail="No se pueden modificar los permisos del superusuario")

    try:
        normalized = validate_known_modules(payload.allowedModules)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    user.allowed_modules = normalized
    session.add(user)
    session.commit()
    session.refresh(user)

    effective = get_effective_allowed_modules(user.role, user.allowed_modules, username=user.username)

    for s in _SESSIONS.values():
        if s.get("userId") == user_id:
            s["allowedModules"] = effective

    return UserPermissionsOut(
        id=user.id or 0,
        username=user.username,
        role=user.role,
        allowedModules=effective,
    )
