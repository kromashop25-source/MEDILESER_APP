import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { api } from "../../api/client";
import { getAuth, isSuperuser, normalizeRole } from "../../api/auth";
import { useToast } from "../../components/Toast";
import Spinner from "../../components/Spinner";
import PasswordInput from "../../components/PasswordInput";

type User = {
  id: number;
  username: string;
  first_name: string;
  last_name: string;
  tech_number: number;
  role: "admin" | "administrator" | "technician" | "standard" | "user";
};

type UsersPaged = {
  items: User[];
  total: number;
  limit: number;
  offset: number;
};

async function listUsersPaged(params: {
  q?: string;
  role?: string;
  limit: number;
  offset: number;
}): Promise<UsersPaged> {
  const res = await api.get<UsersPaged>("/auth/users/paged", {
    params: {
      q: params.q || undefined,
      role: params.role || undefined,
      limit: params.limit,
      offset: params.offset,
    },
  });
  return res.data;
}

export default function UsersPage() {
  const { toast } = useToast();
  const auth = getAuth();
  const role = normalizeRole(auth?.role, auth?.username);
  const canManageUsers = role === "admin" || role === "administrator";
  const superuser = isSuperuser(auth);

  // Estado
  const [showModal, setShowModal] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [busy, setBusy] = useState(false);

  // Filtros + paginacion
  const [searchRaw, setSearchRaw] = useState("");
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("");
  const [pageSize, setPageSize] = useState<number>(20);
  const [page, setPage] = useState<number>(1);
  const offset = (page - 1) * pageSize;

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

  // Fetch Usuarios
  const { data, refetch, isLoading, isFetching, error } = useQuery<UsersPaged>({
    queryKey: ["users", { search, roleFilter, pageSize, offset }],
    queryFn: () =>
      listUsersPaged({
        q: search || undefined,
        role: roleFilter || undefined,
        limit: pageSize,
        offset,
      }),
    enabled: canManageUsers,
    placeholderData: (prev) => prev,
  });

  const { register, handleSubmit, reset } = useForm<any>();

  const openCreate = () => {
    setEditingUser(null);
    reset({
      username: "",
      password: "",
      first_name: "",
      last_name: "",
      role: "technician",
      tech_number: 0,
    });
    setShowModal(true);
  };

  const openEdit = (u: User) => {
    setEditingUser(u);
    reset({
      username: u.username,
      password: "",
      first_name: u.first_name,
      last_name: u.last_name,
      role: normalizeRole(u.role, u.username),
      tech_number: u.tech_number,
    });
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingUser(null);
    reset();
  };

  // Crear Usuario
  const onCreate = async (data: any) => {
    try {
      setBusy(true);
      await api.post("/auth/users", { ...data, tech_number: Number(data.tech_number) });
      toast({ kind: "success", message: "Usuario creado correctamente" });
      closeModal();
      refetch();
    } catch (e: any) {
      toast({ kind: "error", title: "Error", message: e.response?.data?.detail || "Error al crear" });
    } finally {
      setBusy(false);
    }
  };

  const onUpdate = async (data: any) => {
    if (!editingUser) return;
    const password = String(data.password || "").trim();
    try {
      setBusy(true);
      if (superuser) {
        const payload: Record<string, any> = {
          username: String(data.username || "").trim(),
          first_name: String(data.first_name || "").trim(),
          last_name: String(data.last_name || "").trim(),
          role: data.role,
          tech_number: Number(data.tech_number),
        };
        if (password) payload.password = password;
        await api.put(`/auth/users/${editingUser.id}`, payload);
        toast({ kind: "success", message: "Usuario actualizado correctamente" });
      } else {
        if (!password) {
          toast({ kind: "error", message: "Debe ingresar una nueva contraseña" });
          return;
        }
        await api.put(`/auth/users/${editingUser.id}/password`, { new_password: password });
        toast({ kind: "success", message: `Contraseña de ${editingUser.username} actualizada` });
      }
      closeModal();
      refetch();
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || "Error actualizando usuario";
      toast({ kind: "error", title: "Error", message: msg });
    } finally {
      setBusy(false);
    }
  };

  // Eliminar Usuario
  const onDelete = async (u: User) => {
    if (!confirm(`¿Eliminar usuario? ${u.username}?\nEsto solo es posible si no tiene registros.`)) return;
    try {
      setBusy(true);
      await api.delete(`/auth/users/${u.id}`);
      toast({ kind: "success", message: "Usuario eliminado" });
      refetch();
    } catch (e: any) {
      toast({ kind: "error", title: "No se puede eliminar", message: e.response?.data?.detail || e.message });
    } finally {
      setBusy(false);
    }
  };

  const tableRows = useMemo(() => data?.items ?? [], [data]);
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

  const from = total === 0 ? 0 : offset + 1;
  const to = total === 0 ? 0 : Math.min(offset + tableRows.length, total);
  const legend = total === 0 ? "0 registros" : `Mostrando ${from}-${to} de ${total} registros`;

  const busyAll = isLoading || isFetching || busy;

  const clearFilters = () => {
    setSearchRaw("");
    setSearch("");
    setRoleFilter("");
    setPage(1);
    setPageSize(20);
  };

  const isEditMode = !!editingUser;
  const fieldsDisabled = isEditMode && !superuser;
  const passwordRequired = !isEditMode || !superuser;
  const editingIsAdmin = (editingUser?.username ?? "").toLowerCase() === "admin";
  const passwordHelpText = isEditMode
    ? superuser
      ? "Dejar en blanco para mantener la actual."
      : "Ingrese una nueva contraseña."
    : undefined;

  if (!canManageUsers) return <div className="p-4 text-danger">Acceso no autorizado</div>;

  return (
    <div className="container-fluid p-4 vi-oi-light">
      <Spinner show={busyAll} />

      <div className="d-flex justify-content-between align-items-center mb-4">
        <h2 className="h4 m-0">Gestión de Usuarios</h2>
        <button className="btn btn-primary" onClick={openCreate} disabled={busyAll}>
          + Nuevo Usuario
        </button>
      </div>

      <div className="d-flex flex-wrap align-items-end gap-2 mb-3">
        <div style={{ minWidth: 260 }}>
          <label className="form-label small mb-1">Buscar</label>
          <input
            type="text"
            className="form-control form-control-sm"
            placeholder="Usuario o rol..."
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
            className="btn btn-sm btn-outline-secondary"
            onClick={clearFilters}
            disabled={busyAll}
          >
            Limpiar filtros
          </button>
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            onClick={() => refetch()}
            disabled={busyAll}
          >
            Recargar
          </button>
        </div>
      </div>

      {error ? (
        <div className="alert alert-danger" role="alert">
          No se pudo cargar la lista de usuarios.
        </div>
      ) : null}

      <div className="card shadow-sm">
        <div className="table-responsive">
          <table className="table table-hover align-middle mb-0">
            <thead className="table-light">
              <tr>
                <th>Usuario</th>
                <th>Nombre</th>
                <th>Rol</th>
                <th>N° Técnico</th>
                <th className="text-end">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((u) => (
                <tr key={u.id}>
                  <td className="fw-bold">{u.username}</td>
                  <td>{u.first_name} {u.last_name}</td>
                  <td>
                    {(() => {
                      const uRole = normalizeRole(u.role, u.username);
                      const label =
                        u.username.toLowerCase() === "admin" ? "Superusuario" :
                        uRole === "administrator" ? "Administrador" :
                        uRole === "technician" ? "Técnico" :
                        "Estándar";
                      const badgeCls =
                        u.username.toLowerCase() === "admin" ? "bg-danger" :
                        uRole === "administrator" ? "bg-warning text-dark" :
                        uRole === "technician" ? "bg-info text-dark" :
                        "bg-secondary";
                      return <span className={`badge ${badgeCls}`}>{label}</span>;
                    })()}
                  </td>
                  <td>{u.tech_number}</td>
                  <td className="text-end">
                    <button
                      className="btn btn-sm btn-outline-primary me-2"
                      title="Actualizar usuario"
                      aria-label={`Actualizar ${u.username}`}
                      disabled={busyAll || u.username === "admin" || (!superuser && normalizeRole(u.role, u.username) === "administrator")}
                      onClick={() => openEdit(u)}
                    >
                      <i className="ti ti-edit" />
                    </button>
                    <button
                      className="btn btn-sm btn-outline-danger"
                      title="Eliminar usuario"
                      aria-label={`Eliminar ${u.username}`}
                      // Bloqueo visual simple, validación real en backend
                      disabled={busyAll || u.username === "admin" || (!superuser && normalizeRole(u.role, u.username) === "administrator")}
                      onClick={() => onDelete(u)}
                    >
                      <i className="ti ti-trash" />
                    </button>
                  </td>
                </tr>
              ))}
              {tableRows.length === 0 && (
                <tr><td colSpan={5} className="text-center py-4">No hay usuarios registrados</td></tr>
              )}
            </tbody>
          </table>
        </div>
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
                Anterior
              </button>
            </li>
            {Array.from({ length: endPage - startPage + 1 }, (_, i) => {
              const p = startPage + i;
              return (
                <li key={p} className={`page-item ${p === page ? "active" : ""}`}>
                  <button className="page-link" onClick={() => setPage(p)}>
                    {p}
                  </button>
                </li>
              );
            })}
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

      <div className="px-3 py-2 d-flex justify-content-end">
        <small className="text-muted">{legend}</small>
      </div>

      {/* Modal Crear/Editar */}
      {showModal && (
        <div className="modal d-block" style={{ backgroundColor: "rgba(0,0,0,0.5)" }}>
          <div className="modal-dialog">
            <form className="modal-content" onSubmit={handleSubmit(isEditMode ? onUpdate : onCreate)}>
              <div className="modal-header">
                <h5 className="modal-title">{isEditMode ? "Actualizar Usuario" : "Nuevo Usuario"}</h5>
                <button type="button" className="btn-close" onClick={closeModal}></button>
              </div>
              <div className="modal-body row g-3">
                <div className="col-6">
                  <label className="form-label">Usuario</label>
                  <input
                    className="form-control"
                    disabled={fieldsDisabled}
                    {...register("username", { required: true })}
                  />
                </div>
                <div className="col-6">
                  <PasswordInput
                    label="Contraseña"
                    {...register("password", { required: passwordRequired })}
                    autoComplete="new-password"
                    helpText={passwordHelpText}
                  />
                </div>
                <div className="col-6">
                  <label className="form-label">Nombre</label>
                  <input
                    className="form-control"
                    disabled={fieldsDisabled}
                    {...register("first_name", { required: true })}
                  />
                </div>
                <div className="col-6">
                  <label className="form-label">Apellido</label>
                  <input
                    className="form-control"
                    disabled={fieldsDisabled}
                    {...register("last_name", { required: true })}
                  />
                </div>
                <div className="col-6">
                  <label className="form-label">Rol</label>
                  <select className="form-select" disabled={fieldsDisabled} {...register("role")}>
                    {editingIsAdmin ? <option value="admin">Superusuario</option> : null}
                    <option value="technician">Tecnico</option>
                    <option value="standard">Estandar</option>
                    {superuser ? <option value="administrator">Administrador</option> : null}
                  </select>
                </div>
                <div className="col-6">
                  <label className="form-label">N Tecnico</label>
                  <input
                    type="number"
                    className="form-control"
                    disabled={fieldsDisabled}
                    {...register("tech_number", { required: true })}
                  />
                  <div className="form-text small">Use 0 si no aplica (admin/estandar)</div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={closeModal} disabled={busyAll}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={busyAll}>
                  {isEditMode ? "Actualizar" : "Guardar"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
}
