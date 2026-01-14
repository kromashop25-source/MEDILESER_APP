from __future__ import annotations

import asyncio
import logging
import os
import queue
import shutil
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, cast, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse


from app.api.auth import get_current_user_session
from app.oi_tools.services.progress_manager import progress_manager, SENTINEL
from app.oi_tools.services.cancel_manager import cancel_manager
from app.logistica.services.log01_consolidate import process_log01_files, Log01InputFile, Log01Cancelled

from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from sqlalchemy import func, or_, and_
from sqlmodel import Session, select

from app.core.db import engine
from app.core.settings import get_settings
from app.core.rbac import can_manage_users
from app.models import Log01Run, Log01Artifact
from app.schemas import (
    Log01RunListResponse,
    Log01RunListItem,
    Log01RunDetail,
    Log01ArtifactRead,
    Log01RunDeleteRequest,
)

router = APIRouter(
    prefix="/logistica/log01",
    tags=["logistica/log01"],
    dependencies=[Depends(get_current_user_session)],
)

logger = logging.getLogger(__name__)
_LOG01_HELLO_PAD = " " * 2048

def _emit(operation_id: Optional[str], event: Dict[str, Any]) -> None:
    progress_manager.emit(operation_id, event)

SourceLiteral = Literal["AUTO", "BASES", "GASELAG"]

@dataclass
class Log01Job:
    operation_id: str
    created_at: float
    status: str
    work_dir: str
    output_name: Optional[str] = None
    result_path: Optional[str] = None
    error: Optional[str] = None
    no_conforme_path: Optional[str] = None
    manifest_path: Optional[str] = None
    source: SourceLiteral = "AUTO"



LOG01_JOBS: Dict[str, Log01Job] = {}
LOG01_JOBS_LOCK = threading.Lock()
LOG01_TTL_SECONDS = 60 * 30

                
def _cleanup_log01_job_files(job: Log01Job) -> None:
    if job.work_dir and os.path.isdir(job.work_dir):
        shutil.rmtree(job.work_dir, ignore_errors=True)


def _cleanup_log01_jobs() -> None:
    now = time.time()
    stale: List[Log01Job] = []
    with LOG01_JOBS_LOCK:
        for operation_id, job in list(LOG01_JOBS.items()):
            if job.status == "running":
                continue
            if now - job.created_at < LOG01_TTL_SECONDS:
                continue
            stale.append(job)
            LOG01_JOBS.pop(operation_id, None)
    for job in stale:
        _cleanup_log01_job_files(job)


def _persist_upload_files(files: List[UploadFile], work_dir: str) -> List[Log01InputFile]:
    items: List[Log01InputFile] = []
    for idx, up in enumerate(files, start=1):
        name = up.filename or f"archivo_{idx}.xlsx"
        safe_name = Path(name).name
        dest_path = os.path.join(work_dir, f"{idx}_{safe_name}")
        with open(dest_path, "wb") as out_f:
            shutil.copyfileobj(up.file, out_f)
        up.file.close()
        items.append(Log01InputFile(name=name, path=dest_path))
    return items

def _infer_log01_run_source(job_source: str, summary: Dict[str, Any]) -> str:
    if job_source in ("BASES", "GASELAG"):
        return job_source
    if not isinstance(summary, dict):
        return job_source
    by_source = summary.get("by_source")
    if not isinstance(by_source, dict):
        return job_source

    def _files_total(bucket: Any) -> int:
        if not isinstance(bucket, dict):
            return 0
        v = bucket.get("files_total")
        if isinstance(v, (int, float)):
            return int(v)
        ok = bucket.get("files_ok")
        err = bucket.get("files_error")
        if isinstance(ok, (int, float)) and isinstance(err, (int, float)):
            return int(ok) + int(err)
        return 0

    bases_total = _files_total(by_source.get("BASES"))
    gas_total = _files_total(by_source.get("GASELAG"))
    if bases_total > 0 and gas_total <= 0:
        return "BASES"
    if gas_total > 0 and bases_total <= 0:
        return "GASELAG"
    return job_source


