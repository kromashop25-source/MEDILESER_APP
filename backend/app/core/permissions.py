from __future__ import annotations

from typing import Iterable, List

MODULE_IDS: List[str] = [
    "oi_formulario",
    "oi_listado",
    "tools_vima_lista",
    "tools_actualizacion_bases",
    "tools_consol_correlativo",
    "tools_consol_no_correlativo",
    "users_admin",
    "admin_permisos",
]

DEFAULT_TECH_MODULES: List[str] = [
    "oi_formulario",
    "oi_listado",
    "tools_vima_lista",
    "tools_actualizacion_bases",
    "tools_consol_correlativo",
    "tools_consol_no_correlativo",
]


def normalize_allowed_modules(modules: Iterable[str]) -> List[str]:
    seen = set()
    out: List[str] = []
    for m in modules:
        if not m:
            continue
        key = str(m).strip()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(key)
    return out


def get_default_allowed_modules(role: str | None) -> List[str]:
    r = (role or "").lower()
    if r == "admin":
        return list(MODULE_IDS)
    return list(DEFAULT_TECH_MODULES)


def get_effective_allowed_modules(role: str | None, stored: List[str] | None) -> List[str]:
    if stored is None:
        return get_default_allowed_modules(role)
    return normalize_allowed_modules(stored)


def validate_known_modules(modules: Iterable[str]) -> List[str]:
    normalized = normalize_allowed_modules(modules)
    allowed_set = set(MODULE_IDS)
    unknown = [m for m in normalized if m not in allowed_set]
    if unknown:
        raise ValueError(f"Módulos desconocidos: {', '.join(unknown)}")
    return normalized

