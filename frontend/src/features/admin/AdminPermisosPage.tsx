import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listUserPermissionsPaged, updateUserPermissions } from "../../api/admin";
import type { UserPermissions } from "../../api/admin";
import Spinner from "../../components/Spinner";
import { useToast } from "../../components/Toast";

type ModuleDef = { id: string; label: string; path: string };
type GroupDef = { id: string; label: string; moduleIds: string[] };

const MODULES: ModuleDef[] = [
  { id: "oi_formulario", label: "Registro OI", path: "/oi" },
  { id: "oi_listado", label: "Listado OI", path: "/oi/list" },
  { id: "tools_vima_lista", label: "VIMA → LISTA", path: "/oi/tools/vima-to-lista" },
  { id: "tools_actualizacion_bases", label: "Actualización de Bases", path: "/oi/tools/actualizacion-base" },
  { id: "tools_historial_ac", label: "Historial A-C", path: "/oi/tools/formato-ac/history" },
  { id: "tools_consol_correlativo", label: "Consolidación (Correlativo)", path: "/oi/tools/consolidacion/correlativo" },
  { id: "tools_consol_no_correlativo", label: "Consolidación (No Correlativo)", path: "/oi/tools/consolidacion/no-correlativo" },
  { id: "future_ot", label: "Orden de Trabajo (FUTURO)", path: "FUTURO" },
  { id: "logistica", label: "Logística", path: "/logistica/log01/excel" },
  { id: "logistica_history", label: "Historial de consolidaciones", path: "/logistica/log01/history" },
  { id: "logistica_pdfs", label: "Filtrado de Cert.PDFs", path: "/logistica/log02/pdfs"},
  { id: "future_smart", label: "Smart (FUTURO)", path: "FUTURO" },
  { id: "users_admin", label: "Gestión de usuarios", path: "/users" },
  { id: "admin_permisos", label: "Permisos", path: "/admin/permisos" },
];

// Agrupación por “padre” (como Sidebar): OI, Logística, Smart (FUTURO), Usuarios, Administrar
const GROUPS: GroupDef[] = [
  {
    id: "oi",
    label: "OI",
    moduleIds: [
      "oi_formulario",
      "oi_listado",
      "tools_vima_lista",
      "tools_actualizacion_bases",
      "tools_historial_ac",
      "tools_consol_correlativo",
      "tools_consol_no_correlativo",
      "future_ot",
    ],
  },
  { id: "logistica", label: "Logística", moduleIds: ["logistica", "logistica_history", "logistica_pdfs"] },
  { id: "smart", label: "Smart (FUTURO)", moduleIds: ["future_smart"] },
  { id: "usuarios", label: "Usuarios", moduleIds: ["users_admin"] },
  { id: "administrar", label: "Administrar", moduleIds: ["admin_permisos"] },
];


function normalizeModules(mods: string[]) {
  const known = new Set(MODULES.map((m) => m.id));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of mods) {
    const mapped = m === "future_logistica" ? "logistica" : m;
    if (!known.has(mapped) || seen.has(mapped)) continue;
    seen.add(mapped);
    out.push(mapped);
  }
  return out;
}

const STORAGE_COLLAPSE_KEY = "admin_permisos:collapsed_groups";