def _run_log01_job(
    job: Log01Job,
    file_items: List[Log01InputFile],
    output_filename: Optional[str],
    sess_snapshot: Dict[str, Any]
) -> None:
    operation_id = job.operation_id
    cancel_token = cancel_manager.get(operation_id)
    try:
        res = process_log01_files(
            file_items=file_items,
            operation_id=operation_id,
            output_filename=output_filename,
            cancel_token=cancel_token,
            source=job.source,
        )
        xlsx_bytes = res.xlsx_bytes
        out_name = res.out_name
        _summary = res.summary
        run_source = _infer_log01_run_source(job.source, _summary)

        # 1) Excel final (CONFORME)
        result_path = os.path.join(job.work_dir, "result.xlsx")
        with open(result_path, "wb") as out_f:
            out_f.write(res.xlsx_bytes)

        # 2) JSON técnico: NO CONFORME final (post-dedupe)
        no_conforme_path = os.path.join(job.work_dir, "no_conforme_final.json")
        with open(no_conforme_path, "wb") as out_f:
            out_f.write(res.no_conforme_json)

        # 3) JSON técnico: manifiesto por OI
        manifest_path = os.path.join(job.work_dir, "manifiesto.json")
        with open(manifest_path, "wb") as out_f:
            out_f.write(res.manifest_json)

        try:
            settings = get_settings()

            def _write_persistent(run_id: int, filename: str, content: bytes) -> tuple[str, int]:
                base_dir = settings.data_dir / "logistica" / "log01_runs" / str(run_id)
                base_dir.mkdir(parents=True, exist_ok=True)
                abs_path = base_dir / filename
                abs_path.write_bytes(content)
                rel_path = str(abs_path.relative_to(settings.data_dir))
                return rel_path, abs_path.stat().st_size
            
            with Session(engine) as session:
                serie_ini = None
                serie_fin = None
                try:
                    if isinstance(_summary, dict):
                        serie_ini = _summary.get("serie_ini")
                        serie_fin = _summary.get("serie_fin")
                except Exception:
                    serie_ini = None
                    serie_fin = None

                def _to_int(s: Any) -> Optional[int]:
                    if s is None:
                        return None
                    if isinstance(s, int):
                        return s
                    if isinstance(s, str):
                        t = s.strip()
                        if t.isdigit():
                            try:
                                return int(t)
                            except Exception:
                                return None
                    return None
                
                run = Log01Run(
                    operation_id=operation_id,
                    source=run_source,
                    output_name=out_name,
                    status="COMPLETADO",
                    created_at=datetime.utcnow(),
                    completed_at=datetime.utcnow(),
                    created_by_user_id=sess_snapshot["userId"],
                    created_by_username=(sess_snapshot.get("username") or "").strip() or "desconocido",
                    created_by_full_name=sess_snapshot.get("fullName"),
                    created_by_banco_id=sess_snapshot.get("bancoId"),
                    summary_json=_summary,
                    serie_ini=serie_ini,
                    serie_fin=serie_fin,
                    serie_ini_num=_to_int(serie_ini),
                    serie_fin_num=_to_int(serie_fin),
                )
                session.add(run)
                session.commit()
                session.refresh(run)
                run_id = run.id
                if run_id is None:
                    raise RuntimeError("LOG01 persistence failed: run.id is None")
                run_id = cast(int, run_id)

                base = Path(out_name or f"LOG01_{operation_id}").stem

                # Excel
                excel_filename = out_name or f"{base}.xlsx"
                excel_rel, excel_size = _write_persistent(run_id, excel_filename, xlsx_bytes)
                session.add(Log01Artifact(
                    run_id=run_id,
                    kind="EXCEL_FINAL",
                    filename=excel_filename,
                    storage_rel_path=excel_rel,
                    content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    size_bytes=excel_size,
                ))

                # NO CONFORME FINAL JSON
                nc_filename = f"{base}__NO_CONFORME_FINAL.json"
                nc_rel, nc_size = _write_persistent(run_id, nc_filename, res.no_conforme_json)
                session.add(Log01Artifact(
                    run_id=run_id,
                    kind="JSON_NO_CONFORME_FINAL",
                    filename=nc_filename,
                    storage_rel_path=nc_rel,
                    content_type="application/json",
                    size_bytes=nc_size,
                ))

                # MANIFIESTO JSON
                man_filename = f"{base}__MANIFIESTO.json"
                man_rel, man_size = _write_persistent(run_id, man_filename, res.manifest_json)
                session.add(Log01Artifact(
                    run_id=run_id,
                    kind="JSON_MANIFIESTO",
                    filename=man_filename,
                    storage_rel_path=man_rel,
                    content_type="application/json",
                    size_bytes=man_size
                ))

                session.commit()
        except Exception:
            logger.exception("LOG01 persistence failed operation_id=%s", operation_id)

        with LOG01_JOBS_LOCK:
            current = LOG01_JOBS.get(operation_id)
            if current:
                current.status = "complete"
                current.output_name = res.out_name
                current.result_path = result_path
                current.no_conforme_path = no_conforme_path
                current.manifest_path = manifest_path


    except Log01Cancelled:
        # process_log01_files ya emite el evento "cancelled"
        with LOG01_JOBS_LOCK:
            current = LOG01_JOBS.get(operation_id)
            if current:
                current.status = "cancelled"
                current.error = "Cancelado por el usuario"
    except Exception as exc:
        logger.exception("LOG01 job failed operation_id=%s", operation_id)
        _emit(
            operation_id,
            {"type": "error", "stage": "failed", "detail": str(exc), "code": "JOB_FAILED"},
        )
        with LOG01_JOBS_LOCK:
            current = LOG01_JOBS.get(operation_id)
            if current:
                current.status = "error"
                current.error = str(exc)
    finally:
        cancel_manager.remove(operation_id)
        # Cleanup inmediato para jobs cancelados o con error.
        # Importante: hacerlo AQUÍ (cuando el thread termina), para no borrar work_dir prematuramente.
        job_to_cleanup: Optional[Log01Job] = None
        with LOG01_JOBS_LOCK:
            current = LOG01_JOBS.get(operation_id)
            if current and current.status in ("cancelled", "error"):
                job_to_cleanup = LOG01_JOBS.pop(operation_id, None)
        if job_to_cleanup:
            _cleanup_log01_job_files(job_to_cleanup)



