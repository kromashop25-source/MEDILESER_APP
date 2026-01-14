from __future__ import annotations

from typing import Iterable, List

from .rbac import is_superuser, normalize_role

MODULE_IDS: List[str] = [
    "oi_formulario",
    "oi_listado",
    "tools_vima_lista",
    "tools_actualizacion_bases",
    "tools_historial_ac",
    "tools_consol_correlativo",
    "tools_consol_no_correlativo",
    "users_admin",
    "admin_permisos",
    # Módulos visibles pero deshabilitados (FUTURO)
    "future_ot",
    "logistica",
    "future_smart",
]

DEFAULT_TECH_MODULES: List[str] = [
    "oi_formulario",
    "oi_listado",
    "tools_vima_lista",
    "tools_actualizacion_bases",
    "tools_historial_ac",
    "tools_consol_correlativo",
    "tools_consol_no_correlativo",
]

DEFAULT_STANDARD_MODULES: List[str] = [
    "oi_listado",
]

DEFAULT_ADMIN_MODULES: List[str] = [
    *DEFAULT_TECH_MODULES,
    "users_admin",
]


def normalize_allowed_modules(modules: Iterable[str]) -> List[str]:
    seen = set()
    out: List[str] = []
    for m in modules:
        if not m:
            continue
        key = str(m).strip()
        # Compatibilidad hacia atrás: antes el módulo se llamaba "future_logistica"
        if key == "future_logistica":
            key = "logistica"
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(key)
    return out


def get_default_allowed_modules(role: str | None, username: str | None = None) -> List[str]:
    if is_superuser(username):
        return list(MODULE_IDS)

    r = normalize_role(role, username)
    if r == "administrator":
        return list(DEFAULT_ADMIN_MODULES)
    if r == "standard":
        return list(DEFAULT_STANDARD_MODULES)
    return list(DEFAULT_TECH_MODULES)


def get_effective_allowed_modules(
    role: str | None,
    stored: List[str] | None,
    username: str | None = None,
) -> List[str]:
    if is_superuser(username):
        return list(MODULE_IDS)
    if stored is None:
        return get_default_allowed_modules(role, username)
    return normalize_allowed_modules(stored)


def validate_known_modules(modules: Iterable[str]) -> List[str]:
    normalized = normalize_allowed_modules(modules)
    allowed_set = set(MODULE_IDS)
    unknown = [m for m in normalized if m not in allowed_set]
    if unknown:
        raise ValueError(f"Módulos desconocidos: {', '.join(unknown)}")
    return normalized
