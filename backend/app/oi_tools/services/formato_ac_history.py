from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

from sqlmodel import Session

from app.core.db import engine
from app.core.settings import get_settings
from app.models import FormatoAcRun, FormatoAcArtifact


def _safe_output_name(name: Optional[str], operation_id: str) -> str:
    cleaned = (name or "").strip()
    if cleaned:
        return Path(cleaned).name
    return f"FORMATO_AC_{operation_id}.xlsx"


def persist_formato_ac_success(
    *,
    origin: str,
    operation_id: str,
    output_name: Optional[str],
    file_bytes: bytes,
    summary: Optional[Dict[str, Any]],
    sess: Dict[str, Any],
) -> Optional[int]:
    try:
        settings = get_settings()
        origin_clean = (origin or "").strip().upper()
        op_id = (operation_id or "").strip() or "N/A"
        safe_name = _safe_output_name(output_name, op_id)

        with Session(engine) as session:
            run = FormatoAcRun(
                operation_id=op_id,
                origin=origin_clean,
                status="COMPLETADO",
                output_name=safe_name,
                created_at=datetime.utcnow(),
                completed_at=datetime.utcnow(),
                created_by_user_id=sess.get("userId"),
                created_by_username=(sess.get("username") or "").strip() or "desconocido",
                created_by_full_name=sess.get("fullName"),
                created_by_banco_id=sess.get("bancoId"),
                summary_json=summary,
            )
            session.add(run)
            session.commit()
            session.refresh(run)
            run_id = run.id
            if run_id is None:
                return None

            base_dir = settings.data_dir / "oi_tools" / "formato_ac_runs" / str(run_id)
            base_dir.mkdir(parents=True, exist_ok=True)
            abs_path = base_dir / safe_name
            abs_path.write_bytes(file_bytes)
            rel_path = str(abs_path.relative_to(settings.data_dir))

            session.add(
                FormatoAcArtifact(
                    run_id=run_id,
                    kind="EXCEL_FINAL",
                    filename=safe_name,
                    storage_rel_path=rel_path,
                    content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    size_bytes=abs_path.stat().st_size,
                )
            )
            session.commit()
            return run_id
    except Exception:
        return None


def persist_formato_ac_error(
    *,
    origin: str,
    operation_id: str,
    error_detail: str,
    sess: Dict[str, Any],
) -> Optional[int]:
    try:
        origin_clean = (origin or "").strip().upper()
        op_id = (operation_id or "").strip() or "N/A"
        detail = (error_detail or "").strip() or "Error de procesamiento."

        with Session(engine) as session:
            run = FormatoAcRun(
                operation_id=op_id,
                origin=origin_clean,
                status="ERROR",
                output_name=None,
                created_at=datetime.utcnow(),
                completed_at=datetime.utcnow(),
                created_by_user_id=sess.get("userId"),
                created_by_username=(sess.get("username") or "").strip() or "desconocido",
                created_by_full_name=sess.get("fullName"),
                created_by_banco_id=sess.get("bancoId"),
                summary_json=None,
                error_detail=detail,
            )
            session.add(run)
            session.commit()
            session.refresh(run)
            return run.id
    except Exception:
        return None