# ----------------------------
# Progreso (NDJSON stream)
# ----------------------------
@router.get("/progress/{operation_id}")
async def log01_progress_stream(operation_id: str):
    logger.info("LOG01 progress client connected operation_id=%s", operation_id)
    channel, history = progress_manager.subscribe(operation_id)

    async def event_stream():
        last_heartbeat = time.monotonic()
        try:
            # Primer evento JSON para handshake; evita carrera entre stream y start.
            hello_event = {
                "type": "hello",
                "ts": time.time(),
                "operation_id": operation_id,
                "pad": _LOG01_HELLO_PAD,
            }
            yield progress_manager.encode_event(
                {
                    **hello_event,
                }
            )
            logger.info("LOG01 progress hello sent operation_id=%s", operation_id)
            for event in history:
                logger.debug(
                    "LOG01 progress yield operation_id=%s type=%s stage=%s",
                    operation_id,
                    event.get("type"),
                    event.get("stage"),
                )
                yield progress_manager.encode_event(event)
            while True:
                try:
                    item = channel.queue.get_nowait()
                except queue.Empty:
                    now = time.monotonic()
                    if now - last_heartbeat >= 0.8:
                        yield b"\n"
                        last_heartbeat = now
                    await asyncio.sleep(0.1)
                    continue
                if item is SENTINEL:
                    break
                logger.debug(
                    "LOG01 progress yield operation_id=%s type=%s stage=%s",
                    operation_id,
                    item.get("type"),
                    item.get("stage"),
                )
                yield progress_manager.encode_event(item)
                last_heartbeat = time.monotonic()
        finally:
            logger.info("LOG01 progress client disconnected operation_id=%s", operation_id)
            progress_manager.unsubscribe(operation_id)
    headers = {
        # Streaming NDJSON: evitar buffering/transformaciones (sin gzip).
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(
        event_stream(),
        media_type="application/x-ndjson; charset=utf-8",
        headers=headers,
    )


@router.get("/poll/{operation_id}")
def log01_poll(operation_id: str, cursor: int = -1):
    channel, events, cursor_next = progress_manager.get_events_since(operation_id, cursor)
    done = channel.closed
    summary = None
    if events:
        for ev in reversed(events):
            if ev.get("type") == "complete":
                summary = ev.get("result")
                break
    if summary is None and done and channel.history:
        for ev in reversed(channel.history):
            if ev.get("type") == "complete":
                summary = ev.get("result")
                break
    logger.info(
        "LOG01 poll operation_id=%s cursor=%s cursor_next=%s done=%s events=%s",
        operation_id,
        cursor,
        cursor_next,
        done,
        len(events),
    )
    return {
        "cursor_next": cursor_next,
        "events": events,
        "done": done,
        "summary": summary,
    }


@router.post("/cancel/{operation_id}")
def log01_cancel(operation_id: str):
    if not cancel_manager.cancel(operation_id):
        with LOG01_JOBS_LOCK:
            job = LOG01_JOBS.get(operation_id)
        if job is None or job.status != "running":
            raise HTTPException(
                status_code=404,
                detail="Operacion no encontrada.",
                headers={"X-Code": "NOT_FOUND"},
            )
        # Token ausente (condición anómala): crear y cancelar para que el worker lo detecte.
        tok = cancel_manager.create(operation_id)
        tok.cancel()
    # Reflejar estado cancelado de inmediato (el cleanup real ocurre al finalizar el worker).
    with LOG01_JOBS_LOCK:
        job = LOG01_JOBS.get(operation_id)
        if job and job.status == "running":
            job.status = "cancelled"
            job.error = "Cancelado por el usuario"
    _emit(operation_id, {"type": "status", "stage": "cancelled", "message": "Cancelado por el usuario"})
    progress_manager.finish(operation_id)
    return {"ok": True}


# ----------------------------
# Start + result (async)
# ----------------------------
@router.post("/start")
def log01_start(
    files: List[UploadFile] = File(...),
    operation_id: Optional[str] = Form(None),
    operationId: Optional[str] = Form(None),  
    output_filename: Optional[str] = Form(None),
    source: Optional[str] = Form(None),
    sess: Dict[str, Any]  = Depends(get_current_user_session),
):
    _cleanup_log01_jobs()
    # Compatibilidad frontend: aceptar operation_id o operationId
    op_id = ((operation_id or operationId) or "").strip() or str(uuid.uuid4())
    logger.info("LOG01 start operation_id=%s", op_id)

    if not files:
        raise HTTPException(status_code=400, detail="Debes seleccionar al menos 1 Excel.")
    
    src = (source or "AUTO").strip().upper()
    if src not in ("AUTO", "BASES", "GASELAG"):
        raise HTTPException(status_code=400, detail="source inválido. Use AUTO, BASES o GASELAG.")

    src = cast(SourceLiteral, src)

    with LOG01_JOBS_LOCK:
        if op_id in LOG01_JOBS:
            raise HTTPException(status_code=409, detail="Operacion ya existe.")

    work_dir = tempfile.mkdtemp(prefix=f"log01_{op_id}_")
    try:
        file_items = _persist_upload_files(files, work_dir)
    except Exception:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise

    cancel_manager.create(op_id)
    progress_manager.ensure(op_id)

    job = Log01Job(
        operation_id=op_id,
        created_at=time.time(),
        status="running",
        work_dir=work_dir,
        source=src,
    )
    with LOG01_JOBS_LOCK:
        LOG01_JOBS[op_id] = job

    sess_snapshot = {
        "userId": sess.get("userId"),
        "username": sess.get("username"),
        "fullName": sess.get("fullName"),
        "role": sess.get("role"),
        "bancoId": sess.get("bancoId"),
    
    }

    thread = threading.Thread(
        target=_run_log01_job,
        args=(job, file_items, output_filename, sess_snapshot),
        daemon=True,
    )
    thread.start()
    return {"operation_id": op_id, "status": "started"}


@router.get("/result/{operation_id}")
def log01_result(operation_id: str):
    _cleanup_log01_jobs()
    with LOG01_JOBS_LOCK:
        job = LOG01_JOBS.get(operation_id)

    if job is None:
        raise HTTPException(status_code=404, detail="Resultado no encontrado.")

    if job.status == "running":
        return JSONResponse(status_code=202, content={"status": "processing"})

    if job.status == "cancelled":
        return JSONResponse(status_code=409, content={"detail": "Operacion cancelada."})

    if job.status == "error":
        return JSONResponse(status_code=409, content={"detail": job.error or "Error de procesamiento."})

    if not job.result_path or not os.path.exists(job.result_path):
        raise HTTPException(status_code=404, detail="Resultado no disponible.")

    filename = job.output_name or "BD_CONSOLIDADO.xlsx"
    headers = {
        "X-File-Name": filename,
    }
    return FileResponse(
        job.result_path,
        filename=filename,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )

@router.get("/result/{operation_id}/no-conforme")
def log01_result_no_conforme(operation_id: str):
    _cleanup_log01_jobs()
    with LOG01_JOBS_LOCK:
        job = LOG01_JOBS.get(operation_id)
    if not job:
        raise HTTPException(status_code=404, detail="Operacion no encontrada.")
    if job.status in ("started", "running"):
        raise HTTPException(status_code=202, detail="Aun procesando. Intenta nuevamente.")
    if job.status != "complete" or not job.no_conforme_path or not os.path.exists(job.no_conforme_path):
        raise HTTPException(status_code=404, detail="No hay archivo NO CONFORME final disponible.")

    filename = (job.output_name and f"{Path(job.output_name).stem}_NO_CONFORME_FINAL.json") or "NO_CONFORME_FINAL.json"
    headers = {"X-File-Name": filename}
    return FileResponse(job.no_conforme_path, filename=filename, media_type="application/json", headers=headers)


@router.get("/result/{operation_id}/manifest")
def log01_result_manifest(operation_id: str):
    _cleanup_log01_jobs()
    with LOG01_JOBS_LOCK:
        job = LOG01_JOBS.get(operation_id)
    if not job:
        raise HTTPException(status_code=404, detail="Operacion no encontrada.")
    if job.status in ("started", "running"):
        raise HTTPException(status_code=202, detail="Aun procesando. Intenta nuevamente.")
    if job.status != "complete" or not job.manifest_path or not os.path.exists(job.manifest_path):
        raise HTTPException(status_code=404, detail="No hay manifiesto disponible.")

    filename = (job.output_name and f"{Path(job.output_name).stem}_MANIFIESTO.json") or "MANIFIESTO.json"
    headers = {"X-File-Name": filename}
    return FileResponse(job.manifest_path, filename=filename, media_type="application/json", headers=headers)

# ----------------------------
# Historial LOG01
# ----------------------------
_TZ_PERU = ZoneInfo("America/Lima")

def _parse_history_date(value: Optional[str], end_of_day: bool) -> Optional[datetime]:
    """
    Interpreta dateFrom/dateTo como fecha/hora de Perú (America/Lima) si no trae TZ.
    Retorna datetime UTC *naive* para comparar con created_at almacenado como UTC naive.
    """
    if not value:
        return None
    raw = value.strip()
    if not raw:
        return None
    try:
        # fromisoformat no acepta "Z" directamente. Convertimos a +00:00.
        cleaned = raw
        if cleaned.endswith("Z"):
            cleaned = cleaned[:-1] + "+00:00"
        parsed = datetime.fromisoformat(cleaned)
    except ValueError:
        return None
    has_time = ("T" in raw) or (" " in raw)

    # Si viene solo fecha (YYYY-MM-DD), asumimos día local Perú.
    if not has_time:
        if end_of_day:
            parsed = parsed.replace(hour=23, minute=59, second=59, microsecond=999999)
        else:
            parsed = parsed.replace(hour=0, minute=0, second=0, microsecond=0)
        parsed = parsed.replace(tzinfo=_TZ_PERU)
        return parsed.astimezone(timezone.utc).replace(tzinfo=None)

    # Si viene fecha+hora sin TZ, asumimos que es hora Perú.
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_TZ_PERU)

    # Convertir a UTC naive para comparar con created_at UTC naive
    return parsed.astimezone(timezone.utc).replace(tzinfo=None)


