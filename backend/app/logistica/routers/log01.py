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

from datetime import datetime
from sqlalchemy import func
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
                run = Log01Run(
                    operation_id=operation_id,
                    source=job.source,
                    output_name=out_name,
                    status="COMPLETADO",
                    created_at=datetime.utcnow(),
                    completed_at=datetime.utcnow(),
                    created_by_user_id=sess_snapshot["user_id"],
                    created_by_username=()
                )
                

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

    thread = threading.Thread(
        target=_run_log01_job,
        args=(job, file_items, output_filename),
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