export default function AdminPermisosPage() {
  const qc = useQueryClient();
  const { toast } = useToast();

   // Filtros  paginación (igual patrón que OI list)
  const [searchRaw, setSearchRaw] = useState("");
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("");
  const [pageSize, setPageSize] = useState<number>(20);
  const [page, setPage] = useState<number>(1); // 1-based
  const offset = (page - 1) * pageSize;

  // debounce para búsqueda
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    const t = setTimeout(() => {
      setSearch(searchRaw.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [searchRaw]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin", "permisos", { search, roleFilter, pageSize, offset }],
    queryFn: () =>
      listUserPermissionsPaged({
        q: search || undefined,
        role: roleFilter || undefined,
        limit: pageSize,
        offset,
      }),
    placeholderData: (prev) => prev,
  });

  const [editing, setEditing] = useState<UserPermissions | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const editingIsSuperuser = (editing?.username ?? "").toLowerCase() === "admin";

  // Colapso por grupo persistido
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const defaults = Object.fromEntries(GROUPS.map((g) => [g.id, true])) as Record<string, boolean>;
    try {
      const raw = localStorage.getItem(STORAGE_COLLAPSE_KEY);
      if (!raw) return defaults;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !==  "object") return defaults;
      return { ...defaults, ...parsed };
    } catch {
      return defaults;
    }
  });

  const setGroupCollapsed = (groupId: string, next: boolean) => {
    setCollapsed((prev) => {
      const out = { ...prev, [groupId]: next };
      try {
        localStorage.setItem(STORAGE_COLLAPSE_KEY, JSON.stringify(out));
      } catch {}
      return out;
    });
  };
  

  const openEdit = (u: UserPermissions) => {
    setEditing(u);
    setDraft(normalizeModules(u.allowedModules ?? []));
  };

  const closeEdit = () => {
    setEditing(null);
    setDraft([]);
  };

  const mutation = useMutation({
    mutationFn: async (payload: { userId: number; allowedModules: string[] }) =>
      updateUserPermissions(payload.userId, payload.allowedModules),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["admin", "permisos"] });
      toast({ kind: "success", title: "Permisos", message: "Permisos actualizados." });
      closeEdit();
    },
    onError: (e: any) => {
      const msg = e?.response?.data?.detail ?? e?.message ?? "No se pudieron actualizar los permisos.";
      toast({ kind: "error", title: "Permisos", message: String(msg) });
    },
  });

  const tableRows = useMemo(() => data?.items ?? [], [data]);
  const total = data?.total ?? 0;
  const limit = data?.limit ?? pageSize;
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 1;
  const from = total === 0 ? 0 : offset + 1;
  const to = total === 0 ? 0 : Math.min(offset + tableRows.length, total);
  const legend = total === 0 ? "0 registros" : `Mostrando ${from}-${to} de ${total} registros`;

  const toggle = (moduleId: string) => {
    setDraft((prev) => {
      const set = new Set(prev);
      if (set.has(moduleId)) set.delete(moduleId);
      else set.add(moduleId);
      return Array.from(set);
    });
  };

  const toggleGroup = (group: GroupDef) => {
    setDraft((prev) => {
      const set = new Set(prev);
      const children = group.moduleIds.filter((id) => MODULES.some((m) => m.id === id));
      const allSelected = children.length > 0 && children.every((id) => set.has(id));
      if (allSelected) {
        for (const id of children) set.delete(id);
      } else {
        for (const id of children) set.add(id);
      }
      return Array.from(set);
    });
  };

  const save = () => {
    if (!editing) return;
    mutation.mutate({ userId: editing.id, allowedModules: normalizeModules(draft) });
  };

  const clearFilters = () => {
    setSearchRaw("");
    setSearch("");
    setRoleFilter("");
    setPage(1);
    setPageSize(20);
  };

  return (
    <div className="container-fluid">
      <Spinner show={mutation.isPending} label="Guardando permisos..." />

      <div className="row">
        <div className="col-12">
          <div className="bgc-white p-20 bd">
            <h4 className="c-grey-900 mB-10">Administrar · Permisos</h4>
            <p className="text-muted mB-20">
              Define qué módulos puede ver cada usuario (el acceso por URL también se bloquea).
            </p>

            <div className="d-flex flex-wrap align-items-end gap-2 mb-3">
              <div style={{ minWidth: 260 }}>
                <label className="form-label small mb-1">Buscar</label>
                <input
                  type="text"
                  className="form-control form-control-sm"
                  placeholder="Usuario, nombre o rol..."
                  value={searchRaw}
                  onChange={(e) => {
                    setSearchRaw(e.target.value);
                    setPage(1);
                  }}
                />
              </div>

              <div style={{ minWidth: 220 }}>
                <label className="form-label small mb-1">Rol</label>
                <select
                  className="form-select form-select-sm"
                  value={roleFilter}
                  onChange={(e) => {
                    setRoleFilter(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">Todos</option>
                  <option value="admin">admin</option>
                  <option value="administrator">administrator</option>
                  <option value="technician">technician</option>
                  <option value="standard">standard</option>
                  <option value="user">user (legacy)</option>
                </select>
              </div>

              <div>
                <label className="form-label small mb-1">Mostrar</label>
                <select
                  className="form-select form-select-sm"
                  value={pageSize}
                  onChange={(e) => {
                    const v = Number(e.target.value) || 20;
                    setPageSize(v);
                    setPage(1);
                  }}
                >
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
              </div>

              <div className="d-flex gap-2">
                <button
                  type="button"
                  className="btn btn-sm btn-outline-auto"
                  onClick={clearFilters}
                  disabled={isLoading || mutation.isPending}
                >
                  Limpiar filtros
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-auto"
                  onClick={() => refetch()}
                  disabled={isLoading || mutation.isPending}
                >
                  Recargar
                </button>
              </div>
            </div>


            {isLoading ? (
              <div className="text-muted">Cargando usuarios...</div>
            ) : error ? (
              <div className="alert alert-danger" role="alert">
                No se pudo cargar la lista de usuarios.
              </div>
            ) : (
              <div className="table-responsive">
                <table className="table table-sm align-middle">
                  <thead>
                    <tr>
                      <th>Usuario</th>
                      <th>Rol</th>
                      <th className="text-end">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map((u) => (
                      <tr key={u.id}>
                        <td>{u.username}</td>
                        <td>{u.role}</td>
                        <td className="text-end">
                          <button
                            type="button"
                            className="btn btn-sm btn-outline-primary"
                            onClick={() => openEdit(u)}
                            disabled={(u.username ?? "").toLowerCase() === "admin"}
                          >
                            Editar
                          </button>
                        </td>
                      </tr>
                    ))}
                    {tableRows.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="text-muted">
                          No hay usuarios.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            )}

            <div className="d-flex justify-content-end mt-2">
              <small className="text-muted">{legend}</small>
            </div>

            {totalPages > 1 && (
              <nav className="mt-2 d-flex justify-content-center">
                <ul className="pagination pagination-sm mb-0">
                  <li className={`page-item ${page === 1 ? "disabled" : ""}`}>
                    <button className="page-link" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
                      «
                    </button>
                  </li>
                  <li className="page-item disabled">
                    <span className="page-link">
                      Página {page} / {totalPages}
                    </span>
                  </li>
                  <li className={`page-item ${page === totalPages ? "disabled" : ""}`}>
                    <button
                      className="page-link"
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
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
      </div>

      {editing && (
        <div
          className="modal fade show"
          style={{ display: "block" }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="permsModalTitle"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeEdit();
          }}
        >
          <div className="modal-dialog modal-dialog-centered modal-lg">
            <div className="modal-content">
              <div className="modal-header">
                <h5 id="permsModalTitle" className="modal-title">
                  Permisos de {editing.username}
                </h5>
                <button type="button" className="btn-close" aria-label="Cerrar" onClick={closeEdit} />
              </div>

              <div className="modal-body">
                {editingIsSuperuser ? (
                  <div className="alert alert-info" role="alert">
                    El superusuario <b>admin</b> siempre tiene acceso total y no se puede limitar por permisos.
                  </div>
                ) : null}
                {GROUPS.map((g) => {
                  const children = g.moduleIds
                    .map((id) => MODULES.find((m) => m.id === id))
                    .filter(Boolean) as ModuleDef[];
                  const selectedCount = children.filter((m) => draft.includes(m.id)).length;
                  const allSelected = children.length > 0 && selectedCount === children.length;
                  const someSelected = selectedCount > 0 && !allSelected;
                  const isCollapsed = !!collapsed[g.id];

                  return (
                    <div key={g.id} className="mb-3">
                      <div className="d-flex align-items-center justify-content-between">
                        <div className="form-check mb-0">
                          <input
                            className="form-check-input"
                            type="checkbox"
                            id={`grp-${editing.id}-${g.id}`}
                            checked={allSelected}
                            ref={(el) => {
                              if (el) el.indeterminate = someSelected;
                            }}
                            onChange={() => toggleGroup(g)}
                            disabled={mutation.isPending || editingIsSuperuser}
                          />
                          <label className="form-check-label fw-semibold" htmlFor={`grp-${editing.id}-${g.id}`}>
                            {g.label}
                            <span className="text-muted ms-2 small">
                              ({selectedCount}/{children.length})
                            </span>
                          </label>
                        </div>
                        <div className="btn-group btn-group-sm" role="group" aria-label={`Acciones ${g.label}`}>
                          <button
                            type="button"
                            className="btn btn-outline-auto"
                            onClick={() => setGroupCollapsed(g.id, !isCollapsed)}
                            disabled={mutation.isPending}
                          >
                            {isCollapsed ? "Expandir" : "Contraer"}
                          </button>
                        </div>
                      </div>

                      {!isCollapsed && (
                        <div className="mt-2 ms-4 ps-3 border-start border-2 border-light">
                          <div className="row">
                            {children.map((m) => (
                              <div key={m.id} className="col-md-6 mb-2">
                                <div className="form-check">
                                  <input
                                    className="form-check-input"
                                    type="checkbox"
                                    id={`perm-${editing.id}-${m.id}`}
                                    checked={draft.includes(m.id)}
                                    onChange={() => toggle(m.id)}
                                    disabled={mutation.isPending || editingIsSuperuser}
                                  />
                                  <label className="form-check-label" htmlFor={`perm-${editing.id}-${m.id}`}>
                                    {m.label} <span className="text-muted">({m.path})</span>
                                  </label>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                <div className="form-text mt-2">
                  Nota: “Cambiar contraseña” y “Home” siempre están disponibles para todos.
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-outline-auto" onClick={closeEdit} disabled={mutation.isPending}>
                  Cancelar
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={save}
                  disabled={mutation.isPending || editingIsSuperuser}
                >
                  Guardar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

