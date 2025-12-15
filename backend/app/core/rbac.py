from __future__ import annotations

from typing import Literal

Role = Literal["admin", "administrator", "technician", "standard"]

SUPERUSER_USERNAME = "admin"


def is_superuser(username: str | None) -> bool:
    return (username or "").strip().lower() == SUPERUSER_USERNAME


def normalize_role(role: str | None, username: str | None = None) -> Role:
    """
    Normaliza roles para soportar legados:
    - "user" -> "technician"
    - "admin" (no superusuario) -> "administrator"
    - superusuario se identifica por username == "admin"
    """
    if is_superuser(username):
        return "admin"

    r = (role or "").strip().lower()

    if r in ("administrator", "administrador", "admin"):
        return "administrator"
    if r in ("technician", "tecnico", "técnico", "user"):
        return "technician"
    if r in ("standard", "estandar", "estándar", "staff"):
        return "standard"

    return "standard"


def is_technician_role(role: str | None, username: str | None = None) -> bool:
    return normalize_role(role, username) == "technician"


def can_manage_users(role: str | None, username: str | None = None) -> bool:
    return normalize_role(role, username) in ("admin", "administrator")


def can_manage_permissions(role: str | None, username: str | None = None) -> bool:
    return is_superuser(username)


def is_admin_like_for_oi(role: str | None, username: str | None = None) -> bool:
    """
    Roles que operan con visibilidad amplia en /oi (no requieren banco).
    """
    return normalize_role(role, username) in ("admin", "administrator", "standard")