@router.get("/history", response_model=Log01RunListResponse)
def log01_history_list(
    limit: int = 20,
    offset: int = 0,
    include_deleted: bool = False,
    q: Optional[str] = None,
    dateFrom: Optional[str] = None,
    dateTo: Optional[str] = None,
    source: Optional[str] = None,
    status: Optional[str] = None,
):
    deleted_at_col = cast(Any, Log01Run.deleted_at)
    created_at_col = cast(Any, Log01Run.created_at)
    where = []
    if not include_deleted:
        where.append(deleted_at_col.is_(None))

    q_clean = (q or "").strip()
    if q_clean:
        q_like = f"%{q_clean.lower()}%"
        text_cond = or_(
            func.lower(cast(Any, Log01Run.created_by_username)).like(q_like),
            func.lower(cast(Any, Log01Run.created_by_full_name)).like(q_like),
            func.lower(cast(Any, Log01Run.operation_id)).like(q_like),
            func.lower(cast(Any, Log01Run.output_name)).like(q_like),
        )

        q_digits = "".join(ch for ch in q_clean if ch.isdigit())
        if q_digits:
            try:
                serie_q = int(q_digits)
            except Exception:
                serie_q = None
            if serie_q is not None:
                range_cond = and_(
                    cast(Any, Log01Run.serie_ini_num) <= serie_q,
                    cast(Any, Log01Run.serie_fin_num) >= serie_q,
                )
                where.append(or_(text_cond, range_cond))
            else:
                where.append(text_cond)
        else:
            where.append(text_cond)


    dt_from = _parse_history_date(dateFrom, end_of_day=False)
    if dt_from:
        where.append(created_at_col >= dt_from)

    dt_to = _parse_history_date(dateTo, end_of_day=True)
    if dt_to:
        where.append(created_at_col <= dt_to)

    source_clean = (source or "").strip().upper()
    if source_clean:
        where.append(Log01Run.source == source_clean)

    status_clean = (status or "").strip().upper()
    if status_clean:
        where.append(func.upper(cast(Any, Log01Run.status)) == status_clean)

    with Session(engine) as session:
        total = session.exec(select(func.count()).select_from(Log01Run).where(*where)).one()
        runs = session.exec(
            select(Log01Run)
            .where(*where)
            .order_by(created_at_col.desc())
            .offset(offset)
            .limit(limit)
        ).all()

        items = [
            Log01RunListItem(
                id=cast(int, r.id),
                operation_id=r.operation_id,
                source=r.source,
                status=r.status,
                output_name=r.output_name,
                created_at=r.created_at,
                completed_at=r.completed_at,
                created_by_username=r.created_by_username,
                created_by_full_name=r.created_by_full_name,
                created_by_banco_id=r.created_by_banco_id,
                summary_json=r.summary_json,
                deleted_at=r.deleted_at,
            )
            for r in runs
        ]
        return Log01RunListResponse(items=items, total=total, limit=limit, offset=offset)


