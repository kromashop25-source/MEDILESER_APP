import { useMemo, useRef, useState } from "react";
import axios from "axios";
import type { AxiosError } from "axios";
import type { ProgressEvent } from "../../api/integrations";
import {
  actualizacionBaseDryRunUpload,
  actualizacionBaseUpload,
  subscribeOiToolsProgress,
} from "../../api/oiTools";
import MultiFilePicker from "./components/MultiFilePicker";
import SingleFilePicker from "./components/SingleFilePicker";

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

async function extractAxiosError(e: unknown): Promise<{ detail: string; code?: string }> {
  if (!axios.isAxiosError(e)) return { detail: String(e) };
  const ax = e as AxiosError<any>;
  const code = (ax.response?.headers?.["x-code"] as string | undefined) ?? undefined;

  const data = ax.response?.data;
  if (data instanceof Blob) {
    try {
      const text = await data.text();
      const parsed = JSON.parse(text) as any;
      return { detail: String(parsed?.detail ?? text ?? ax.message), code };
    } catch {
      return { detail: ax.message, code };
    }
  }

  const detail = (data as any)?.detail ?? ax.message;
  return { detail: String(detail), code };
}

export default function ActualizacionBasePage() {
  const [baseFile, setBaseFile] = useState<File | null>(null);
  const [oiFiles, setOiFiles] = useState<File[]>([]);

  const [defaultPassword, setDefaultPassword] = useState<string>("");
  const [perFilePasswords, setPerFilePasswords] = useState<string>("");

  const [oiPattern, setOiPattern] = useState<string>("^OI-(\\d+)-(\\d{4})$");
  const [oiStartRow, setOiStartRow] = useState<number>(9);
  const [baseSheet, setBaseSheet] = useState<string>("ERROR FINAL");

  const [replicateMerges, setReplicateMerges] = useState<boolean>(true);
  const [replicateRowHeights, setReplicateRowHeights] = useState<boolean>(false);
  const [replicateColWidths, setReplicateColWidths] = useState<boolean>(false);

  const [running, setRunning] = useState<"dry" | "upload" | null>(null);
  const [progressPct, setProgressPct] = useState<number | null>(null);
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [errorMsg, setErrorMsg] = useState<string>("");

  const abortRef = useRef<AbortController | null>(null);

  const canRun = useMemo(
    () => !!baseFile && oiFiles.length > 0 && !running,
    [baseFile, oiFiles, running]
  );

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

  function buildForm(operationId?: string) {
    if (!baseFile) throw new Error("Falta el archivo Base");
    if (oiFiles.length === 0) throw new Error("Faltan archivos OI");

    const form = new FormData();
    form.append("base_file", baseFile);
    for (const f of oiFiles) form.append("oi_files", f);

    if (defaultPassword.trim()) form.append("default_password", defaultPassword.trim());
    if (perFilePasswords.trim()) form.append("per_file_passwords_json", perFilePasswords.trim());

    if (oiPattern.trim()) form.append("oi_pattern", oiPattern.trim());
    form.append("oi_start_row", String(oiStartRow));
    if (baseSheet.trim()) form.append("base_sheet", baseSheet.trim());

    if (operationId) form.append("operation_id", operationId);
    return form;
  }

  async function runDry() {
    setErrorMsg("");
    setEvents([]);
    setProgressPct(0);

    abortRef.current = new AbortController();
    setRunning("dry");
    try {
      const form = buildForm();
      await actualizacionBaseDryRunUpload(form, pushEvent, abortRef.current.signal);
    } catch (e: any) {
      const code = e?.code as string | undefined;
      const detail = String(e?.message ?? e);
      if (code === "PASSWORD_REQUIRED") {
        setErrorMsg("Alguna OI está protegida. Ingresa contraseñas y vuelve a intentar.");
      } else if (code === "WRONG_PASSWORD") {
        setErrorMsg("Contraseña incorrecta para una OI. Verifica e intenta nuevamente.");
      } else {
        setErrorMsg(detail);
      }
    } finally {
      stopStream();
      setRunning(null);
    }
  }

  async function runUpload() {
    setErrorMsg("");
    setEvents([]);
    setProgressPct(0);

    const operationId = crypto.randomUUID();
    abortRef.current = new AbortController();

    // Stream de progreso (reutiliza endpoint existente)
    subscribeOiToolsProgress(operationId, pushEvent, abortRef.current.signal).catch(() => {
      // si el stream falla, igual dejamos que el request principal continúe
    });

    setRunning("upload");
    try {
      const form = buildForm(operationId);
      form.append("replicate_merges", replicateMerges ? "true" : "false");
      form.append("replicate_row_heights", replicateRowHeights ? "true" : "false");
      form.append("replicate_col_widths", replicateColWidths ? "true" : "false");

      const res = await actualizacionBaseUpload(form);
      const cd = res.headers["content-disposition"] as string | undefined;
      const xf = res.headers["x-file-name"] as string | undefined;
      const filename = parseFilename(cd) ?? xf ?? "base_actualizada.xlsx";
      downloadBlob(res.data, filename);
    } catch (e) {
      const { detail, code } = await extractAxiosError(e);
      if (code === "PASSWORD_REQUIRED") {
        setErrorMsg("Alguna OI está protegida. Ingresa contraseñas y vuelve a intentar.");
      } else if (code === "WRONG_PASSWORD") {
        setErrorMsg("Contraseña incorrecta para una OI. Verifica e intenta nuevamente.");
      } else {
        setErrorMsg(detail);
      }
    } finally {
      stopStream();
      setRunning(null);
    }
  }

  return (
    <div className="container-fluid">
      <div className="row">
        <div className="col-md-7">
          <div className="bgc-white p-20 bd">
            <h4 className="c-grey-900 mB-10">Actualización de Bases</h4>
            <p className="text-muted mB-20">
              Integra múltiples OIs en una Base (hoja ERROR FINAL). Soporta dry-run (NDJSON) y ejecución con descarga.
            </p>

            <div className="row">
              <div className="col-12 mB-15">
                <SingleFilePicker
                  label="Base (xlsx)"
                  accept=".xlsx"
                  file={baseFile}
                  onChange={setBaseFile}
                  disabled={!!running}
                />
              </div>

              <div className="col-12 mB-15">
                <MultiFilePicker
                  label="Archivos OI (xlsx/xlsm)"
                  title="Archivos OI"
                  accept=".xlsx,.xlsm"
                  files={oiFiles}
                  setFiles={setOiFiles}
                  disabled={!!running}
                />
              </div>

              <div className="col-md-6 mB-15">
                <label className="form-label">Contraseña por defecto (opcional)</label>
                <input
                  className="form-control"
                  type="password"
                  value={defaultPassword}
                  onChange={(e) => setDefaultPassword(e.target.value)}
                  disabled={!!running}
                />
              </div>

              <div className="col-md-6 mB-15">
                <label className="form-label">Hoja Base (opcional)</label>
                <input
                  className="form-control"
                  value={baseSheet}
                  onChange={(e) => setBaseSheet(e.target.value)}
                  disabled={!!running}
                />
              </div>

              <div className="col-md-6 mB-15">
                <label className="form-label">Regex OI (opcional)</label>
                <input
                  className="form-control"
                  value={oiPattern}
                  onChange={(e) => setOiPattern(e.target.value)}
                  disabled={!!running}
                />
              </div>

              <div className="col-md-6 mB-15">
                <label className="form-label">Fila inicio OI</label>
                <input
                  className="form-control"
                  type="number"
                  min={1}
                  value={oiStartRow}
                  onChange={(e) => setOiStartRow(Number(e.target.value || 9))}
                  disabled={!!running}
                />
              </div>

              <div className="col-12 mB-15">
                <label className="form-label">Contraseñas por archivo (opcional)</label>
                <textarea
                  className="form-control"
                  rows={4}
                  value={perFilePasswords}
                  onChange={(e) => setPerFilePasswords(e.target.value)}
                  disabled={!!running}
                  placeholder={
                    "Ej:\nOI-0001-2025.xlsx: clave1\nOI-0002-2025.xlsx: clave2\n\nO JSON:\n{\"OI-0001-2025.xlsx\":\"clave1\"}"
                  }
                />
              </div>

              <div className="col-md-4 mB-15">
                <div className="form-check form-switch">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="replicateMerges"
                    checked={replicateMerges}
                    onChange={(e) => setReplicateMerges(e.target.checked)}
                    disabled={!!running}
                  />
                  <label className="form-check-label" htmlFor="replicateMerges">
                    Replicar merges
                  </label>
                </div>
              </div>

              <div className="col-md-4 mB-15">
                <div className="form-check form-switch">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="replicateRowHeights"
                    checked={replicateRowHeights}
                    onChange={(e) => setReplicateRowHeights(e.target.checked)}
                    disabled={!!running}
                  />
                  <label className="form-check-label" htmlFor="replicateRowHeights">
                    Replicar alto filas
                  </label>
                </div>
              </div>

              <div className="col-md-4 mB-15">
                <div className="form-check form-switch">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="replicateColWidths"
                    checked={replicateColWidths}
                    onChange={(e) => setReplicateColWidths(e.target.checked)}
                    disabled={!!running}
                  />
                  <label className="form-check-label" htmlFor="replicateColWidths">
                    Replicar ancho cols
                  </label>
                </div>
              </div>
            </div>

            {errorMsg && (
              <div className="alert alert-danger mT-10" role="alert">
                {errorMsg}
              </div>
            )}

            <div className="d-flex gap-10 mT-15">
              <button className="btn btn-outline-primary" disabled={!canRun} onClick={runDry}>
                {running === "dry" ? "Analizando..." : "Dry-run (Analizar)"}
              </button>
              <button className="btn btn-primary" disabled={!canRun} onClick={runUpload}>
                {running === "upload" ? "Procesando..." : "Procesar y Descargar"}
              </button>
            </div>
          </div>
        </div>

        <div className="col-md-5">
          <div className="bgc-white p-20 bd">
            <h5 className="c-grey-900 mB-10">Progreso</h5>

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
                        <b>{ev.type}</b>{" "}
                        {ev.stage ? <span className="text-muted">[{ev.stage}]</span> : null}
                        {typeof ev.percent === "number" ? (
                          <span className="text-muted"> — {ev.percent.toFixed(1)}%</span>
                        ) : null}
                      </div>
                      <div className="text-muted">{ev.message ?? ev.detail ?? ""}</div>
                      {ev.code ? <div className="text-muted">Código: {ev.code}</div> : null}
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
