import { useMemo, useRef, useState } from "react";
import axios from "axios";
import type { AxiosError } from "axios";
import type { ProgressEvent, VimaToListaSummary } from "../../api/integrations";
import {
  subscribeVimaToListaProgress,
  vimaToListaDryRunUpload,
  vimaToListaUpload,
} from "../../api/integrations";
import SingleFilePicker from "./components/SingleFilePicker";
import PasswordModal from "../oi/PasswordModal";
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

export default function VimaToListaPage() {
  const [vimaFile, setVimaFile] = useState<File | null>(null);
  const [listaFile, setListaFile] = useState<File | null>(null);
  const [vimaPassword, setVimaPassword] = useState<string>("");

  const [vimaStartRow, setVimaStartRow] = useState<number>(11);
  const [listaStartRow, setListaStartRow] = useState<number>(11);
  const [requireAll, setRequireAll] = useState<boolean>(true);
  const [incremental, setIncremental] = useState<boolean>(true);
  const [strictIncremental, setStrictIncremental] = useState<boolean>(true);
  const [replicateMerges, setReplicateMerges] = useState<boolean>(true);
  const [oiPattern, setOiPattern] = useState<string>("");

  const [running, setRunning] = useState<"dry" | "upload" | null>(null);
  const [summary, setSummary] = useState<VimaToListaSummary | null>(null);

  const [progressPct, setProgressPct] = useState<number | null>(null);
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [errorMsg, setErrorMsg] = useState<string>("");

  const abortRef = useRef<AbortController | null>(null);
  const pendingPasswordActionRef = useRef<"dry" | "upload" | null>(null);

  const [showMoreOptions, setShowMoreOptions] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [passwordHelpText, setPasswordHelpText] = useState(
    "Ingresa la contraseña de apertura del archivo y vuelve a intentar."
  );

  const canRun = useMemo(() => !!vimaFile && !!listaFile && !running, [vimaFile, listaFile, running]);

  function pushEvent(ev: ProgressEvent) {
    setEvents((prev) => {
      const next = [ev, ...prev];
      return next.slice(0, 200);
    });

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
    stopStream();
  }

  function buildForm(operationId: string, passwordOverride?: string) {
    if (!vimaFile || !listaFile) throw new Error("Faltan archivos");

    const form = new FormData();
    form.append("vima_file", vimaFile);
    form.append("lista_file", listaFile);

    const effectivePassword = (passwordOverride ?? vimaPassword).trim();
    if (effectivePassword) form.append("vima_password", effectivePassword);
    form.append("vima_start_row", String(vimaStartRow));
    form.append("lista_start_row", String(listaStartRow));
    form.append("require_all_g_to_n", requireAll ? "true" : "false");
    form.append("incremental", incremental ? "true" : "false");
    form.append("strict_incremental", strictIncremental ? "true" : "false");
    form.append("replicate_merges", replicateMerges ? "true" : "false");
    if (oiPattern.trim()) form.append("oi_pattern", oiPattern.trim());

    form.append("operation_id", operationId);
    return form;
  }

  function closePasswordModal() {
    pendingPasswordActionRef.current = null;
    setShowPasswordModal(false);
  }

  function requestPassword(action: "dry" | "upload", helpText: string) {
    pendingPasswordActionRef.current = action;
    setPasswordHelpText(helpText);
    setShowPasswordModal(true);
  }

  function handleAxiosError(e: unknown, action: "dry" | "upload") {
    if (!axios.isAxiosError(e)) {
      setErrorMsg(String(e));
      return;
    }
    const ax = e as AxiosError<any>;
    if (ax.code === "ERR_CANCELED") return;
    const code = ax.response?.headers?.["x-code"] as string | undefined;
    const detail = ax.response?.data?.detail ?? ax.message;

    if (code === "PASSWORD_REQUIRED") {
      setErrorMsg("");
      requestPassword(
        action,
        "El archivo VIMA está protegido. Ingresa la contraseña de apertura para continuar."
      );
      return;
    }
    if (code === "WRONG_PASSWORD") {
      setErrorMsg("");
      requestPassword(action, "Contraseña incorrecta. Intenta nuevamente.");
      return;
    }
    setErrorMsg(String(detail));
  }

  async function runDry(opts?: { passwordOverride?: string }) {
    setErrorMsg("");
    setSummary(null);
    setEvents([]);
    setProgressPct(0);

    const operationId = crypto.randomUUID();
    abortRef.current = new AbortController();

    // abrir stream de progreso
    subscribeVimaToListaProgress(operationId, pushEvent, abortRef.current.signal).catch(() => {
      // si el stream falla, igual dejamos que el request principal continúe
    });

    setRunning("dry");
    try {
      const form = buildForm(operationId, opts?.passwordOverride);
      const res = await vimaToListaDryRunUpload(form, abortRef.current.signal);
      setSummary(res.data);
    } catch (e) {
      handleAxiosError(e, "dry");
    } finally {
      stopStream();
      setRunning(null);
    }
  }

  async function runUpload(opts?: { passwordOverride?: string }) {
    setErrorMsg("");
    setEvents([]);
    setProgressPct(0);

    const operationId = crypto.randomUUID();
    abortRef.current = new AbortController();

    subscribeVimaToListaProgress(operationId, pushEvent, abortRef.current.signal).catch(() => {
      // no-op
    });

    setRunning("upload");
    try {
      const form = buildForm(operationId, opts?.passwordOverride);
      const res = await vimaToListaUpload(form, abortRef.current.signal);

      const cd = res.headers?.["content-disposition"] as string | undefined;
      const filename = parseFilename(cd) ?? "LISTA_SALIDA.xlsx";
      downloadBlob(res.data, filename);
    } catch (e) {
      handleAxiosError(e, "upload");
    } finally {
      stopStream();
      setRunning(null);
    }
  }

  return (
    <div className="container-fluid">
      <div className="row gap-20">
        <div className="col-md-7">
          <div className="bgc-white p-20 bd">
            <h4 className="c-grey-900 mB-20">Integración VIMA → LISTA</h4>

            <div className="mB-15">
              <SingleFilePicker
                label="Archivo VIMA (.xlsm)"
                accept=".xlsm,.xlsx"
                file={vimaFile}
                onChange={setVimaFile}
                disabled={!!running}
              />
            </div>

            <div className="mB-15">
              <SingleFilePicker
                label="Archivo LISTA (.xlsx)"
                accept=".xlsx,.xlsm"
                file={listaFile}
                onChange={setListaFile}
                disabled={!!running}
              />
            </div>

            <div className="mB-15">
              <label className="form-label">Contraseña VIMA (si aplica)</label>
              <input
                className="form-control"
                type="password"
                value={vimaPassword}
                onChange={(e) => setVimaPassword(e.target.value)}
                placeholder="(opcional)"
              />
            </div>

            {showMoreOptions ? (
              <>
                <div className="row">
              <div className="col-md-6 mB-15">
                <label className="form-label">Fila inicio VIMA</label>
                <input
                  className="form-control"
                  type="number"
                  value={vimaStartRow}
                  onChange={(e) => setVimaStartRow(Number(e.target.value))}
                />
              </div>
              <div className="col-md-6 mB-15">
                <label className="form-label">Fila inicio LISTA</label>
                <input
                  className="form-control"
                  type="number"
                  value={listaStartRow}
                  onChange={(e) => setListaStartRow(Number(e.target.value))}
                />
              </div>
            </div>

            <div className="mB-15">
              <label className="form-label">Patrón OI (regex, opcional)</label>
              <input
                className="form-control"
                value={oiPattern}
                onChange={(e) => setOiPattern(e.target.value)}
                placeholder="Ej: OI-(\\d{4})-(\\d+)"
              />
              <small className="text-muted">
                Nota: si pegas barras invertidas, el backend ya normaliza doble backslash.
              </small>
            </div>

            <div className="row mT-10">
                <div className="col-md-6 mB-10">
                    <div className="form-check form-switch">
                    <input
                        className="form-check-input"
                        type="checkbox"
                        id="requireAll"
                        checked={requireAll}
                        onChange={(e) => setRequireAll(e.target.checked)}
                    />
                    <label className="form-check-label" htmlFor="requireAll">
                        Requerir G→N completos
                    </label>
                    </div>
                </div>

                <div className="col-md-6 mB-10">
                    <div className="form-check form-switch">
                    <input
                        className="form-check-input"
                        type="checkbox"
                        id="replicateMerges"
                        checked={replicateMerges}
                        onChange={(e) => setReplicateMerges(e.target.checked)}
                    />
                    <label className="form-check-label" htmlFor="replicateMerges">
                        Replicar merges
                    </label>
                    </div>
                </div>

                <div className="col-md-6 mB-10">
                    <div className="form-check form-switch">
                    <input
                        className="form-check-input"
                        type="checkbox"
                        id="incremental"
                        checked={incremental}
                        onChange={(e) => setIncremental(e.target.checked)}
                    />
                    <label className="form-check-label" htmlFor="incremental">
                        Incremental
                    </label>
                    </div>
                </div>

                <div className="col-md-6 mB-10">
                    <div className="form-check form-switch">
                    <input
                        className="form-check-input"
                        type="checkbox"
                        id="strictIncremental"
                        checked={strictIncremental}
                        onChange={(e) => setStrictIncremental(e.target.checked)}
                        disabled={!incremental}
                    />
                    <label className="form-check-label" htmlFor="strictIncremental">
                        Incremental estricto
                    </label>
                    </div>
                </div>
                </div>
              </>
            ) : null}

            {errorMsg && (
              <div className="alert alert-danger mT-15" role="alert">
                {errorMsg}
              </div>
            )}

            <div className="d-flex justify-content-end mT-10">
              <button
                type="button"
                className="btn btn-link p-0"
                onClick={() => setShowMoreOptions((prev) => !prev)}
                disabled={!!running}
              >
                {showMoreOptions ? "Menos Opciones" : "Más Opciones"}
              </button>
            </div>

            <div className="d-flex gap-10 mT-20">
              <button className="btn btn-primary" disabled={!canRun} onClick={() => void runUpload()}>
                {running === "upload" ? "Procesando..." : "Procesar y Descargar"} 
              </button>
              <button
                className="btn btn-outline-danger"
                disabled={!running}
                onClick={cancelOperation}
              >
                Cancelar
              </button>
              <button
                className="btn btn-outline-primary"
                disabled={!canRun}
                onClick={() => void runDry()}
              >
                {running === "dry" ? "Analizando..." : "Analizar"}
              </button>
            </div>

            {summary && (
              <div className="mT-20">
                <h5 className="c-grey-900">Resumen</h5>
                <ul className="mB-0">
                  <li>Filas a copiar: <b>{summary.would_copy}</b></li>
                  <li>Fila inicio escritura (LISTA): <b>{summary.start_write_row}</b></li>
                  <li>Último OI en LISTA: <b>{String(summary.last_oi_in_lista ?? "-")}</b></li>
                  <li>Primer OI a copiar: <b>{String(summary.first_oi_to_copy ?? "-")}</b></li>
                  <li>Último OI a copiar: <b>{String(summary.last_oi_to_copy ?? "-")}</b></li>
                </ul>
              </div>
            )}
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
                        {typeof ev.percent === "number" ? <span className="text-muted"> — {ev.percent.toFixed(1)}%</span> : null}
                      </div>
                      <div className="text-muted">
                        {translateProgressMessage(ev.message ?? ev.detail ?? "")}
                      </div>
                      {ev.code ? <div className="text-muted">Código: {ev.code}</div> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>

          </div>
        </div>
      </div>

      <PasswordModal
        show={showPasswordModal}
        title="Archivo protegido"
        confirmLabel="Continuar"
        helpText={passwordHelpText}
        onClose={closePasswordModal}
        onConfirm={(pwd) => {
          setVimaPassword(pwd);
          setShowPasswordModal(false);
          const action = pendingPasswordActionRef.current;
          pendingPasswordActionRef.current = null;
          if (!action) return;
          if (action === "dry") void runDry({ passwordOverride: pwd });
          else void runUpload({ passwordOverride: pwd });
        }}
      />
    </div>
  );
}
