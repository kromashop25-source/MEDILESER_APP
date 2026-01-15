from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends
from app.api.auth import get_current_user_session

router = APIRouter(
    prefix="/logistica/log02",
    tags=["logistica/log02"],
    dependencies=[Depends(get_current_user_session)],

)

@router.get("/ping")
def log02_ping() -> Dict[str, Any]:
    return {"ok": True, "module": "LOG-02"}