@router.get("/history/{run_id}", response_model=Log01RunDetail)
def log01_history_detail(
    run_id: int,
):
    with Session(engine) as session:
        run = session.get(Log01Run, run_id)
        if not run:
            raise HTTPException(status_code=404, detail="No existe la corrida solicitada.")
        run_id_value = run.id
        if run_id_value is None:
            raise HTTPException(status_code=500, detail="Corrida sin id persistida.")

        arts = session.exec(
            select(Log01Artifact)
            .where(Log01Artifact.run_id == run_id)
            .order_by(cast(Any, Log01Artifact.created_at).asc())
        ).all()

        return Log01RunDetail(
            id=run_id_value,
            operation_id=run.operation_id,
            source=run.source,
            status=run.status,
            output_name=run.output_name,
            created_at=run.created_at,
            completed_at=run.completed_at,
            created_by_user_id=run.created_by_user_id,
            created_by_username=run.created_by_username,
            created_by_full_name=run.created_by_full_name,
            created_by_banco_id=run.created_by_banco_id,
            summary_json=run.summary_json,
            artifacts=[
                Log01ArtifactRead(
                    id=cast(int, a.id),
                    kind=a.kind,
                    filename=a.filename,
                    content_type=a.content_type,
                    size_bytes=a.size_bytes,
                    created_at=a.created_at,
                )
                for a in arts
            ],
            deleted_at=run.deleted_at,
            deleted_by_username=run.deleted_by_username,
            delete_reason=run.delete_reason,
        )


