from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional, cast
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import func, or_
from sqlmodel import Session, select

from app.api.auth import get_current_user_session
from app.core.db import engine
from app.core.settings import get_settings
from app.models import FormatoAcRun, FormatoAcArtifact
from app.schemas import FormatoAcRunListItem, FormatoAcRunListResponse

router = APIRouter(
    prefix="/oi/tools/formato-ac",
    tags=["oi/tools/formato-ac"],
    dependencies=[Depends(get_current_user_session)],
)

_TZ_PERU = ZoneInfo("America/Lima")


def _parse_history_date(value: Optional[str], end_of_day: bool) -> Optional[datetime]:
    """
    Interpreta dateFrom/dateTo como fecha/hora de Peru si no trae TZ.
    Retorna datetime UTC *naive* para comparar con created_at almacenado como UTC naive.
    """
    if not value:
        return None
    raw = value.strip()
    if not raw:
        return None
    try:
        cleaned = raw
        if cleaned.endswith("Z"):
            cleaned = cleaned[:-1] + "+00:00"
        parsed = datetime.fromisoformat(cleaned)
    except ValueError:
        return None
    has_time = ("T" in raw) or (" " in raw)
    if not has_time:
        if end_of_day:
            parsed = parsed.replace(hour=23, minute=59, second=59, microsecond=999999)
        else:
            parsed = parsed.replace(hour=0, minute=0, second=0, microsecond=0)
        parsed = parsed.replace(tzinfo=_TZ_PERU)
        return parsed.astimezone(timezone.utc).replace(tzinfo=None)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_TZ_PERU)
    return parsed.astimezone(timezone.utc).replace(tzinfo=None)


@router.get("/history", response_model=FormatoAcRunListResponse)
def formato_ac_history_list(
    limit: int = 20,
    offset: int = 0,
    q: Optional[str] = None,
    dateFrom: Optional[str] = None,
    dateTo: Optional[str] = None,
    origin: Optional[str] = None,
):
    created_at_col = cast(Any, FormatoAcRun.created_at)
    where = []

    q_clean = (q or "").strip()
    if q_clean:
        q_like = f"%{q_clean.lower()}%"
        where.append(
            or_(
                func.lower(cast(Any, FormatoAcRun.created_by_username)).like(q_like),
                func.lower(cast(Any, FormatoAcRun.created_by_full_name)).like(q_like),
                func.lower(cast(Any, FormatoAcRun.operation_id)).like(q_like),
            )
        )

    dt_from = _parse_history_date(dateFrom, end_of_day=False)
    if dt_from:
        where.append(created_at_col >= dt_from)

    dt_to = _parse_history_date(dateTo, end_of_day=True)
    if dt_to:
        where.append(created_at_col <= dt_to)

    origin_clean = (origin or "").strip().upper()
    if origin_clean:
        where.append(FormatoAcRun.origin == origin_clean)

    with Session(engine) as session:
        total = session.exec(select(func.count()).select_from(FormatoAcRun).where(*where)).one()
        runs = session.exec(
            select(FormatoAcRun)
            .where(*where)
            .order_by(created_at_col.desc())
            .offset(offset)
            .limit(limit)
        ).all()

        items = [
            FormatoAcRunListItem(
                id=cast(int, r.id),
                operation_id=r.operation_id,
                origin=r.origin,
                status=r.status,
                output_name=r.output_name,
                created_at=r.created_at,
                completed_at=r.completed_at,
                created_by_username=r.created_by_username,
                created_by_full_name=r.created_by_full_name,
                created_by_banco_id=r.created_by_banco_id,
            )
            for r in runs
        ]
        return FormatoAcRunListResponse(items=items, total=total, limit=limit, offset=offset)


@router.get("/history/{run_id}/artifact")
def formato_ac_history_download_artifact(run_id: int):
    settings = get_settings()
    with Session(engine) as session:
        run = session.get(FormatoAcRun, run_id)
        if not run:
            raise HTTPException(status_code=404, detail="No existe la corrida solicitada.")

        art = session.exec(
            select(FormatoAcArtifact).where(
                FormatoAcArtifact.run_id == run_id,
                FormatoAcArtifact.kind == "EXCEL_FINAL",
            )
        ).first()
        if not art:
            raise HTTPException(status_code=404, detail="No existe el archivo solicitado.")

        abs_path = settings.data_dir / art.storage_rel_path
        if not abs_path.exists():
            raise HTTPException(status_code=404, detail="El archivo no esta disponible en el almacenamiento.")

        return FileResponse(
            path=str(abs_path),
            filename=art.filename,
            media_type=art.content_type,
        )
