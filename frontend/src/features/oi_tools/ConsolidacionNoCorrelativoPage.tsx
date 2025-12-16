import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import type { AxiosError } from "axios";
import type { ProgressEvent } from "../../api/integrations";
import type { MergeUploadLimits } from "../../api/oiTools";
import {
  cancelMergeOperation,
  getMergeUploadLimits,
  mergeOisUpload,
  subscribeOiToolsProgress,
} from "../../api/oiTools";
import MultiFilePicker from "./components/MultiFilePicker";
import SingleFilePicker from "./components/SingleFilePicker";
import {
  translateProgressMessage,
  translateProgressStage,
  translateProgressType,
} from "./progressTranslations";

function parseFilename(contentDisposition?: string) {
  if (!contentDisposition) return null;
  const m = /filename\*?=(?:UTF-8'')?("?)([^";]+)\1/i.exec(contentDisposition);
  return m?.[2] ? decodeURIComponent(m[2]) : null;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function extractAxiosError(e: unknown): Promise<string> {
  if (!axios.isAxiosError(e)) return String(e);
  const ax = e as AxiosError<any>;
  const data = ax.response?.data;
  if (data instanceof Blob) {
    try {
      const text = await data.text();
      const parsed = JSON.parse(text) as any;
      return String(parsed?.detail ?? text ?? ax.message);
    } catch {
      return ax.message;
    }
  }
  return String((data as any)?.detail ?? ax.message);
}

export default function ConsolidacionNoCorrelativoPage() {
  const [limits, setLimits] = useState<MergeUploadLimits | null>(null);
  const [masterFile, setMasterFile] = useState<File | null>(null);
  const [technicianFiles, setTechnicianFiles] = useState<File[]>([]);

  const [running, setRunning] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [progressPct, setProgressPct] = useState<number | null>(null);
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const operationIdRef = useRef<string | null>(null);

  const canRun = useMemo(
    () => !!masterFile && technicianFiles.length > 0 && !running,
    [masterFile, technicianFiles, running]
  );

  useEffect(() => {
    getMergeUploadLimits()
      .then(setLimits)
      .catch(() => setLimits(null));
  }, []);

  function pushEvent(ev: ProgressEvent) {
    setEvents((prev) => [ev, ...prev].slice(0, 200));

    const pct =
      typeof ev.percent === "number"
        ? ev.percent
        : typeof ev.progress === "number"
          ? ev.progress
          : null;
    if (pct != null && Number.isFinite(pct)) setProgressPct(Math.max(0, Math.min(100, pct)));
  }

  function stopStream() {
    abortRef.current?.abort();
    abortRef.current = null;
  }

  function cancelOperation() {
    if (!running) return;
    const op = operationIdRef.current;
    if (op) cancelMergeOperation(op).catch(() => {});
    pushEvent({ type: "status", stage: "cancelled", message: "Cancelación solicitada" });
    stopStream();
  }

  async function run() {
    setErrorMsg("");
    setEvents([]);
    setProgressPct(0);

    if (!masterFile) {
      setErrorMsg("Selecciona el archivo maestro.");
      return;
    }
    if (technicianFiles.length === 0) {
      setErrorMsg("Selecciona al menos un archivo de técnico.");
      return;
    }

    const form = new FormData();
    form.append("master", masterFile);
    for (const f of technicianFiles) form.append("technicians", f);

    const operationId = crypto.randomUUID();
    operationIdRef.current = operationId;
    form.append("operation_id", operationId);

    abortRef.current = new AbortController();

    setRunning(true);
    try {
      const signal = abortRef.current?.signal;

      subscribeOiToolsProgress(operationId, pushEvent, signal).catch(() => {
        // si el stream falla, igual dejamos que el request principal continúe
      });

      const res = await mergeOisUpload(form, "no-correlativo", signal);

      const cd = res.headers["content-disposition"] as string | undefined;
      const filename = parseFilename(cd) ?? "consolidado_no_correlativo.xlsx";
      downloadBlob(res.data, filename);
    } catch (e) {
      if (axios.isAxiosError(e) && e.code === "ERR_CANCELED") return;
      if (axios.isAxiosError(e)) {
        const code = (e.response?.headers?.["x-code"] as string | undefined) ?? undefined;
        if (code?.toUpperCase() === "CANCELLED") return;
      }
      const detail = await extractAxiosError(e);
      pushEvent({ type: "error", stage: "error", detail });
      setErrorMsg(detail);
    } finally {
      operationIdRef.current = null;
      setRunning(false);
      stopStream();
    }
  }

  return (
    <div className="container-fluid">
      <div className="row">
        <div className="col-md-7">
          <div className="bgc-white p-20 bd">
            <h4 className="c-grey-900 mB-10">Consolidación — No correlativo</h4>
            <p className="text-muted mB-20">
              Genera un consolidado sin ordenar por correlativo (respeta el orden original).
            </p>

            {limits && (
              <div className="alert alert-info" role="alert">
                Límite por archivo: <b>{limits.max_file_mb}MB</b> · Máx. archivos técnico:{" "}
                <b>{limits.max_tech_files}</b>
              </div>
            )}

            <div className="row">
              <div className="col-12 mB-15">
                <SingleFilePicker
                  label="Archivo maestro (xlsx)"
                  accept=".xlsx"
                  file={masterFile}
                  onChange={setMasterFile}
                  disabled={running}
                />
              </div>

              <div className="col-12 mB-15">
                <MultiFilePicker
                  label="Archivos de técnicos (xlsx)"
                  title="Archivos de técnicos"
                  accept=".xlsx"
                  files={technicianFiles}
                  setFiles={setTechnicianFiles}
                  disabled={running}
                />
              </div>
            </div>

            {errorMsg && (
              <div className="alert alert-danger mT-10" role="alert">
                {errorMsg}
              </div>
            )}
            <div className="d-flex gap-10 mT-20"> 
            <button className="btn btn-primary mT-10" disabled={!canRun} onClick={run}>
              {running ? "Procesando..." : "Procesar y Descargar"}
            </button>
            <button
                className="btn btn-outline-danger mT-10"
                disabled={!running}
                onClick={cancelOperation}
              >
                Cancelar
              </button>
              </div> 
          </div>
        </div>

        <div className="col-md-5">
          <div className="bgc-white p-20 bd">
            <h5 className="c-grey-900 mB-10 d-flex align-items-center gap-2">
              <span>Progreso</span>
              {running ? (
                <img
                  className="vi-progress-spinner"
                  src="/medileser/Spinner-Logo-Medileser.gif"
                  alt="Procesando"
                />
              ) : null}
            </h5>

            <div className="progress mB-15" style={{ height: 12 }}>
              <div
                className="progress-bar"
                role="progressbar"
                style={{ width: `${progressPct ?? 0}%` }}
                aria-valuenow={progressPct ?? 0}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            </div>

            <div style={{ maxHeight: 420, overflow: "auto" }}>
              {events.length === 0 ? (
                <div className="text-muted">Sin eventos aún.</div>
              ) : (
                <ul className="list-unstyled mB-0">
                  {events.map((ev, i) => (
                    <li key={i} className="mB-10">
                      <div>
                        <b>{translateProgressType(ev.type)}</b>{" "}
                        {ev.stage ? (
                          <span className="text-muted">[{translateProgressStage(ev.stage)}]</span>
                        ) : null}
                      </div>
                      <div className="text-muted">
                        {translateProgressMessage(ev.message ?? ev.detail ?? "")}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