@router.get("/history/{run_id}/artifact/{kind}")
def log01_history_download_artifact(
    run_id: int,
    kind: str,
):
    kind_map = {
        "excel": "EXCEL_FINAL",
        "no-conforme": "JSON_NO_CONFORME_FINAL",
        "manifiesto": "JSON_MANIFIESTO",
    }
    if kind not in kind_map:
        raise HTTPException(status_code=400, detail="Tipo de artefacto inválido.")

    settings = get_settings()
    with Session(engine) as session:
        run = session.get(Log01Run, run_id)
        if not run:
            raise HTTPException(status_code=404, detail="No existe la corrida solicitada.")

        art = session.exec(
            select(Log01Artifact)
            .where(Log01Artifact.run_id == run_id, Log01Artifact.kind == kind_map[kind])
        ).first()

        if not art:
            raise HTTPException(status_code=404, detail="No existe el artefacto solicitado.")

        abs_path = settings.data_dir / art.storage_rel_path
        if not abs_path.exists():
            raise HTTPException(status_code=404, detail="El archivo no está disponible en el almacenamiento.")

        return FileResponse(
            path=str(abs_path),
            filename=art.filename,
            media_type=art.content_type,
        )


@router.delete("/history/{run_id}")
def log01_history_soft_delete(
    run_id: int,
    payload: Log01RunDeleteRequest | None = None,
    sess: Dict[str, Any] = Depends(get_current_user_session),
):
    role = sess.get("role")
    username = sess.get("username")

    if not can_manage_users(role, username):
        raise HTTPException(status_code=403, detail="No autorizado para eliminar corridas.")

    with Session(engine) as session:
        run = session.get(Log01Run, run_id)
        if not run:
            raise HTTPException(status_code=404, detail="No existe la corrida solicitada.")

        if run.deleted_at is not None:
            return {"ok": True, "message": "La corrida ya estaba eliminada."}

        run.deleted_at = datetime.utcnow()
        run.deleted_by_user_id = sess.get("userId")
        run.deleted_by_username = sess.get("username")
        run.delete_reason = (payload.reason if payload else None)
        session.add(run)
        session.commit()

        return {"ok": True, "message": "Corrida eliminada (soft delete)."}



