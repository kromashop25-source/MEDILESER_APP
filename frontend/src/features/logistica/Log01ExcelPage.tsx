import { useRef, useState } from "react";
import axios from "axios";
import type { AxiosError } from "axios";
import type { ProgressEvent } from "../../api/integrations";
import {
  cancelLog01Operation,
  log01Upload,
  subscribeLog01Progress,
} from "../../api/oiTools";
import MultiFilePicker from "../oi_tools/components/MultiFilePicker";
import {
  translateProgressMessage,
  translateProgressStage,
  translateProgressType,
} from "../oi_tools/progressTranslations";

// Copia tal cual de ActualizacionBasePage.tsx (si ya lo tienes ahí, reutilízalo)
function parseFilename(contentDisposition?: string): string | null {
  if (!contentDisposition) return null;
  const m = /filename\*=UTF-8''([^;]+)|filename="([^"]+)"/i.exec(contentDisposition);
  const raw = m?.[1] ?? m?.[2];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

export default function Log01ExcelPage() {
  const [files, setFiles] = useState<File[]>([]);
  const [outputFilename, setOutputFilename] = useState<string>("");

  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [progressPct, setProgressPct] = useState<number>(0);
  const [progressLabel, setProgressLabel] = useState<string>("Listo para procesar");
  const [running, setRunning] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string>("");

  const uploadAbortRef = useRef<AbortController | null>(null);
  const progressAbortRef = useRef<AbortController | null>(null);
  const operationIdRef = useRef<string | null>(null);

  function pushEvent(ev: ProgressEvent) {
    const label = `${translateProgressType(ev.type)} · ${translateProgressStage(ev.stage)} · ${translateProgressMessage(
      (ev as any).message ?? (ev as any).detail ?? ""
    )}`;
    setProgressLabel(label);
    setEvents((prev) => [...prev, ev]);
    if (typeof (ev as any).progress === "number") setProgressPct((ev as any).progress);
    if (typeof (ev as any).percent === "number") setProgressPct(Math.round((ev as any).percent));
  }

  function buildForm(operationId: string) {
    const form = new FormData();
    form.append("operation_id", operationId);
    if (outputFilename.trim()) form.append("output_filename", outputFilename.trim());
    for (const f of files) form.append("files", f);
    return form;
  }

  function stopProgressStream() {
    progressAbortRef.current?.abort();
    progressAbortRef.current = null;
  }

  function stopUpload() {
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
  }

  async function cancelOperation() {
    if (!running) return;
    const operationId = operationIdRef.current;
    if (operationId) {
      try {
        await cancelLog01Operation(operationId);
      } catch (e) {
        const ax = e as AxiosError<any>;
        if (!axios.isCancel(ax)) {
          setErrorMsg(
            (ax.response?.data?.detail as string) ||
              ax.message ||
              "No se pudo cancelar la operacion"
          );
        }
      }
    }
    stopUpload();
    stopProgressStream();
  }

  async function run() {
    setErrorMsg("");
    setEvents([]);
    setProgressPct(0);
    setProgressLabel("Listo para procesar");

    if (!files.length) {
      setErrorMsg("Debes seleccionar al menos 1 Excel.");
      return;
    }

    const operationId = crypto.randomUUID();
    operationIdRef.current = operationId;
    progressAbortRef.current = new AbortController();
    uploadAbortRef.current = new AbortController();

    // progreso (NDJSON)
    subscribeLog01Progress(operationId, pushEvent, progressAbortRef.current.signal).catch(() => {
      // si el stream falla, el request principal igual continúa
    });

    setRunning(true);
    try {
      const form = buildForm(operationId);
      const res = await log01Upload(form, uploadAbortRef.current.signal);

      const cd = res.headers["content-disposition"] as string | undefined;
      const xf = res.headers["x-file-name"] as string | undefined;
      const filename = parseFilename(cd) ?? xf ?? "BD_CONSOLIDADO.xlsx";
      downloadBlob(res.data, filename);
    } catch (e) {
      const ax = e as AxiosError<any>;
      if (axios.isCancel(ax)) return;
      const detail = (ax.response?.data?.detail as string) || ax.message || "Error inesperado";
      setErrorMsg(detail);
    } finally {
      stopUpload();
      stopProgressStream();
      operationIdRef.current = null;
      setRunning(false);
    }
  }

  return (
    <div className="container-fluid">
      <div className="row">
        <div className="col-12">
          <div className="bd bgc-white p-20 mB-20">
            <h4 className="c-grey-900 mB-10">LOG-01 · Consolidación Excel</h4>

            {errorMsg && (
              <div className="alert alert-danger" role="alert">
                {errorMsg}
              </div>
            )}

            <div className="row">
              <div className="col-12 mB-15">
                <MultiFilePicker
                  label="Bases Comerciales (xlsx)"
                  title="Archivos Base Comercial"
                  accept=".xlsx"
                  files={files}
                  setFiles={setFiles}
                  disabled={running}
                />
              </div>

              <div className="col-md-6 mB-15">
                <label className="form-label">Nombre de salida (opcional)</label>
                <input
                  className="form-control"
                  value={outputFilename}
                  onChange={(e) => setOutputFilename(e.target.value)}
                  placeholder="BD_<SERIE_INI>_AL_<SERIE_FIN>.xlsx"
                  disabled={running}
                />
              </div>

              <div className="col-md-6 mB-15 d-flex align-items-end">
                <div className="d-flex gap-10 w-100">
                  <button className="btn btn-primary w-100" onClick={run} disabled={running}>
                    {running ? "Procesando..." : "Consolidar y descargar"}
                  </button>
                  {running ? (
                    <button
                      className="btn btn-outline-danger"
                      onClick={() => void cancelOperation()}
                    >
                      Cancelar
                    </button>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="mT-10">
              <h6 className="c-grey-900 mB-10 d-flex align-items-center gap-2">
                <span>Progreso</span>
                {running ? (
                  <img
                    className="vi-progress-spinner"
                    src="/medileser/Spinner-Logo-Medileser.gif"
                    alt="Procesando"
                  />
                ) : null}
              </h6>
              <div className="progress">
                <div
                  className="progress-bar"
                  role="progressbar"
                  style={{ width: `${progressPct}%` }}
                  aria-valuenow={progressPct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  {progressPct}%
                </div>
              </div>
              <div className="mT-10 text-muted">{progressLabel}</div>
            </div>

            {events.length > 0 && (
              <div className="mT-20">
                <h6 className="c-grey-900">Eventos</h6>
                <div className="bd p-10" style={{ maxHeight: 240, overflow: "auto" }}>
                  {events.map((ev, i) => (
                    <div key={i} className="small">
                      {translateProgressType(ev.type)} · {translateProgressStage(ev.stage)} ·{" "}
                      {translateProgressMessage((ev as any).message ?? (ev as any).detail ?? "")}

                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
