import { useMemo, useState } from "react";
import axios from "axios";
import type { AxiosError } from "axios";
import type { ProgressEvent } from "../../api/integrations";
import {
  excelChangePassword,
  excelInspect,
  excelUpdate,
  excelValidate,
  uploadOiToolFile,
} from "../../api/oiTools";

type EditRow = { cell: string; value: string };

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

export default function ExcelToolsPage() {
  const [fileToUpload, setFileToUpload] = useState<File | null>(null);
  const [suggestedName, setSuggestedName] = useState<string>("");
  const [filePath, setFilePath] = useState<string>("");

  const [inspectPassword, setInspectPassword] = useState<string>("");
  const [updateSheet, setUpdateSheet] = useState<string>("ERROR FINAL");
  const [updatePassword, setUpdatePassword] = useState<string>("");
  const [updateSaveMode, setUpdateSaveMode] = useState<"same_password" | "no_password" | "new_password">(
    "same_password"
  );
  const [updateNewPassword, setUpdateNewPassword] = useState<string>("");
  const [edits, setEdits] = useState<EditRow[]>([{ cell: "A1", value: "" }]);

  const [cpOpenPassword, setCpOpenPassword] = useState<string>("");
  const [cpMode, setCpMode] = useState<"no_password" | "new_password">("no_password");
  const [cpNewPassword, setCpNewPassword] = useState<string>("");

  const [valSheet, setValSheet] = useState<string>("ERROR FINAL");
  const [valHeaderRow, setValHeaderRow] = useState<number>(1);
  const [valRequiredCols, setValRequiredCols] = useState<string>("");
  const [valTypeRules, setValTypeRules] = useState<string>("");
  const [valPassword, setValPassword] = useState<string>("");

  const [running, setRunning] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [progressPct, setProgressPct] = useState<number | null>(null);
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [result, setResult] = useState<unknown>(null);

  const hasPath = useMemo(() => filePath.trim().length > 0, [filePath]);

  function pushEvent(ev: ProgressEvent) {
    setEvents((prev) => [ev, ...prev].slice(0, 200));
  }

  function resetStatus() {
    setErrorMsg("");
    setEvents([]);
    setProgressPct(0);
    setResult(null);
  }

  async function doUpload() {
    resetStatus();
    if (!fileToUpload) {
      setErrorMsg("Selecciona un archivo para subir.");
      return;
    }
    setRunning("upload");
    try {
      pushEvent({ type: "status", stage: "upload", message: "Subiendo archivo..." });
      setProgressPct(30);
      const form = new FormData();
      form.append("file", fileToUpload);
      if (suggestedName.trim()) form.append("suggested_name", suggestedName.trim());
      const info = await uploadOiToolFile(form);
      setFilePath(info.relative_path);
      setResult(info);
      pushEvent({ type: "complete", stage: "upload", message: "Archivo subido." });
      setProgressPct(100);
    } catch (e) {
      const detail = await extractAxiosError(e);
      setErrorMsg(detail);
      pushEvent({ type: "error", stage: "upload", detail });
    } finally {
      setRunning(null);
    }
  }

  async function doInspect() {
    resetStatus();
    if (!hasPath) {
      setErrorMsg("Ingresa o sube un archivo para obtener file_path.");
      return;
    }
    setRunning("inspect");
    try {
      pushEvent({ type: "status", stage: "inspect", message: "Inspeccionando..." });
      setProgressPct(50);
      const data = await excelInspect({
        file_path: filePath.trim(),
        open_password: inspectPassword.trim() || null,
      });
      setResult(data);
      pushEvent({ type: "complete", stage: "inspect", message: "Inspección completada." });
      setProgressPct(100);
    } catch (e) {
      const detail = await extractAxiosError(e);
      setErrorMsg(detail);
      pushEvent({ type: "error", stage: "inspect", detail });
    } finally {
      setRunning(null);
    }
  }

  async function doUpdate() {
    resetStatus();
    if (!hasPath) {
      setErrorMsg("Ingresa o sube un archivo para obtener file_path.");
      return;
    }
    if (!updateSheet.trim()) {
      setErrorMsg("Ingresa el nombre de la hoja.");
      return;
    }
    const cleanEdits = edits
      .map((e) => ({ cell: e.cell.trim(), value: e.value }))
      .filter((e) => e.cell);
    if (cleanEdits.length === 0) {
      setErrorMsg("Agrega al menos una edición.");
      return;
    }

    setRunning("update");
    try {
      pushEvent({ type: "status", stage: "update", message: "Aplicando ediciones..." });
      setProgressPct(50);
      const data = await excelUpdate({
        file_path: filePath.trim(),
        edits: cleanEdits.map((e) => ({ sheet: updateSheet.trim(), cell: e.cell, value: e.value })),
        open_password: updatePassword.trim() || null,
        save_mode: updateSaveMode,
        new_password: updateSaveMode === "new_password" ? updateNewPassword.trim() || null : null,
      });
      setResult(data);
      pushEvent({ type: "complete", stage: "update", message: "Actualización completada." });
      setProgressPct(100);
    } catch (e) {
      const detail = await extractAxiosError(e);
      setErrorMsg(detail);
      pushEvent({ type: "error", stage: "update", detail });
    } finally {
      setRunning(null);
    }
  }

  async function doChangePassword() {
    resetStatus();
    if (!hasPath) {
      setErrorMsg("Ingresa o sube un archivo para obtener file_path.");
      return;
    }
    if (!cpOpenPassword.trim()) {
      setErrorMsg("Ingresa la contraseña de apertura (open_password).");
      return;
    }
    if (cpMode === "new_password" && !cpNewPassword.trim()) {
      setErrorMsg("Ingresa la nueva contraseña.");
      return;
    }

    setRunning("change-password");
    try {
      pushEvent({ type: "status", stage: "change-password", message: "Cambiando contraseña..." });
      setProgressPct(50);
      const data = await excelChangePassword({
        file_path: filePath.trim(),
        open_password: cpOpenPassword.trim(),
        mode: cpMode,
        new_password: cpMode === "new_password" ? cpNewPassword.trim() : null,
      });
      setResult(data);
      pushEvent({ type: "complete", stage: "change-password", message: "Cambio de contraseña completado." });
      setProgressPct(100);
    } catch (e) {
      const detail = await extractAxiosError(e);
      setErrorMsg(detail);
      pushEvent({ type: "error", stage: "change-password", detail });
    } finally {
      setRunning(null);
    }
  }

  async function doValidate() {
    resetStatus();
    if (!hasPath) {
      setErrorMsg("Ingresa o sube un archivo para obtener file_path.");
      return;
    }

    let typeRulesObj: any = {};
    if (valTypeRules.trim()) {
      try {
        typeRulesObj = JSON.parse(valTypeRules);
      } catch {
        setErrorMsg("type_rules debe ser JSON válido.");
        return;
      }
    }

    const requiredCols = valRequiredCols
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    setRunning("validate");
    try {
      pushEvent({ type: "status", stage: "validate", message: "Validando..." });
      setProgressPct(50);
      const data = await excelValidate({
        file_path: filePath.trim(),
        sheet: valSheet.trim() || null,
        header_row: valHeaderRow,
        required_columns: requiredCols,
        type_rules: typeRulesObj,
        open_password: valPassword.trim() || null,
      });
      setResult(data);
      pushEvent({ type: "complete", stage: "validate", message: "Validación completada." });
      setProgressPct(100);
    } catch (e) {
      const detail = await extractAxiosError(e);
      setErrorMsg(detail);
      pushEvent({ type: "error", stage: "validate", detail });
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="container-fluid">
      <div className="row">
        <div className="col-md-7">
          <div className="bgc-white p-20 bd">
            <h4 className="c-grey-900 mB-10">Herramientas Excel</h4>
            <p className="text-muted mB-20">
              Subir archivos, inspeccionar, editar celdas, cambiar contraseña y validar.
            </p>

            <div className="card mB-15">
              <div className="card-body">
                <h6 className="card-title">1) Subir archivo (recomendado)</h6>
                <div className="row">
                  <div className="col-md-8 mB-10">
                    <input
                      className="form-control"
                      type="file"
                      accept=".xlsx,.xlsm"
                      disabled={!!running}
                      onChange={(e) => setFileToUpload(e.target.files?.[0] ?? null)}
                    />
                  </div>
                  <div className="col-md-4 mB-10">
                    <input
                      className="form-control"
                      placeholder="Nombre sugerido (opcional)"
                      value={suggestedName}
                      disabled={!!running}
                      onChange={(e) => setSuggestedName(e.target.value)}
                    />
                  </div>
                </div>
                <button className="btn btn-outline-primary" disabled={!!running || !fileToUpload} onClick={doUpload}>
                  {running === "upload" ? "Subiendo..." : "Subir"}
                </button>
              </div>
            </div>

            <div className="mB-15">
              <label className="form-label">file_path</label>
              <input
                className="form-control"
                value={filePath}
                disabled={!!running}
                onChange={(e) => setFilePath(e.target.value)}
                placeholder="Ruta del archivo en el servidor (o la devuelta por Upload)"
              />
              <div className="form-text">
                Si subes el archivo, se llenará automáticamente. También puedes pegar una ruta local/red accesible por el servidor.
              </div>
            </div>

            <div className="card mB-15">
              <div className="card-body">
                <h6 className="card-title">2) Inspect</h6>
                <div className="row align-items-end">
                  <div className="col-md-8 mB-10">
                    <label className="form-label">open_password (opcional)</label>
                    <input
                      className="form-control"
                      type="password"
                      value={inspectPassword}
                      disabled={!!running}
                      onChange={(e) => setInspectPassword(e.target.value)}
                    />
                  </div>
                  <div className="col-md-4 mB-10">
                    <button className="btn btn-primary w-100" disabled={!!running || !hasPath} onClick={doInspect}>
                      {running === "inspect" ? "Inspeccionando..." : "Inspect"}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="card mB-15">
              <div className="card-body">
                <h6 className="card-title">3) Update (editar celdas)</h6>
                <div className="row">
                  <div className="col-md-6 mB-10">
                    <label className="form-label">Hoja</label>
                    <input
                      className="form-control"
                      value={updateSheet}
                      disabled={!!running}
                      onChange={(e) => setUpdateSheet(e.target.value)}
                    />
                  </div>
                  <div className="col-md-6 mB-10">
                    <label className="form-label">open_password (opcional)</label>
                    <input
                      className="form-control"
                      type="password"
                      value={updatePassword}
                      disabled={!!running}
                      onChange={(e) => setUpdatePassword(e.target.value)}
                    />
                  </div>
                  <div className="col-md-6 mB-10">
                    <label className="form-label">save_mode</label>
                    <select
                      className="form-select"
                      value={updateSaveMode}
                      disabled={!!running}
                      onChange={(e) =>
                        setUpdateSaveMode(e.target.value as "same_password" | "no_password" | "new_password")
                      }
                    >
                      <option value="same_password">same_password</option>
                      <option value="no_password">no_password</option>
                      <option value="new_password">new_password</option>
                    </select>
                  </div>
                  <div className="col-md-6 mB-10">
                    <label className="form-label">new_password</label>
                    <input
                      className="form-control"
                      type="password"
                      value={updateNewPassword}
                      disabled={!!running || updateSaveMode !== "new_password"}
                      onChange={(e) => setUpdateNewPassword(e.target.value)}
                      placeholder={updateSaveMode === "new_password" ? "Requerido" : "—"}
                    />
                  </div>
                </div>

                <div className="mT-10">
                  <label className="form-label">Ediciones</label>
                  {edits.map((row, idx) => (
                    <div key={idx} className="row g-2 mB-10">
                      <div className="col-md-3">
                        <input
                          className="form-control"
                          value={row.cell}
                          disabled={!!running}
                          onChange={(e) => {
                            const next = edits.slice();
                            next[idx] = { ...next[idx], cell: e.target.value };
                            setEdits(next);
                          }}
                          placeholder="Celda (A1)"
                        />
                      </div>
                      <div className="col-md-7">
                        <input
                          className="form-control"
                          value={row.value}
                          disabled={!!running}
                          onChange={(e) => {
                            const next = edits.slice();
                            next[idx] = { ...next[idx], value: e.target.value };
                            setEdits(next);
                          }}
                          placeholder="Valor"
                        />
                      </div>
                      <div className="col-md-2 d-flex gap-10">
                        <button
                          type="button"
                          className="btn btn-outline-secondary w-100"
                          disabled={!!running}
                          onClick={() => setEdits((prev) => [...prev, { cell: "A1", value: "" }])}
                        >
                          +
                        </button>
                        <button
                          type="button"
                          className="btn btn-outline-danger w-100"
                          disabled={!!running || edits.length === 1}
                          onClick={() => setEdits((prev) => prev.filter((_, i) => i !== idx))}
                        >
                          —
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <button className="btn btn-primary" disabled={!!running || !hasPath} onClick={doUpdate}>
                  {running === "update" ? "Actualizando..." : "Update"}
                </button>
              </div>
            </div>

            <div className="card mB-15">
              <div className="card-body">
                <h6 className="card-title">4) Change password</h6>
                <div className="row">
                  <div className="col-md-6 mB-10">
                    <label className="form-label">open_password</label>
                    <input
                      className="form-control"
                      type="password"
                      value={cpOpenPassword}
                      disabled={!!running}
                      onChange={(e) => setCpOpenPassword(e.target.value)}
                    />
                  </div>
                  <div className="col-md-6 mB-10">
                    <label className="form-label">mode</label>
                    <select
                      className="form-select"
                      value={cpMode}
                      disabled={!!running}
                      onChange={(e) => setCpMode(e.target.value as "no_password" | "new_password")}
                    >
                      <option value="no_password">no_password</option>
                      <option value="new_password">new_password</option>
                    </select>
                  </div>
                  <div className="col-md-6 mB-10">
                    <label className="form-label">new_password</label>
                    <input
                      className="form-control"
                      type="password"
                      value={cpNewPassword}
                      disabled={!!running || cpMode !== "new_password"}
                      onChange={(e) => setCpNewPassword(e.target.value)}
                      placeholder={cpMode === "new_password" ? "Requerido" : "—"}
                    />
                  </div>
                  <div className="col-md-6 mB-10 d-flex align-items-end">
                    <button className="btn btn-primary w-100" disabled={!!running || !hasPath} onClick={doChangePassword}>
                      {running === "change-password" ? "Procesando..." : "Change password"}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-body">
                <h6 className="card-title">5) Validate</h6>
                <div className="row">
                  <div className="col-md-6 mB-10">
                    <label className="form-label">sheet (opcional)</label>
                    <input
                      className="form-control"
                      value={valSheet}
                      disabled={!!running}
                      onChange={(e) => setValSheet(e.target.value)}
                    />
                  </div>
                  <div className="col-md-3 mB-10">
                    <label className="form-label">header_row</label>
                    <input
                      className="form-control"
                      type="number"
                      min={1}
                      value={valHeaderRow}
                      disabled={!!running}
                      onChange={(e) => setValHeaderRow(Number(e.target.value || 1))}
                    />
                  </div>
                  <div className="col-md-3 mB-10">
                    <label className="form-label">open_password (opcional)</label>
                    <input
                      className="form-control"
                      type="password"
                      value={valPassword}
                      disabled={!!running}
                      onChange={(e) => setValPassword(e.target.value)}
                    />
                  </div>
                  <div className="col-12 mB-10">
                    <label className="form-label">required_columns (coma separada)</label>
                    <input
                      className="form-control"
                      value={valRequiredCols}
                      disabled={!!running}
                      onChange={(e) => setValRequiredCols(e.target.value)}
                      placeholder="ColA, ColB, ColC"
                    />
                  </div>
                  <div className="col-12 mB-10">
                    <label className="form-label">type_rules (JSON, opcional)</label>
                    <textarea
                      className="form-control"
                      rows={3}
                      value={valTypeRules}
                      disabled={!!running}
                      onChange={(e) => setValTypeRules(e.target.value)}
                      placeholder={'{"ColA":"int","ColB":"float"}'}
                    />
                  </div>
                </div>

                <button className="btn btn-primary" disabled={!!running || !hasPath} onClick={doValidate}>
                  {running === "validate" ? "Validando..." : "Validate"}
                </button>
              </div>
            </div>

            {errorMsg && (
              <div className="alert alert-danger mT-15" role="alert">
                {errorMsg}
              </div>
            )}
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

            <div style={{ maxHeight: 220, overflow: "auto" }}>
              {events.length === 0 ? (
                <div className="text-muted">Sin eventos aún.</div>
              ) : (
                <ul className="list-unstyled mB-0">
                  {events.map((ev, i) => (
                    <li key={i} className="mB-10">
                      <div>
                        <b>{ev.type}</b>{" "}
                        {ev.stage ? <span className="text-muted">[{ev.stage}]</span> : null}
                      </div>
                      <div className="text-muted">{ev.message ?? ev.detail ?? ""}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <hr className="mY-15" />

            <h6 className="c-grey-900 mB-10">Resultado</h6>
            {!result ? (
              <div className="text-muted">Sin resultado aún.</div>
            ) : (
              <pre className="bg-light p-10" style={{ maxHeight: 360, overflow: "auto" }}>
                {JSON.stringify(result, null, 2)}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