# ----------------------------
# Upload + procesamiento + respuesta XLSX (sync)
# ----------------------------
@router.post("/upload")
def log01_upload(
    files: List[UploadFile] = File(...),
    operation_id: Optional[str] = Form(None),
    operationId: Optional[str] = Form(None),
    output_filename: Optional[str] = Form(None),
    source: Optional[str] = Form(None),
):
    # Compatibilidad frontend: aceptar operation_id o operationId
    op_id = ((operation_id or operationId) or "").strip() or None
    logger.info("LOG01 upload operation_id=%s", op_id)
    cancel_token = cancel_manager.create(op_id) if op_id else None
    if op_id:
        progress_manager.ensure(op_id)
        

    file_items: List[Log01InputFile] = []
    for idx, up in enumerate(files, start=1):
        name = up.filename or f"archivo_{idx}.xlsx"
        data = up.file.read()
        up.file.close()
        file_items.append(Log01InputFile(name=name, data=data))

    src = (source or "AUTO").strip().upper()
    if src not in ("AUTO", "BASES", "GASELAG"):
        raise HTTPException(status_code=400, detail="source inválido. Use AUTO, BASES o GASELAG.")

    src = cast(SourceLiteral, src)

    try:
        res = process_log01_files(
            file_items=file_items,
            operation_id=op_id,
            output_filename=output_filename,
            cancel_token=cancel_token,
            source=src,
        )
        xlsx_bytes = res.xlsx_bytes
        out_name = res.out_name
    except Log01Cancelled:
        if op_id:
            progress_manager.finish(op_id)
        raise HTTPException(
            status_code=499,
            detail="Operacion cancelada por el usuario.",
            headers={"X-Code": "CANCELLED"},
        )
    finally:
        if op_id:
            cancel_manager.remove(op_id)

    if op_id:
        progress_manager.finish(op_id)

    headers = {
        "X-File-Name": out_name,
        "Content-Disposition": f'attachment; filename="{out_name}"',
    }
    return Response(
        content=xlsx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )
