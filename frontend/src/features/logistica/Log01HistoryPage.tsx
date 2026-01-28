import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import type { AxiosError } from "axios";
import {
  log01HistoryDelete,
  log01HistoryDetail,
  log01HistoryDownloadArtifact,
  log01HistoryList,
  type Log01HistoryDetail,
  type Log01HistoryListItem,
} from "../../api/oiTools";
import { translateProgressMessage } from "../oi_tools/progressTranslations";

const PERU_TZ = "America/Lima";


import { getAuth, isSuperuser, normalizeRole } from "../../api/auth";

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

function formatDateTime(value?: string | null): string {
  if (!value) return "N/D";
  // Si el backend emvía datetime "native" (sin zona), asumimos que está em UTC.
  // Esto evita mostrar horas "corridas" cuando la BD guarda utc pero el string no traer 'Z' / offset.
  const hasTz = 
  /[zZ]$/.test(value) || /[+-]\d{2}:\d{2}$/.test(value) || /[+-]\d{4}$/.test(value);
  const safe = hasTz ? value : `${value}Z`;

  const d = new Date(safe);
  if (Number.isNaN(d.getTime())) return String(value);
  // Forzar visualización en hora local de Perú (aunque el navegador esté en otra zona horaria)
  const fmt = new Intl.DateTimeFormat("es-PE", {
    timeZone: PERU_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  // Formato dd/mm/yyyy HH:MM (sin comas ni “a. m./p. m.”)
  const parts = fmt.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
 }

function getSummaryNumber(summary: any, key: string): string {
  const v = summary?.[key];
  return typeof v === "number" ? String(v) : "N/D";
}

function getSummaryString(summary: any, key: string): string {
  const v = summary?.[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  return "N/D"
}

function getDuplicatesEliminated(summary: any): number | null {
  const v =
    summary?.series_duplicates_eliminated ??
    summary?.detail?.series_duplicates_eliminated ??
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

function fmtOiTag(n: any, y?: any, tag?: any): string {
  const rawTag = String(tag ?? "").trim();
  if (rawTag) return rawTag;
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return "N/D";
  const year = Number(y);
  if (Number.isFinite(year) && year > 0) {
    return `OI-${String(num).padStart(4, "0")}-${String(year).padStart(4, "0")}`;
  }
  return `OI-${String(num).padStart(4, "0")}`;
}

function getRowsTotalRead(summary: any): number | null {
  const v = summary?.rows_total_read ?? summary?.totals_input?.rows_read;
  return typeof v === "number" ? v : null;
}

function statusBadgeClass(status?: string | null) {
  const s = (status || "").toUpperCase();
  if (s === "COMPLETADO") return "badge bg-success";
  if (s === "ERROR") return "badge bg-danger";
  if (s === "CANCELADO") return "badge bg-warning vi-text-contrast";
  return "badge bg-secondary";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return String(value);
  }
}

export default function Log01HistoryPage() {
  const navigate = useNavigate();
  const auth = getAuth();
  const role = normalizeRole(auth?.role, auth?.username);
  const superuser = isSuperuser(auth);
  const canDeleteHistory = role === "admin" || role === "administrator";

  const [items, setItems] = useState<Log01HistoryListItem[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [reloadKey, setReloadKey] = useState<number>(0);

  const [search, setSearch] = useState<string>("");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [source, setSource] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [pageSize, setPageSize] = useState<number>(20);
  const [page, setPage] = useState<number>(1);

  const [reportOpen, setReportOpen] = useState<boolean>(false);
  const [reportLoading, setReportLoading] = useState<boolean>(false);
  const [reportError, setReportError] = useState<string>("");
  const [reportDetail, setReportDetail] = useState<Log01HistoryDetail | null>(null);
  const [showTechAudit, setShowTechAudit] = useState(false);


  const [applied, setApplied] = useState(() => ({
    q: "",
    dateFrom: "",
    dateTo: "",
    source: "",
    status: "",
  }));

  const offset = useMemo(() => (page - 1) * pageSize, [page, pageSize]);
  const reportSummary = reportDetail?.summary_json;

  const auditByOiOkSorted = useMemo(() => {
    const list = Array.isArray((reportSummary as any)?.audit_by_oi) ? (reportSummary as any).audit_by_oi : [];
    return list
      .filter((x: any) => x?.status === "OK" && String(x?.source ?? "").toUpperCase() === "BASES")
      .slice()
      .sort((a: any, b: any) => {
        const aYear = Number(a?.oi_year);
        const bYear = Number(b?.oi_year);
        const aYearHas = Number.isFinite(aYear) && aYear > 0;
        const bYearHas = Number.isFinite(bYear) && bYear > 0;
        if (aYearHas && bYearHas && aYear !== bYear) return aYear - bYear;
        if (aYearHas && !bYearHas) return -1;
        if (!aYearHas && bYearHas) return 1;

        const aNum = Number(a?.oi_num);
        const bNum = Number(b?.oi_num);
        const aHas = Number.isFinite(aNum);
        const bHas = Number.isFinite(bNum);
        if (aHas && bHas && aNum !== bNum) return aNum - bNum;
        if (aHas && !bHas) return -1;
        if (!aHas && bHas) return 1;
        const aKey = String(a?.oi_tag ?? a?.oi ?? a?.oi_num ?? "").toUpperCase();
        const bKey = String(b?.oi_tag ?? b?.oi ?? b?.oi_num ?? "").toUpperCase();
        return aKey.localeCompare(bKey);
      });
  }, [reportSummary]);

  const auditRejectedSorted = useMemo(() => {
    const list = Array.isArray((reportSummary as any)?.files_rejected) ? (reportSummary as any).files_rejected : [];
    return list.slice().sort((a: any, b: any) => {
      const aKey = String(a?.oi ?? a?.filename ?? "").toUpperCase();
      const bKey = String(b?.oi ?? b?.filename ?? "").toUpperCase();
      return aKey.localeCompare(bKey);
    });
  }, [reportSummary]);

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

    const bs = (reportSummary as any)?.by_source;
    if (bs && typeof bs === "object") return bs;

    const out: any = { BASES: init(), GASELAG: init() };
    const okList = Array.isArray((reportSummary as any)?.audit_by_oi) ? (reportSummary as any).audit_by_oi : [];
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
    const rejList = Array.isArray((reportSummary as any)?.files_rejected) ? (reportSummary as any).files_rejected : [];
    for (const r of rejList) {
      const src = String(r?.source ?? "").toUpperCase();
      const k = src === "GASELAG" ? "GASELAG" : "BASES";
      out[k].files_error += 1;
    }
    for (const k of ["BASES", "GASELAG"]) out[k].files_total = out[k].files_ok + out[k].files_error;
    return out;
  }, [reportSummary]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    log01HistoryList({
      limit: pageSize,
      offset,
      include_deleted: false,
      q: applied.q || undefined,
      dateFrom: applied.dateFrom || undefined,
      dateTo: applied.dateTo || undefined,
      source: applied.source || undefined,
      status: applied.status || undefined,
    })
      .then((data) => {
        if (cancelled) return;
        setItems(Array.isArray(data?.items) ? data.items : []);
        setTotal(typeof data?.total === "number" ? data.total : 0);
      })
      .catch((e) => {
        if (cancelled) return;
        const ax = e as AxiosError<any>;
        const detail = (ax.response?.data?.detail as string) || ax.message || "No se pudo cargar historial.";
        setError(detail);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [applied, offset, pageSize, reloadKey]);

  const applyFilters = () => {
    setApplied({
      q: search.trim(),
      dateFrom: dateFrom.trim(),
      dateTo: dateTo.trim(),
      source: source.trim(),
      status: status.trim(),
    });
    setPage(1);
  };

  const clearFilters = () => {
    setSearch("");
    setDateFrom("");
    setDateTo("");
    setSource("");
    setStatus("");
    setApplied({ q: "", dateFrom: "", dateTo: "", source: "", status: "" });
    setPage(1);
    setReloadKey((v) => v + 1);
  };

  const refresh = () => setReloadKey((v) => v + 1);

  const downloadArtifact = async (
    runId: number,
    kind: "excel" | "no-conforme" | "manifiesto"
  ) => {
    try {
      setError("");
      const res = await log01HistoryDownloadArtifact(runId, kind);
      const cd = res.headers["content-disposition"] as string | undefined;
      const xf = res.headers["x-file-name"] as string | undefined;
      const filename = parseFilename(cd) ?? xf ?? `${kind}.bin`;
      downloadBlob(res.data, filename);
    } catch (e) {
      const ax = e as AxiosError<any>;
      if (axios.isCancel(ax)) return;
      const detail = (ax.response?.data?.detail as string) || ax.message || "No se pudo descargar.";
      setError(detail);
    }
  };

  const deleteRun = async (runId: number) => {
    if (!canDeleteHistory) return;
    if (!window.confirm("Eliminar la corrida del historial?")) return;
    try {
      setError("");
      await log01HistoryDelete(runId);
      refresh();
    } catch (e) {
      const ax = e as AxiosError<any>;
      if (axios.isCancel(ax)) return;
      const detail = (ax.response?.data?.detail as string) || ax.message || "No se pudo eliminar.";
      setError(detail);
    }
  };

  const openReport = async (runId: number) => {
    try {
      setReportOpen(true);
      setReportLoading(true);
      setReportError("");
      setReportDetail(null);
      setShowTechAudit(false);
      const detail = await log01HistoryDetail(runId);
      setReportDetail(detail);
    } catch (e) {
      const ax = e as AxiosError<any>;
      if (axios.isCancel(ax)) return;
      const detail = 
        (ax.response?.data?.detail as string) || ax.message || "No se pudo cargar el reporte.";
      setReportError(detail);
    } finally {
      setReportLoading(false);
    } 
  };

  const closeReport = () => {
    setReportOpen(false);
  };

  // Evita scroll del body cuando el modal está abierto (sin depender de JS de Bootstrap)
  useEffect(() => {
    if (!reportOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [reportOpen]);


  const from = total === 0 ? 0 : offset + 1;
  const to = total === 0 ? 0 : Math.min(offset + items.length, total);
  const canPrev = page > 1;
  const canNext = offset + items.length < total;

  return (
    <div className="container-fluid">
      {reportOpen ? (
        <>
          <div
            className="modal fade show"
            style={{ display: "block" }}
            role="dialog"
            aria-modal="true"
          >
            <div className="modal-dialog modal-xl modal-dialog-scrollable">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Reporte de auditoría (LOG-01)</h5>
                  <button type="button" className="btn-close" aria-label="Close" onClick={closeReport} />
                </div>
                <div className="modal-body">
                  {reportLoading ? (
                    <div className="text-muted">Cargando reporte...</div>
                  ) : reportError ? (
                    <div className="alert alert-danger mB-0">{reportError}</div>
                  ) : reportDetail ? (
                    (() => {
                      const summary = reportDetail.summary_json as any;
                      const serieIni = getSummaryString(summary, "serie_ini");
                      const serieFin = getSummaryString(summary, "serie_fin");
                      const totalDedup = getSummaryNumber(summary, "series_total_dedup");
                      const conformes = getSummaryNumber(summary, "series_conformes");
                      const noConformes = getSummaryNumber(summary, "series_no_conformes_final");
                      return (
                        <div className="d-flex flex-column gap-15">
                          <div className="d-flex flex-wrap gap-10 align-items-center">
                            <span className="badge bg-secondary">
                              Run ID: {reportDetail.id}
                            </span>
                            <span className={statusBadgeClass(reportDetail.status)}>
                              {reportDetail.status}
                            </span>
                            <span className="small text-muted">
                              {formatDateTime(reportDetail.created_at)}
                              {reportDetail.completed_at ? ` → ${formatDateTime(reportDetail.completed_at)}` : ""}
                            </span>
                          </div>

                          <div className="card">
                            <div className="card-body">
                              <div className="d-flex flex-wrap gap-15">
                                <div>
                                  <div className="text-muted small">Serie inicial</div>
                                  <div><strong>{serieIni}</strong></div>
                                </div>
                                <div>
                                  <div className="text-muted small">Serie final</div>
                                  <div><strong>{serieFin}</strong></div>
                                </div>
                                <div>
                                  <div className="text-muted small">Únicas (post-dedupe)</div>
                                  <div><strong>{totalDedup}</strong></div>
                                </div>
                                <div>
                                  <div className="text-muted small">Conformes finales</div>
                                  <div><strong>{conformes}</strong></div>
                                </div>
                                <div>
                                  <div className="text-muted small">No conformes finales</div>
                                  <div><strong>{noConformes}</strong></div>
                                </div>
                              </div>
                            </div>
                          </div>

                          <div className="bd p-10">
                            <div className="row">
                              <div className="col-md-6">
                                <div className="small text-muted">Archivos</div>
                                <div className="small">
                                  Total: <strong>{summary?.files_total ?? "N/D"}</strong> · OK:{" "}
                                  <strong>{summary?.files_ok ?? "N/D"}</strong> · Rechazados:{" "}
                                  <strong>{summary?.files_error ?? "N/D"}</strong>
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
                                              {fmtOiTag(x?.oi_num, x?.oi_year, x?.oi_tag ?? x?.oi)}
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
                                    <strong>{summary?.totals_input?.rows_read ?? "N/D"}</strong> · Conformes:{" "}
                                    <strong>{summary?.totals_input?.conformes ?? "N/D"}</strong> · No conformes:{" "}
                                    <strong>{summary?.totals_input?.no_conformes ?? "N/D"}</strong>
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
                                              const oiTag = fmtOiTag(oiNum, r?.oi_year, r?.oi_tag ?? r?.oi);
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
                                  <strong>{summary?.series_total_dedup ?? "N/D"}</strong> · Conformes finales:{" "}
                                  <strong>{summary?.series_conformes ?? "N/D"}</strong> · No conformes finales:{" "}
                                  <strong>{summary?.series_no_conformes_final ?? "N/D"}</strong>
                                </div>

                                <div className="mT-10">
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-outline-auto"
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
                                        {getRowsTotalRead(summary) ?? "N/D"}
                                      </strong>{" "}
                                      · Duplicados eliminados:{" "}
                                      <strong>
                                        {getDuplicatesEliminated(summary) ?? "N/D"}
                                      </strong>{" "}
                                      · Únicas = Leídos − Duplicados:{" "}
                                      <strong>
                                        {(() => {
                                          const rows = getRowsTotalRead(summary);
                                          const dup = getDuplicatesEliminated(summary);
                                          if (typeof rows === "number" && typeof dup === "number") return rows - dup;
                                          const uniques = summary?.series_total_dedup;
                                          return typeof uniques === "number" ? uniques : "N/D";
                                        })()}
                                      </strong>
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          </div>

                          <details>
                            <summary className="btn btn-sm btn-outline-auto">
                              Ver auditoría completa (JSON)
                            </summary>
                            <pre className="mT-10 small" style={{ whiteSpace: "pre-wrap" }}>
                              {safeJson(reportDetail.summary_json)}
                            </pre>
                          </details>
                        </div>
                      );
                    })()
                  ) : (
                    <div className="text-muted">Sin datos de reporte.</div>
                  )}
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-auto" onClick={closeReport}>
                    Cerrar
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" onClick={closeReport} />
        </>
      ) : null}
      <div className="row">
        <div className="col-12">
          <div className="bd bgc-white p-20 mB-20">
            <div className="d-flex flex-wrap align-items-center justify-content-between mB-10 gap-10">
              <h4 className="c-grey-900 mB-0">Historial de consolidaciones LOG-01</h4>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => navigate("/logistica/log01/excel")}
              >
                Nueva consolidación
              </button>
            </div>

            {error ? (
              <div className="alert alert-danger" role="alert">
                {error}
              </div>
            ) : null}

            <form
              className="row g-2 align-items-end"
              onSubmit={(e) => {
                e.preventDefault();
                applyFilters();
              }}
            >
              <div className="col-md-3">
                <label className="form-label">Buscar</label>
                <input
                  className="form-control form-control-sm"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") applyFilters();
                  }}
                  placeholder="Usuario, serie inicial, serie final..."
                />
              </div>
              <div className="col-md-2">
                <label className="form-label">Fecha desde</label>
                <input
                  type="date"
                  className="form-control form-control-sm"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                />
              </div>
              <div className="col-md-2">
                <label className="form-label">Fecha hasta</label>
                <input
                  type="date"
                  className="form-control form-control-sm"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                />
              </div>
              <div className="col-md-2">
                <label className="form-label">Origen</label>
                <select
                  className="form-select form-select-sm"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                >
                  <option value="">Todos</option>
                  <option value="AUTO">AUTO</option>
                  <option value="BASES">BASES</option>
                  <option value="GASELAG">GASELAG</option>
                </select>
              </div>
              <div className="col-md-2">
                <label className="form-label">Estado</label>
                <select
                  className="form-select form-select-sm"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="">Todos</option>
                  <option value="COMPLETADO">COMPLETADO</option>
                  <option value="CANCELADO">CANCELADO</option>
                  <option value="ERROR">ERROR</option>
                </select>
              </div>
              <div className="col-md-1">
                <label className="form-label">Mostrar</label>
                <select
                  className="form-select form-select-sm"
                  value={pageSize}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setPageSize(Number.isFinite(next) ? next : 20);
                    setPage(1);
                  }}
                >
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
              </div>
              <div className="col-12 d-flex flex-wrap gap-10 mT-5">
                <button type="submit" className="btn btn-sm btn-primary" disabled={loading}>
                  Buscar
                </button>
                <button type="button" className="btn btn-sm btn-outline-auto" onClick={clearFilters}>
                  Limpiar filtros
                </button>
                <button type="button" className="btn btn-sm btn-outline-auto" onClick={refresh}>
                  Recargar
                </button>
              </div>
            </form>

            <div className="mT-15">
              {loading ? (
                <div className="text-muted">Cargando historial...</div>
              ) : (
                <div className="table-responsive">
                  <table className="table table-sm mB-0">
                    <thead>
                      <tr className="small">
                        <th style={{ whiteSpace: "nowrap" }}>Fecha</th>
                        <th style={{ whiteSpace: "nowrap" }}>Usuario</th>
                        <th style={{ whiteSpace: "nowrap" }}>Estado</th>
                        <th style={{ whiteSpace: "nowrap" }}> Serie inic</th>
                        <th style={{ whiteSpace: "nowrap" }}> Serie fin </th>
                        <th style={{ whiteSpace: "nowrap" }}>Únicas</th>
                        <th style={{ whiteSpace: "nowrap" }}>Conformes</th>
                        <th style={{ whiteSpace: "nowrap" }}>No conformes</th>
                        <th style={{ whiteSpace: "nowrap" }}>Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="text-muted small">
                            Sin registros.
                          </td>
                        </tr>
                      ) : (
                        items.map((item) => {
                          const summary = item.summary_json as any;
                          const serieIni = getSummaryString(summary, "serie_ini");
                          const serieFin = getSummaryString(summary, "serie_fin");
                          const totalDedup = getSummaryNumber(summary, "series_total_dedup");
                          const conformes = getSummaryNumber(summary, "series_conformes");
                          const noConformes = getSummaryNumber(summary, "series_no_conformes_final");
                          const userLabel =
                            item.created_by_full_name || item.created_by_username || "N/D";
                          return (
                            <tr key={item.id} className="small">
                              <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(item.created_at)}</td>
                              <td style={{ whiteSpace: "nowrap" }}>{userLabel}</td>
                               <td style={{ whiteSpace: "nowrap" }}>
                                <span className={statusBadgeClass(item.status)}>{item.status}</span>
                              </td>
                              <td style={{ whiteSpace: "nowrap" }}>{serieIni}</td>
                              <td style={{ whiteSpace: "nowrap" }}>{serieFin}</td>
                              <td style={{ whiteSpace: "nowrap" }}>
                                <strong>{totalDedup}</strong>
                              </td>
                              <td style={{ whiteSpace: "nowrap" }}>
                                <strong>{conformes}</strong>
                              </td>
                              <td style={{ whiteSpace: "nowrap" }}>
                                <strong>{noConformes}</strong>
                              </td>
                              <td>
                                <div className="d-flex gap-1 flex-wrap justify-content-end">
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-outline-success"
                                    onClick={() => void downloadArtifact(item.id, "excel")}
                                  >
                                    Excel
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-outline-auto"
                                    onClick={() => void openReport(item.id)}
                                  >
                                    Ver reporte
                                  </button>
                                  {superuser ? (
                                    <button
                                      type="button"
                                      className="btn btn-sm btn-outline-auto"
                                      onClick={() => void downloadArtifact(item.id, "no-conforme")}
                                    >
                                      No conforme
                                    </button>
                                  ) : null}
                                  {superuser ? (
                                    <button
                                      type="button"
                                      className="btn btn-sm btn-outline-auto"
                                      onClick={() => void downloadArtifact(item.id, "manifiesto")}
                                    >
                                      Manifiesto
                                    </button>
                                  ) : null}
                                  {canDeleteHistory ? (
                                    <button
                                      type="button"
                                      className="btn btn-sm btn-outline-danger"
                                      onClick={() => void deleteRun(item.id)}
                                    >
                                      Eliminar
                                    </button>
                                  ) : null}
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="d-flex align-items-center justify-content-between mT-10">
                <div className="small text-muted">
                  Mostrando {from}-{to} de {total}
                </div>
                <div className="d-flex gap-10">
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-auto"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={!canPrev || loading}
                  >
                    Anterior
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-auto"
                    onClick={() => setPage((p) => p + 1)}
                    disabled={!canNext || loading}
                  >
                    Siguiente
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

