import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import type { AxiosError } from "axios";
import {
  log01HistoryDelete,
  log01HistoryDownloadArtifact,
  log01HistoryList,
  type Log01HistoryListItem,
} from "../../api/oiTools";
import { getAuth, normalizeRole } from "../../api/auth";

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
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function getSummaryNumber(summary: any, key: string): string {
  const v = summary?.[key];
  return typeof v === "number" ? String(v) : "N/D";
}

function statusBadgeClass(status?: string | null) {
  const s = (status || "").toUpperCase();
  if (s === "COMPLETADO") return "badge bg-success";
  if (s === "ERROR") return "badge bg-danger";
  if (s === "CANCELADO") return "badge bg-warning text-dark";
  return "badge bg-secondary";
}

export default function Log01HistoryPage() {
  const navigate = useNavigate();
  const auth = getAuth();
  const role = normalizeRole(auth?.role, auth?.username);
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

  const [applied, setApplied] = useState(() => ({
    q: "",
    dateFrom: "",
    dateTo: "",
    source: "",
    status: "",
  }));

  const offset = useMemo(() => (page - 1) * pageSize, [page, pageSize]);

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

  const from = total === 0 ? 0 : offset + 1;
  const to = total === 0 ? 0 : Math.min(offset + items.length, total);
  const canPrev = page > 1;
  const canNext = offset + items.length < total;

  return (
    <div className="container-fluid">
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
                  placeholder="Usuario, operación, archivo..."
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
                <button type="button" className="btn btn-sm btn-outline-secondary" onClick={clearFilters}>
                  Limpiar filtros
                </button>
                <button type="button" className="btn btn-sm btn-outline-secondary" onClick={refresh}>
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
                                    className="btn btn-sm btn-outline-secondary"
                                    onClick={() => void downloadArtifact(item.id, "no-conforme")}
                                  >
                                    No conforme
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-outline-secondary"
                                    onClick={() => void downloadArtifact(item.id, "manifiesto")}
                                  >
                                    Manifiesto
                                  </button>
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
                    className="btn btn-sm btn-outline-secondary"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={!canPrev || loading}
                  >
                    Anterior
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary"
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
