import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import type { AxiosError } from "axios";
import {
  formatoAcHistoryDownload,
  formatoAcHistoryList,
  type FormatoAcHistoryListItem,
} from "../../api/oiTools";

const PERU_TZ = "America/Lima";

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
  const hasTz = /[zZ]$/.test(value) || /[+-]\d{2}:\d{2}$/.test(value) || /[+-]\d{4}$/.test(value);
  const safe = hasTz ? value : `${value}Z`;
  const d = new Date(safe);
  if (Number.isNaN(d.getTime())) return String(value);
  const fmt = new Intl.DateTimeFormat("es-PE", {
    timeZone: PERU_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}

function statusBadgeClass(status?: string | null) {
  const s = (status || "").toUpperCase();
  if (s === "COMPLETADO") return "badge bg-success";
  if (s === "ERROR") return "badge bg-danger";
  return "badge bg-secondary";
}

function formatOrigin(origin?: string | null) {
  const key = (origin || "").toUpperCase();
  if (key === "VIMA_LISTA") return "VIMA LISTA";
  if (key === "ACTUALIZACION_BASES") return "ACTUALIZACION BASES";
  return origin || "N/D";
}

export default function FormatoAcHistoryPage() {
  const [items, setItems] = useState<FormatoAcHistoryListItem[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [reloadKey, setReloadKey] = useState<number>(0);

  const [search, setSearch] = useState<string>("");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [origin, setOrigin] = useState<string>("");
  const [pageSize, setPageSize] = useState<number>(20);
  const [page, setPage] = useState<number>(1);

  const [applied, setApplied] = useState(() => ({
    q: "",
    dateFrom: "",
    dateTo: "",
    origin: "",
  }));

  const offset = useMemo(() => (page - 1) * pageSize, [page, pageSize]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    formatoAcHistoryList({
      limit: pageSize,
      offset,
      q: applied.q || undefined,
      dateFrom: applied.dateFrom || undefined,
      dateTo: applied.dateTo || undefined,
      origin: applied.origin || undefined,
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
      origin: origin.trim(),
    });
    setPage(1);
  };

  const clearFilters = () => {
    setSearch("");
    setDateFrom("");
    setDateTo("");
    setOrigin("");
    setApplied({ q: "", dateFrom: "", dateTo: "", origin: "" });
    setPage(1);
    setReloadKey((v) => v + 1);
  };

  const refresh = () => setReloadKey((v) => v + 1);

  const downloadArtifact = async (runId: number) => {
    try {
      setError("");
      const res = await formatoAcHistoryDownload(runId);
      const cd = res.headers["content-disposition"] as string | undefined;
      const xf = res.headers["x-file-name"] as string | undefined;
      const filename = parseFilename(cd) ?? xf ?? "formato_ac.xlsx";
      downloadBlob(res.data, filename);
    } catch (e) {
      const ax = e as AxiosError<any>;
      if (axios.isCancel(ax)) return;
      const detail = (ax.response?.data?.detail as string) || ax.message || "No se pudo descargar.";
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
              <h4 className="c-grey-900 mB-0">Historial A-C</h4>
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
              <div className="col-md-4">
                <label className="form-label">Buscar</label>
                <input
                  className="form-control form-control-sm"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") applyFilters();
                  }}
                  placeholder="Operacion o usuario..."
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
                  value={origin}
                  onChange={(e) => setOrigin(e.target.value)}
                >
                  <option value="">Todos</option>
                  <option value="VIMA_LISTA">VIMA LISTA</option>
                  <option value="ACTUALIZACION_BASES">ACTUALIZACION BASES</option>
                </select>
              </div>
              <div className="col-md-2">
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
                        <th style={{ whiteSpace: "nowrap" }}>Operacion</th>
                        <th style={{ whiteSpace: "nowrap" }}>Fecha</th>
                        <th style={{ whiteSpace: "nowrap" }}>Usuario</th>
                        <th style={{ whiteSpace: "nowrap" }}>Origen</th>
                        <th style={{ whiteSpace: "nowrap" }}>Estado</th>
                        <th style={{ whiteSpace: "nowrap" }}>Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="text-muted small">
                            Sin registros.
                          </td>
                        </tr>
                      ) : (
                        items.map((item) => {
                          const userLabel =
                            item.created_by_full_name || item.created_by_username || "N/D";
                          return (
                            <tr key={item.id} className="small">
                              <td style={{ whiteSpace: "nowrap" }}>{item.operation_id}</td>
                              <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(item.created_at)}</td>
                              <td style={{ whiteSpace: "nowrap" }}>{userLabel}</td>
                              <td style={{ whiteSpace: "nowrap" }}>{formatOrigin(item.origin)}</td>
                              <td style={{ whiteSpace: "nowrap" }}>
                                <span className={statusBadgeClass(item.status)}>{item.status}</span>
                              </td>
                              <td>
                                <div className="d-flex gap-1 flex-wrap justify-content-end">
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-outline-success"
                                    onClick={() => void downloadArtifact(item.id)}
                                  >
                                    Descargar
                                  </button>
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
                  Mostrando {from}-{to} de {total} registros
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
