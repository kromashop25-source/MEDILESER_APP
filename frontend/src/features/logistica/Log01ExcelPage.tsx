import { useMemo, useRef, useState } from "react";
import axios from "axios";
import type { AxiosError } from "axios";
import type { ProgressEvent } from "../../api/integrations";
import {
  cancelLog01Operation,
  log01Manifest,
  log01NoConformeFinal,
  log01Result,
  log01Start,
  pollLog01Progress,
  subscribeLog01Progress,
} from "../../api/oiTools";
import MultiFilePicker from "../oi_tools/components/MultiFilePicker";
import {
  translateProgressMessage,
  translateProgressStage,
  translateProgressType,
} from "../oi_tools/progressTranslations";

const isDev = import.meta.env.DEV;
const logDev = (...args: unknown[]) => {
  if (isDev) console.info(...args);
};

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

async function waitForHello(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeoutId: number | null = null;
  let timedOut = false;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutId = window.setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
  });
  try {
    await Promise.race([promise, timeoutPromise]);
  } catch {
    return false;
  } finally {
    if (timeoutId != null) window.clearTimeout(timeoutId);
  }
  return !timedOut;
}

export default function Log01ExcelPage() {
  const [files, setFiles] = useState<File[]>([]);
  const [outputFilename, setOutputFilename] = useState<string>("");

  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [progressPct, setProgressPct] = useState<number>(0);
  const [progressLabel, setProgressLabel] = useState<string>("Listo para procesar");
  const [running, setRunning] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [resultReady, setResultReady] = useState<boolean>(false);
  const [resultOperationId, setResultOperationId] = useState<string | null>(null);
  const [auditSummary, setAuditSummary] = useState<any | null>(null);
  const [showTechAudit, setShowTechAudit] = useState(false);

  function getDuplicatesEliminated(summary: any): number | null {
    const v =
      summary?.series_duplicates_eliminated ??
      summary?.detail?.series_duplicates_eliminated ??
      // backward-compat (typo viejo)
      summary?.series_duplcates_eliminated;
    return typeof v === "number" ? v : null; 
  }

  const ERROR_CODE_LABELS: Record<string, string> = {
    MISSING_HEADERS: "Faltan cabeceras requeridas",
    FILE_INVALID: "Archivo inválido",
    INVALID_OI_FILENAME: "Nombre de archivo inválido",
    EMPTY_FILE: "Archivo vacío",
  };

  function translateErrorCode(code?: string): string {
    const key = String(code ?? "").trim().toUpperCase();
    if (!key) return "";
    return ERROR_CODE_LABELS[key] ?? key;
  }

  function normalizeErrorText(text?: string): string {
    if (!text) return "";
    let out = translateProgressMessage(text);
    out = out.replace(/\bERROR\b/gi, "Error");
    for (const [code, label] of Object.entries(ERROR_CODE_LABELS)) {
      out = out.replace(new RegExp(`\\b${code}\\b`, "g"), label);
    }
    return out;
  }
  function buildMotivo(code?: string, detail?: string): string {
    const codeLabel = translateErrorCode(code);
    const detailText = normalizeErrorText(detail);
    if (detailText) {
      if (codeLabel && !detailText.toLowerCase().includes(codeLabel.toLowerCase())) {
        return `${codeLabel}: ${detailText}`;
      }
      return detailText;
    }
    return codeLabel || "N/D";
  }


  function fmtOiNum(n: any): string {
    const num = Number(n);
    if (!Number.isFinite(num) || num <= 0) return "N/D";
    return `OI-${String(num).padStart(4, "0")}`;
  }

  function getRowsTotalRead(summary: any): number | null {
    const v = summary?.rows_total_read ?? summary?.totals_input?.rows_read;
    return typeof v === "number" ? v : null;
  }

  // Ordenar auditoria por OI (asc) para visualización consistente
  const auditByOiOkSorted = useMemo(() => {
    const list = Array.isArray(auditSummary?.audit_by_oi) ? auditSummary.audit_by_oi : [];
    return list
      .filter((x: any) => x?.status === "OK" && String(x?.source ?? "").toUpperCase() === "BASES")
      .slice() // IMPORTANTE: evitar mutar auditSummary.audit_by_oi con sort()
      .sort((a: any, b: any) => {
        const aNum = Number(a?.oi_num);
        const bNum = Number(b?.oi_num);
        const aHas = Number.isFinite(aNum);
        const bHas = Number.isFinite(bNum);
        if (aHas && bHas) return aNum - bNum;
        if (aHas && !bHas) return -1;
        if (!aHas && bHas) return 1;
        // fallback estable por texto si faltara oi_num
        const aKey = String(a?.oi_num ?? a?.oi ?? "").toUpperCase();
        const bKey = String(b?.oi_num ?? b?.oi ?? "").toUpperCase();
        return aKey.localeCompare(bKey);
      })
  }, [auditSummary]);

  const auditRejectedSorted = useMemo(() => {
    const list = Array.isArray(auditSummary?.files_rejected) ? auditSummary.files_rejected : [];
    return list.slice().sort((a: any, b: any) => {
      const aKey = String(a?.oi ?? a?.filename ?? "").toUpperCase();
      const bKey = String(b?.oi ?? b?.filename ?? "").toUpperCase();
      return aKey.localeCompare(bKey);
    });
  }, [auditSummary]);

  const bySource = useMemo(() => {
    const init = () => ({
      files_total: 0,
      files_ok: 0,
      files_error: 0,
      rows_read: 0,
      conformes: 0,
      no_conformes: 0,
      rows_ignored_invalid_estado: 0,      
    });

    const bs = (auditSummary as any)?.by_source;
    if (bs && typeof bs === "object") return bs;

    // Fallback: derivar desde audit_by_oi + files_rejected
    const out: any = { BASES: init(), GASELAG: init() };
    const okList = Array.isArray((auditSummary as any)?.audit_by_oi) ? (auditSummary as any).audit_by_oi : [];
    for (const x of okList) {
      if (x?.status !== "OK") continue;
      const src = String(x?.source ?? "").toUpperCase();
      const k = src === "GASELAG" ? "GASELAG" : "BASES";
      out[k].files_ok += 1;
      out[k].rows_read += Number(x?.rows_read ?? 0) || 0;
      out[k].conformes += Number(x?.conformes ?? 0) || 0;
      out[k].no_conformes += Number(x?.no_conformes ?? 0) || 0;
      out[k].rows_ignored_invalid_estado += Number(x?.rows_ignored_invalid_estado ?? 0) || 0;
    }
    const rejList = Array.isArray((auditSummary as any)?.files_rejected) ? (auditSummary as any).files_rejected : [];
    for (const r of rejList) {
      const src = String(r?.source ?? "").toUpperCase();
      const k = src === "GASELAG" ? "GASELAG" : "BASES";
      out[k].files_error += 1;
    }
    for (const k of ["BASES" , "GASELAG"]) out[k].files_total = out[k].files_ok + out[k].files_error;
    return out;
  }, [auditSummary]);

  const uploadAbortRef = useRef<AbortController | null>(null);
  const progressAbortRef = useRef<AbortController | null>(null);
  const progressAbortReasonRef = useRef<string | null>(null);
  const terminalEventRef = useRef<boolean>(false);
  const operationIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const pollInFlightRef = useRef<boolean>(false);
  const pollingActiveRef = useRef<boolean>(false);
  const pollCursorRef = useRef<number>(-1);
  const lastCursorRef = useRef<number>(-1);
  const cancelInfoPushedRef = useRef<boolean>(false);

  function getOrCreateOperationId() {
    if (!operationIdRef.current) {
      operationIdRef.current = crypto.randomUUID();
    }
    return operationIdRef.current;
  }

  function pushEvent(ev: ProgressEvent) {
    const label = `${translateProgressType(ev.type)} · ${translateProgressStage(ev.stage)} · ${normalizeErrorText(
      (ev as any).message ?? (ev as any).detail ?? ""
    )}`;
    setProgressLabel(label);
    setEvents((prev) => {
      const next = [ev, ...prev];

      // Matiz UX: al cancelar, agregar un evento final con resumen de avance
      if (!cancelInfoPushedRef.current && ev.stage === "cancelled") {
        cancelInfoPushedRef.current = true;
        const processed = next.filter((e) => e.stage === "file_done" || e.stage === "file_error").length;
        const ok = next.filter((e) => e.stage === "file_done").length;
        const rejected = next.filter((e) => e.stage === "file_error").length;

        const summaryEv = {
          type: "status",
          stage: "cancelled",
          message: `Cancelación aplicada. Archivos procesados hasta el momento: ${processed} (OK: ${ok}, Rechazados: ${rejected}). No se generó resultado final.`,
        } as unknown as ProgressEvent;

        return [summaryEv, ...next];
      }

      return next;
    });

    // Capturar resumen de auditoría al completar
    if (ev.type === "complete") {
      const res = (ev as any).result ?? null;
      setAuditSummary(res);
    }

    if (typeof (ev as any).progress === "number") {
      setProgressPct(Math.round((ev as any).progress));
    }
    if (typeof (ev as any).percent === "number") setProgressPct(Math.round((ev as any).percent));
    if (!terminalEventRef.current && (ev.type === "complete" || ev.stage === "cancelled" || ev.stage === "failed")) {
      terminalEventRef.current = true;
      if (ev.type === "complete") {
        setResultReady(true);
        setResultOperationId(operationIdRef.current);
      } else {
        setResultReady(false);
        setResultOperationId(null);
        operationIdRef.current = null;
      }
      setRunning(false);
      stopProgressStream("terminal_event");
      stopPolling("terminal_event");
    }
  }

  function shouldSkipEvent(ev: ProgressEvent) {
    if (typeof ev.cursor !== "number") return false;
    if (ev.cursor <= lastCursorRef.current) return true;
    lastCursorRef.current = ev.cursor;
    if (ev.cursor > pollCursorRef.current) {
      pollCursorRef.current = ev.cursor;
    }
    return false;
  }

  function handleEvent(ev: ProgressEvent) {
    // Si ya ocurrió un evento terminal (complete/cancelled/failed),
    // ignorar cualquier evento posterior (race con polling o stream).
    if (terminalEventRef.current) return;
    if (shouldSkipEvent(ev)) return;
    pushEvent(ev);
  }

  function buildForm(operationId: string, allFiles: File[]) {
    const form = new FormData();
    form.append("operation_id", operationId);
    form.append("source", "AUTO");
    if (outputFilename.trim()) form.append("output_filename", outputFilename.trim());
    for (const f of allFiles) form.append("files", f);
    return form;
  }

  function stopProgressStream(reason: string) {
    if (!progressAbortRef.current) return;
    progressAbortReasonRef.current = reason;
    logDev("[LOG01] progress abort reason =", reason);
    progressAbortRef.current.abort();
    progressAbortRef.current = null;
  }

  function stopPolling(reason: string) {
    if (!pollingActiveRef.current) return;
    pollingActiveRef.current = false;
    if (pollTimerRef.current != null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    pollInFlightRef.current = false;
    logDev("[LOG01] polling stopped =", reason);
  }

  function schedulePoll(delayMs: number) {
    if (!pollingActiveRef.current) return;
    if (pollTimerRef.current != null) window.clearTimeout(pollTimerRef.current);
    pollTimerRef.current = window.setTimeout(() => {
      void pollOnce();
    }, delayMs);
  }

  async function pollOnce() {
    if (!pollingActiveRef.current || pollInFlightRef.current) return;
    const operationId = operationIdRef.current;
    if (!operationId) {
      stopPolling("no_operation_id");
      return;
    }
    pollInFlightRef.current = true;
    try {
      const res = await pollLog01Progress(
        operationId,
        pollCursorRef.current,
        pollAbortRef.current?.signal
      );
      logDev("[LOG01] poll cursor =", pollCursorRef.current, "->", res.cursor_next);
      pollCursorRef.current = res.cursor_next;
      for (const ev of res.events) handleEvent(ev);
      if (res.done && res.events.length === 0) {
        stopPolling("done");
        return;
      }
    } catch (err) {
      const name = (err as any)?.name as string | undefined;
      if (name !== "AbortError") {
        logDev("[LOG01] poll error =", err);
      }
    } finally {
      pollInFlightRef.current = false;
      if (pollingActiveRef.current) schedulePoll(350);
    }
  }

  function startPolling(reason: string) {
    if (pollingActiveRef.current) return;
    pollingActiveRef.current = true;
    pollAbortRef.current = new AbortController();
    logDev("[LOG01] fallback polling enabled =", reason);
    schedulePoll(0);
  }

  function stopUpload() {
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
  }

  async function cancelOperation() {
    if (!running) return;
    const operationId = operationIdRef.current;
    if (operationId) {
      logDev("[LOG01] operation_id(cancel) =", operationId);
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
  }

  async function run() {
    setErrorMsg("");
    setEvents([]);
    setAuditSummary(null);
    setProgressPct(0);
    setProgressLabel("Listo para procesar");
    setResultReady(false);
    setResultOperationId(null);
    progressAbortReasonRef.current = null;
    terminalEventRef.current = false;
    cancelInfoPushedRef.current = false;
    pollCursorRef.current = -1;
    lastCursorRef.current = -1;
    stopPolling("reset");

    const allFiles = [...files];
    if (!allFiles.length) {
      setErrorMsg("Debes seleccionar al menos 1 Excel.");
      return;
    }

    operationIdRef.current = null;
    const operationId = getOrCreateOperationId();
    let helloResolve: (() => void) | null = null;
    let helloReject: ((err: Error) => void) | null = null;
    const helloPromise = new Promise<void>((resolve, reject) => {
      helloResolve = resolve;
      helloReject = reject;
    });
    progressAbortRef.current = new AbortController();
    uploadAbortRef.current = new AbortController();

    // progreso (NDJSON)
    logDev("[LOG01] operation_id(stream) =", operationId);
    const onProgressEvent = (ev: ProgressEvent) => {
      if (ev.type === "hello") {
        if (helloResolve) {
          helloResolve();
          helloResolve = null;
        }
        return;
      }
      handleEvent(ev);
    };
    const streamPromise = subscribeLog01Progress(
      operationId,
      onProgressEvent,
      progressAbortRef.current.signal
    );
    streamPromise.then(() => {
      if (!terminalEventRef.current) {
        startPolling("stream_closed");
      }
    }).catch((err) => {
      const name = (err as any)?.name as string | undefined;
      if (name === "AbortError") {
        logDev("[LOG01] progress stream aborted (reason) =", progressAbortReasonRef.current);
      } else {
        logDev("[LOG01] progress stream error =", err);
        if (helloReject) {
          helloReject(err as Error);
          helloReject = null;
        }
        startPolling("stream_error");
      }
    });

    setRunning(true);
    try {
      // Esperar el handshake "hello" evita la carrera entre stream y start.
      const helloOk = await waitForHello(helloPromise, 1800);
      if (!helloOk) {
        startPolling("hello_timeout");
      } else {
        logDev("[LOG01] hello received");
      }
      const form = buildForm(operationId, allFiles);
      logDev("[LOG01] operation_id(start) =", operationId);
      await log01Start(form, uploadAbortRef.current!.signal);
    } catch (e) {
      const ax = e as AxiosError<any>;
      if (axios.isCancel(ax)) return;
      const detail = (ax.response?.data?.detail as string) || ax.message || "Error inesperado";
      setErrorMsg(detail);
      setRunning(false);
      stopUpload();
      stopProgressStream("start_failed");
      stopPolling("start_failed");
      operationIdRef.current = null;
    } finally {
      stopUpload();
    }
  }

  async function downloadResult() {
    const operationId = resultOperationId ?? operationIdRef.current;
    if (!operationId) {
      setErrorMsg("No hay resultado disponible.");
      return;
    }
    try {
      setErrorMsg("");
      logDev("[LOG01] operation_id(result) =", operationId);
      const res = await log01Result(operationId);
      const cd = res.headers["content-disposition"] as string | undefined;
      const xf = res.headers["x-file-name"] as string | undefined;
      const filename = parseFilename(cd) ?? xf ?? "BD_CONSOLIDADO.xlsx";
      downloadBlob(res.data, filename);
    } catch (e) {
      const ax = e as AxiosError<any>;
      if (axios.isCancel(ax)) return;
      const detail = (ax.response?.data?.detail as string) || ax.message || "No se pudo descargar.";
      setErrorMsg(detail);
    }
  }

  async function downloadManifest() {
    const operationId = resultOperationId ?? operationIdRef.current;
    if (!operationId) {
      setErrorMsg("No hay resultado disponible.");
      return;
    }
    try {
      setErrorMsg("");
      logDev("[LOG01] operation_id(manifest) =", operationId);
      const res = await log01Manifest(operationId);
      const cd = res.headers["content-disposition"] as string | undefined;
      const xf = res.headers["x-file-name"] as string | undefined;
      const filename = parseFilename(cd) ?? xf ?? "MANIFIESTO.json";
      downloadBlob(res.data, filename);
    } catch (e) {
      const ax = e as AxiosError<any>;
      if (axios.isCancel(ax)) return;
      const detail = (ax.response?.data?.detail as string) || ax.message || "No se pudo descargar.";
      setErrorMsg(detail);
    }
  }

  async function downloadNoConformeFinal() {
    const operationId = resultOperationId ?? operationIdRef.current;
    if (!operationId) {
      setErrorMsg("No hay resultado disponible.");
      return;
    }
    try {
      setErrorMsg("");
      logDev("[LOG01] operation_id(no_conforme) =", operationId);
      const res = await log01NoConformeFinal(operationId);
      const cd = res.headers["content-disposition"] as string | undefined;
      const xf = res.headers["x-file-name"] as string | undefined;
      const filename = parseFilename(cd) ?? xf ?? "NO_CONFORME_FINAL.json";
      downloadBlob(res.data, filename);
    } catch (e) {
      const ax = e as AxiosError<any>;
      if (axios.isCancel(ax)) return;
      const detail = (ax.response?.data?.detail as string) || ax.message || "No se pudo descargar.";
      setErrorMsg(detail);
    }
  }

  return (
    <div className="container-fluid">
      <div className="row">
        <div className="col-12">
          <div className="bd bgc-white p-20 mB-20">
            <h4 className="c-grey-900 mB-10">Consolidación Excel</h4>

            {errorMsg && (
              <div className="alert alert-danger" role="alert">
                {errorMsg}
              </div>
            )}

            <div className="row">
              <div className="col-12 mB-15">
                <MultiFilePicker
                  label="Archivos Excel (Bases Comerciales / GASELAG) (xlsx)"
                  title="Archivos Excel"
                  accept=".xlsx"
                  files={files}
                  setFiles={setFiles}
                  fullDropArea
                  disabled={running}
                />
                <div className="small text-muted mT-5">
                  Nota: el sistema identifica el tipo de archivo por cabeceras/contenido (AUTO). No depende del nombre.
                </div>
              </div>

              <div className="col-md-6 mB-15">
                <label className="form-label mB-0">Nombre de salida (opcional)</label>
                <input
                  className="form-control"
                  value={outputFilename}
                  onChange={(e) => setOutputFilename(e.target.value)}
                  placeholder="BD_<SERIE_INI>_AL_<SERIE_FIN>.xlsx"
                  disabled={running}
                />
              </div>

              <div className="col-md-6 mB-15">
                {/* label invisible para alinear visualmente con el bloque del input (label+control) */}                
                <label className="form-label mB-0 invisible">Acciones</label>
                <div className="vi-log01-actions">
                  <button
                    className="btn btn-primary btn-sm vi-log01-btn-primary"
                    onClick={run}
                    disabled={running}
                  >
                    {running ? "Procesando..." : "Consolidar"}
                  </button>
                  {running ? (
                    <button
                      className="btn btn-outline-danger btn-sm"
                      onClick={() => void cancelOperation()}
                    >
                      Cancelar
                    </button>
                  ) : null}
                  {!running && resultReady ? (
                    <>
                      <button
                        className="btn btn-outline-secondary btn-sm"
                        onClick={() => void downloadManifest()}
                      >
                        Manifiesto (JSON)
                      </button>
                      <button
                        className="btn btn-outline-secondary btn-sm"
                        onClick={() => void downloadNoConformeFinal()}
                      >
                        No conforme (JSON)
                      </button>
                      <button
                        className="btn btn-outline-success btn-sm"
                        onClick={() => void downloadResult()}
                      >
                        Descargar
                      </button>
                    </>
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

            {!running && auditSummary ? (
              <div className="mT-20">
                <h6 className="c-grey-900">Reporte de auditoría</h6>
                <div className="bd p-10">
                  <div className="row">
                    <div className="col-md-6">
                      <div className="small text-muted">Archivos</div>
                      <div className="small">
                        Total: <strong>{auditSummary.files_total ?? "N/D"}</strong> · OK:{" "}
                        <strong>{auditSummary.files_ok ?? "N/D"}</strong> · Rechazados:{" "}
                        <strong>{auditSummary.files_error ?? "N/D"}</strong>
                      </div>

                      <div className="mT-10 small text-muted">Totales por tipo (origen)</div>
                      <div className="table-responsive">
                        <table className="table table-sm mB-0">
                          <thead>
                            <tr className="small">
                              <th style={{ whiteSpace: "nowrap" }}>Tipo</th>
                              <th style={{ whiteSpace: "nowrap" }}>Archivos</th>
                              <th style={{ whiteSpace: "nowrap" }}>Leídos</th>
                              <th style={{ whiteSpace: "nowrap" }}>Conformes</th>
                              <th style={{ whiteSpace: "nowrap" }}>No conformes</th>
                              <th style={{ whiteSpace: "nowrap" }}>Ignorados</th>
                            </tr>
                          </thead>
                          <tbody>
                            {["BASES", "GASELAG"].map((k) => {
                              const b = (bySource as any)?.[k] ?? {};
                              const filesTotal = b?.files_total ?? (Number(b?.files_ok ?? 0) + Number(b?.files_error ?? 0));
                              return (
                                <tr key={k} className="small">
                                  <td style={{ whiteSpace: "nowrap" }}><strong>{k}</strong></td>
                                  <td style={{ whiteSpace: "nowrap" }}>
                                    <strong>{filesTotal ?? 0}</strong>{" "}
                                    <span className="text-muted">
                                      (OK: {b?.files_ok ?? 0} · Rech: {b?.files_error ?? 0})
                                    </span>
                                  </td>
                                  <td style={{ whiteSpace: "nowrap" }}><strong>{b?.rows_read ?? 0}</strong></td>
                                  <td style={{ whiteSpace: "nowrap" }}><strong>{b?.conformes ?? 0}</strong></td>
                                  <td style={{ whiteSpace: "nowrap" }}><strong>{b?.no_conformes ?? 0}</strong></td>
                                  <td style={{ whiteSpace: "nowrap" }}><strong>{b?.rows_ignored_invalid_estado ?? 0}</strong></td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      <div className="mT-10 small text-muted">No conformes por OI (origen) — BASES</div>

                      {auditByOiOkSorted.length > 0 ? (
                        <div className="table-responsive">
                          <table className="table table-sm mB-0">
                            <thead>
                              <tr className="small">
                                <th style={{ whiteSpace: "nowrap" }}>OI</th>
                                <th style={{ whiteSpace: "nowrap" }}>Leídos</th>
                                <th style={{ whiteSpace: "nowrap" }}>Conformes</th>
                                <th style={{ whiteSpace: "nowrap" }}>No conformes</th>
                              </tr>
                            </thead>
                            <tbody>
                                {auditByOiOkSorted.map((x: any, i: number) => (
                                  <tr key={i} className="small">
                                    <td style={{ whiteSpace: "nowrap" }}>
                                      {fmtOiNum(x?.oi_num)}
                                    </td>
                                    <td style={{ whiteSpace: "nowrap" }}>
                                      <strong>{x?.rows_read ?? 0}</strong>
                                    </td>
                                    <td style={{ whiteSpace: "nowrap" }}>
                                      <strong>{x?.conformes ?? 0}</strong>
                                    </td>
                                    <td style={{ whiteSpace: "nowrap" }}>
                                      <strong>{x?.no_conformes ?? 0}</strong>
                                    </td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="small text-muted">N/D</div>
                      )}

                      {Number((bySource as any)?.GASELAG?.rows_read ?? 0) > 0 ? (
                        <div className="mT-10 small">
                          <span className="text-muted">GASELAG (origen):</span>{" "}
                          Leídos: <strong>{(bySource as any).GASELAG.rows_read ?? 0}</strong> · Conformes:{" "}
                          <strong>{(bySource as any).GASELAG.conformes ?? 0}</strong> · No conformes:{" "}
                          <strong>{(bySource as any).GASELAG.no_conformes ?? 0}</strong> · Ignorados(estado):{" "}
                          <strong>{(bySource as any).GASELAG.rows_ignored_invalid_estado ?? 0}</strong>
                        </div>
                      ) : null}

                      <div className="col-12 mT-10 p-0">
                        <div className="small text-muted">Totales (origen)</div>
                        <div className="small">
                          Registros leídos:{" "}
                          <strong>{auditSummary.totals_input?.rows_read ?? "N/D"}</strong> · Conformes:{" "}
                          <strong>{auditSummary.totals_input?.conformes ?? "N/D"}</strong> · No conformes:{" "}
                          <strong>{auditSummary.totals_input?.no_conformes ?? "N/D"}</strong>
                        </div>
                      </div>
                    </div>

                    <div className="col-md-6 mT-10 mT-md-0">
                      {auditRejectedSorted.length > 0 ? (
                        <div className="mT-15">
                          <div className="small text-muted">Archivos rechazados</div>
                          <div className="table-responsive">
                            <table className="table table-sm mB-0">
                              <thead>
                                <tr className="small">
                                  <th style={{ whiteSpace: "nowrap" }}>OI / Archivo</th>
                                  <th style={{ whiteSpace: "nowrap" }}>Motivo</th>
                                </tr>
                              </thead>
                              <tbody>
                                {auditRejectedSorted.map((r: any, i: number) => {
                                  const motivo = buildMotivo(r?.code, r?.detail);
                                  const src = String(r?.source ?? "").toUpperCase();
                                  let oiOrFile = r?.filename ?? "N/D";
                                  if (src === "BASES") {
                                    const oiNum = Number(r?.oi_num);
                                    const oiTag = fmtOiNum(oiNum);
                                    if (oiTag !== "N/D") {
                                      oiOrFile = `${oiTag} / ${oiOrFile}`;
                                    }
                                  } else if (src === "GASELAG") {
                                    oiOrFile = `GASELAG / ${oiOrFile}`;
                                  }
                                  return (
                                    <tr key={i} className="small">
                                      <td style={{ whiteSpace: "nowrap" }}>{oiOrFile}</td>
                                      <td>{motivo}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ) : null}
                      <div className="small text-muted">Resultado final (post-dedupe)</div>
                      <div className="small">
                        Únicas (post-dedupe):{" "}
                        <strong>{auditSummary.series_total_dedup ?? "N/D"}</strong> · Conformes finales:{" "}
                        <strong>{auditSummary.series_conformes ?? "N/D"}</strong> · No conformes finales:{" "}
                        <strong>{auditSummary.series_no_conformes_final ?? "N/D"}</strong>
                      </div>

                      <div className="mT-10">
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-secondary"
                          onClick={() => setShowTechAudit((v) => !v)}
                        >
                          {showTechAudit ? "Ocultar detalle técnico" : "Ver detalle técnico"}
                        </button>
                      </div>

                      {showTechAudit ? (
                        <div className="mT-10">
                          <div className="small text-muted">Detalle técnico (soporte)</div>
                          <div className="small">
                            Registros leídos (total):{" "}
                            <strong>
                              {getRowsTotalRead(auditSummary) ?? "N/D"}
                            </strong>{" "}
                            · Duplicados eliminados:{" "}
                            <strong>
                              {getDuplicatesEliminated(auditSummary) ?? "N/D"}
                            </strong>
                          {" "}
                            · Únicas = Leídos − Duplicados:{" "}
                            <strong>
                              {(() => {
                                const rows = getRowsTotalRead(auditSummary);
                                const dup = getDuplicatesEliminated(auditSummary);
                                if (typeof rows === "number" && typeof dup === "number") return rows - dup;
                                // fallback: si backend ya trae series_total_dedup, úsalo
                                const uniques = auditSummary.series_total_dedup;
                                return typeof uniques === "number" ? uniques : "N/D";
                              })()}
                            </strong>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}


            {events.length > 0 && (
              <div className="mT-20">
                <h6 className="c-grey-900">Eventos</h6>
                <div className="bd p-10" style={{ maxHeight: 240, overflow: "auto" }}>
                  {events.map((ev, i) => {
                    const msg = String((ev as any).message ?? "");
                    const code = String((ev as any).code ?? "");
                    const detail = String((ev as any).detail ?? "");
                    const baseText = normalizeErrorText(msg || detail || "");
                    const baseLower = baseText.toLowerCase();
                    const codeLabel = translateErrorCode(code);
                    const detailText = normalizeErrorText(detail);
                    const suffixParts: string[] = [];
                    if (codeLabel && !baseLower.includes(codeLabel.toLowerCase())) suffixParts.push(codeLabel);
                    if (detailText && !baseLower.includes(detailText.toLowerCase())) suffixParts.push(detailText);
                    const suffix = suffixParts.join(" · ");

                    return (
                      <div key={i} className="small">
                        {translateProgressType(ev.type)} · {baseText}
                        {suffix ? <span className="text-muted"> ({suffix})</span> : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
