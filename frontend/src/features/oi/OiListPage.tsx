import { useQuery } from "@tanstack/react-query";
import {
  listOI,
  listResponsables,
  generateExcel,
  saveCurrentOI,
  clearCurrentOI,
  deleteOI,
} from "../../api/oi";

import type { OIListResponse, OIRead } from "../../api/oi";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useState, useEffect, useRef } from "react";
import { useToast } from "../../components/Toast";
import Spinner from "../../components/Spinner";
import PasswordModal from "./PasswordModal";
import { getAuth, normalizeRole } from "../../api/auth";
import { closeOpenOiIfAny } from "../../api/client";


export default function OiListPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [, setSearchParams] = useSearchParams();

  // Filtros y paginación
  const [searchRaw, setSearchRaw] = useState(() => new URLSearchParams(location.search).get("q") ?? "");
  const [search, setSearch] = useState(() => (new URLSearchParams(location.search).get("q") ?? "").trim());
  const [dateFrom, setDateFrom] = useState(() => new URLSearchParams(location.search).get("dateFrom") ?? "");
  const [dateTo, setDateTo] = useState(() => new URLSearchParams(location.search).get("dateTo") ?? "");
  const [pageSize, setPageSize] = useState(() => {
    const raw = new URLSearchParams(location.search).get("pageSize");
    const v = raw ? Number(raw) : 20;
    return Number.isFinite(v) && v > 0 ? v : 20;
  }); // por defecto 20
  const [page, setPage] = useState(() => {
    const raw = new URLSearchParams(location.search).get("page");
    const v = raw ? Number(raw) : 1;
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 1;
  }); // página 1-based
  const [responsableTech, setResponsableTech] = useState<string>(
    () => new URLSearchParams(location.search).get("responsableTech") ?? ""
  ); // "" = todos

  const offset = (page - 1) * pageSize;

  // Debounce ligero para la búsqueda "en tiempo real"
  const searchDidMount = useRef(false);
  useEffect(() => {
    if (!searchDidMount.current) {
      searchDidMount.current = true;
      return;
    }
    const t = setTimeout(() => {
      setSearch(searchRaw.trim());
      setPage(1); // al cambiar búsqueda, volvemos a página 1
    }, 300);
    return () => clearTimeout(t);
  }, [searchRaw]);

  // Persistir filtros/paginación en URL (query string)
  useEffect(() => {
    const next = new URLSearchParams();
    const q = searchRaw.trim();
    if (q) next.set("q", q);
    if (dateFrom) next.set("dateFrom", dateFrom);
    if (dateTo) next.set("dateTo", dateTo);
    if (responsableTech) next.set("responsableTech", responsableTech);
    if (page !== 1) next.set("page", String(page));
    if (pageSize !== 20) next.set("pageSize", String(pageSize));

    const current = location.search.startsWith("?") ? location.search.slice(1) : location.search;
    const desired = next.toString();
    if (desired !== current) {
      setSearchParams(next, { replace: true });
    }
  }, [dateFrom, dateTo, location.search, page, pageSize, responsableTech, searchRaw, setSearchParams]);

  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery<OIListResponse>({
    queryKey: ["oi", "list", { search, dateFrom, dateTo, responsableTech, pageSize, offset }],
    queryFn: () =>
      listOI({
        q: search || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        responsableTechNumber: responsableTech ? Number(responsableTech) : undefined,
        limit: pageSize,
        offset,
      }),

        // Conserva los datos anteriores mientras se trae la nueva página/búsqueda
        placeholderData: (prev) => prev,
      });

  // Usuario autenticado y rol (admin vs técnico)
  const auth = getAuth();
  const isAdmin = normalizeRole(auth?.role, auth?.username) !== "technician";
  const {
    data: responsables = [],
    isFetching: loadingResponsables,
    isError: responsablesIsError,
    error: responsablesError,
  } = useQuery({
    queryKey: ["oi", "responsables"],
    queryFn: listResponsables,
    enabled: isAdmin,
    staleTime: 60_000,
    retry: false,
  });
  const responsablesErrorMsg = responsablesIsError
    ? ((responsablesError as any)?.message ?? "No se pudo cargar responsables")
    : "";
  const formatDateTime = (iso: string | null | undefined) => {
    if (!iso) return "-";

    const dateString = iso.endsWith("Z") ? iso : `${iso}Z`;
    const d = new Date(dateString);

    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}`;
  };

  const items: OIRead[] = data?.items ?? [];
  const rows = items;

  const summary = data?.summary ?? {
    medidores_resultado: 0,
    oi_unicas: 0,
    medidores_total_oi_unicas: 0,
  };

  const total = data?.total ?? 0;
  const limit = data?.limit ?? pageSize;

  const totalPages = limit > 0 ? Math.ceil(total / limit) : 1;

  const maxButtons = 10;
  let startPage = 1;
  let endPage = totalPages;

  if (totalPages > maxButtons) {
    const half = Math.floor(maxButtons / 2);
    startPage = Math.max(1, page - half);
    endPage = startPage + maxButtons - 1;
    if (endPage > totalPages) {
      endPage = totalPages;
      startPage = Math.max(1, endPage - maxButtons + 1);
    }
  }

  // Estados para el flujo de Excel protegido
  const [showPwd, setShowPwd] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [generating, setGenerating] = useState(false);

  const busy = isLoading || isFetching || generating;

  const buildReturnTo = () => `${location.pathname}${location.search}`;

  const handleView = (id: number, code: string) => {
    try {
      saveCurrentOI({ id, code });
      toast({ kind: "success", message: `OI ${code} cargada` });
      navigate(`/oi/${id}?mode=view`, { state: { returnTo: buildReturnTo() } });
    } catch (e: any) {
      toast({
        kind: "error",
        title: "Error",
        message: e?.message ?? "No se pudo abrir el OI",
      });
    }
  };

  const handleEdit = (id: number, code: string) => {
    try {
      saveCurrentOI({ id, code });
      toast({ kind: "success", message: `OI ${code} cargada` });
      navigate(`/oi/${id}?mode=edit`, { state: { returnTo: buildReturnTo() } });
    } catch (e: any) {
      toast({
        kind: "error",
        title: "Error",
        message: e?.message ?? "No se pudo abrir el OI",
      });
    }
  };

  const handleNewOi = async () => {
    try {
      await closeOpenOiIfAny();
    } finally {
      clearCurrentOI();
      navigate(`/oi?mode=edit`, { state: { returnTo: buildReturnTo() } });
    }
  };

  const handleDelete = async (id: number, code: string) => {
    if (
      !confirm(
        `¿Estás seguro de ELIMINAR la ${code}?\nEsta acción borrará todas sus bancadas y no se puede deshacer.`
      )
    )
      return;

    try {
      await deleteOI(id);
      toast({
        kind: "success",
        title: "Eliminado",
        message: `Se eliminó ${code} correctamente.`,
      });
      refetch();
    } catch (e: any) {
      toast({
        kind: "error",
        title: "Error",
        message: e.message || "No se pudo eliminar la OI",
      });
    }
  };

  // Paso 1: Abrir modal
  const handleExcelClick = (id: number) => {
    setSelectedId(id);
    setShowPwd(true);
  };

  // Paso 2: Confirmar con password
  const handleExcelConfirm = async (password: string) => {
    if (!selectedId) return;
    try {
      setGenerating(true);
      await generateExcel(selectedId, password);
      toast({ kind: "success", message: "Excel generado" });
    } catch (e: any) {
      toast({
        kind: "error",
        title: "Error",
        message: e?.message ?? "No se pudo generar el Excel",
      });
    } finally {
      setGenerating(false);
    }
  };

  const handleClearFilters = () => {
    setSearchRaw("");
    setSearch("");
    setDateFrom("");
    setDateTo("");
    setPage(1);
    setResponsableTech("");
  };
  const from = total === 0 ? 0 : offset + 1;
  const to = total === 0 ? 0 : Math.min(offset + rows.length, total);
  const legend =
    total === 0 ? "0 registros" : `Mostrando ${from}-${to} de ${total} registros`;

  return (
    <div>
      <Spinner show={busy} />
      <div className="d-flex align-items-center justify-content-between mb-3">
        <div className="d-flex align-items-center gap-2">
          <button className="btn btn-primary" onClick={handleNewOi} disabled={busy} title="Nueva OI">
            Nueva OI
          </button>
          <h1 className="h3 mb-0">Listado de OI</h1>
        </div>
        <div className="d-flex gap-2">
          <button
            className="btn btn-outline-secondary"
            onClick={handleClearFilters}
            disabled={busy}
          >
            Limpiar filtros
          </button>
          <button
            className="btn btn-outline-secondary"
            onClick={() => refetch()}
            disabled={busy}
          >
            Recargar
          </button>
        </div>
      </div>

      {isError && (
        <div className="alert alert-danger">
          {(error as any)?.message ?? "Error cargando listado"}
        </div>
      )}

      <div className="card vi-card-table">
        <div className="card-header d-flex flex-wrap align-items-center justify-content-between gap-2">
          <div>
            <h2 className="h6 mb-0">Registros</h2>
            <small className="text-muted">
              Medidores (resultados): {summary.medidores_resultado} | OI unicas: {summary.oi_unicas} | Medidores (Total OI): {summary.medidores_total_oi_unicas}
            </small>
          </div>
          <div className="d-flex flex-wrap align-items-center gap-2">
            <input
              type="text"
              className="form-control form-control-sm"
              placeholder="Buscar OI o medidor..."
              value={searchRaw}
              onChange={(e) => {
                setSearchRaw(e.target.value);
                setPage(1);
              }}
              aria-label="Buscar por codigo de OI o medidor"
            />
            <input
              type="date"
              className="form-control form-control-sm"
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setPage(1);
              }}
              aria-label="Filtrar desde fecha"
            />
            <input
              type="date"
              className="form-control form-control-sm"
              value={dateTo}
              onChange={(e) => {
                setDateTo(e.target.value);
                setPage(1);
              }}
              aria-label="Filtrar hasta fecha"
            />
            {isAdmin && (
              <div className="d-flex flex-column">
                <select
                  className="form-select form-select-sm"
                  value={responsableTech}
                  onChange={(e) => {
                    setResponsableTech(e.target.value);
                    setPage(1);
                  }}
                  disabled={busy || loadingResponsables}
                  aria-label="Filtrar por responsable"
                  title="Responsable"
                >
                  <option value="">Responsable: Todos</option>
                  {responsables.map((u) => (
                    <option key={u.tech_number} value={String(u.tech_number)}>
                      {u.full_name}
                    </option>
                  ))}
                </select>
                {responsablesErrorMsg ? (
                  <small className="text-danger">{responsablesErrorMsg}</small>
                ) : null}
              </div>
            )}

            <div className="d-flex align-items-center">
              <span className="me-1 small">Mostrar</span>
              <select
                className="form-select form-select-sm"
                value={pageSize}
                onChange={(e) => {
                  const newSize = Number(e.target.value) || 20;
                  setPageSize(newSize);
                  setPage(1);
                }}
                aria-label="Registros por página"
              >
                <option value={10}>10</option>
                <option value={20}>20</option>
                <option value={50}>50</option>
              </select>
            </div>
          </div>
        </div>

        <div className="card-body p-0">
          <div className="table-responsive">
            <table className="table table-hover table-striped table-sm align-middle mb-0">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>OI</th>
                  <th>Medidores</th>
                  <th>Q3</th>
                  <th>Alcance</th>
                  <th>PMA</th>
                  <th>Banco</th>
                  <th>Técnico</th>
                  <th>Responsable</th>
                  <th>Creación</th>
                  <th>Guardado</th>
                  <th>Últ. mod.</th>
                  <th className="text-end">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {!busy && rows.length === 0 && (
                  <tr>
                    <td colSpan={13} className="text-center text-muted py-3">
                      {total > 0
                        ? "No hay registros que coincidan con los filtros."
                        : "Sin registros."}
                    </td>
                  </tr>
                )}

                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.id}</td>
                    <td>{r.code}</td>
                    <td title="Mi registro / Total OI">
                      {`${r.medidores_usuario ?? 0} / ${r.medidores_total_code ?? 0}`}
                    </td>
                    <td>{r.q3}</td>
                    <td>{r.alcance}</td>
                    <td>{r.pma}</td>
                    <td>{r.banco_id}</td>
                    <td>{r.tech_number}</td>
                    <td>{r.creator_name}</td>
                    <td>{formatDateTime(r.created_at)}</td>
                    <td>{formatDateTime(r.saved_at)}</td>
                    <td>{formatDateTime(r.updated_at)}</td>
                    <td className="text-end">
                      <button
                        className="btn btn-sm btn-outline-primary me-2"
                        onClick={() => handleView(r.id, r.code)}
                        disabled={busy}
                        title="Ver OI"
                        aria-label={`Ver OI ${r.code}`}
                      >
                        Ver
                      </button>
                      <button
                        className="btn btn-sm btn-outline-warning me-2"
                        onClick={() => handleEdit(r.id, r.code)}
                        disabled={busy}
                        title="Editar OI"
                        aria-label={`Editar OI ${r.code}`}
                      >
                        Editar
                      </button>
                      <button
                        className="btn btn-sm btn-outline-success"
                        onClick={() => handleExcelClick(r.id)}
                        disabled={busy}
                        title="Descargar Excel"
                        aria-label={`Descargar Excel ${r.code}`}
                      >
                        Excel
                      </button>
                      {isAdmin && (
                        <button
                          className="btn btn-sm btn-outline-danger ms-2"
                          onClick={() => handleDelete(r.id, r.code)}
                          disabled={busy}
                          title="Eliminar OI (Solo Admin)"
                        >
                          🗑️
                        </button>
                      )}
                      
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <nav className="px-3 py-2 d-flex justify-content-center">
              <ul className="pagination pagination-sm mb-0">
                <li className={`page-item ${page === 1 ? "disabled" : ""}`}>
                  <button
                    className="page-link"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                  >
                    «
                  </button>
                </li>
                {Array.from({ length: endPage - startPage + 1 }, (_, i) => {
                  const p = startPage + i;
                  return (
                    <li
                      key={p}
                      className={`page-item ${p === page ? "active" : ""}`}
                    >
                      <button
                        className="page-link"
                        onClick={() => setPage(p)}
                      >
                        {p}
                      </button>
                    </li>
                  );
                })}
                <li
                  className={`page-item ${
                    page === totalPages ? "disabled" : ""
                  }`}
                >
                  <button
                    className="page-link"
                    onClick={() =>
                      setPage((p) => Math.min(totalPages, p + 1))
                    }
                    disabled={page === totalPages}
                  >
                    Siguiente
                  </button>
                </li>
              </ul>
            </nav>
          )}
        </div>
      </div>
      <div className="px-3 py-2 d-flex justify-content-end">
        <small className="text-muted">{legend}</small>
      </div>


      <PasswordModal
        show={showPwd}
        title="Contraseña para proteger Excel"
        onClose={() => {
          setShowPwd(false);
          setSelectedId(null);
        }}
        onConfirm={(pwd) => {
          setShowPwd(false);
          handleExcelConfirm(pwd);
        }}
      />
    </div>
  );
}
