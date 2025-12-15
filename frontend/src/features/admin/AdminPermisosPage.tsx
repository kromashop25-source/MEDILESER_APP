import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listUserPermissions, updateUserPermissions } from "../../api/admin";
import type { UserPermissions } from "../../api/admin";
import Spinner from "../../components/Spinner";
import { useToast } from "../../components/Toast";

type ModuleDef = { id: string; label: string; path: string };

const MODULES: ModuleDef[] = [
  { id: "oi_formulario", label: "Registro OI", path: "/oi" },
  { id: "oi_listado", label: "Listado OI", path: "/oi/list" },
  { id: "tools_vima_lista", label: "VIMA → LISTA", path: "/oi/tools/vima-to-lista" },
  { id: "tools_actualizacion_bases", label: "Actualización de Bases", path: "/oi/tools/actualizacion-base" },
  { id: "tools_consol_correlativo", label: "Consolidación (Correlativo)", path: "/oi/tools/consolidacion/correlativo" },
  { id: "tools_consol_no_correlativo", label: "Consolidación (No Correlativo)", path: "/oi/tools/consolidacion/no-correlativo" },
  { id: "users_admin", label: "Gestión de usuarios", path: "/users" },
  { id: "admin_permisos", label: "Permisos", path: "/admin/permisos" },
];

function normalizeModules(mods: string[]) {
  const known = new Set(MODULES.map((m) => m.id));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of mods) {
    if (!known.has(m) || seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

export default function AdminPermisosPage() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading, error } = useQuery<UserPermissions[]>({
    queryKey: ["admin", "permisos"],
    queryFn: listUserPermissions,
  });

  const [editing, setEditing] = useState<UserPermissions | null>(null);
  const [draft, setDraft] = useState<string[]>([]);

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

  const tableRows = useMemo(() => data ?? [], [data]);

  const toggle = (moduleId: string) => {
    setDraft((prev) => {
      const set = new Set(prev);
      if (set.has(moduleId)) set.delete(moduleId);
      else set.add(moduleId);
      return Array.from(set);
    });
  };

  const save = () => {
    if (!editing) return;
    mutation.mutate({ userId: editing.id, allowedModules: normalizeModules(draft) });
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
                          <button type="button" className="btn btn-sm btn-outline-primary" onClick={() => openEdit(u)}>
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
                <div className="row">
                  {MODULES.map((m) => (
                    <div key={m.id} className="col-md-6 mb-2">
                      <div className="form-check">
                        <input
                          className="form-check-input"
                          type="checkbox"
                          id={`perm-${editing.id}-${m.id}`}
                          checked={draft.includes(m.id)}
                          onChange={() => toggle(m.id)}
                          disabled={mutation.isPending}
                        />
                        <label className="form-check-label" htmlFor={`perm-${editing.id}-${m.id}`}>
                          {m.label} <span className="text-muted">({m.path})</span>
                        </label>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="form-text mt-2">
                  Nota: “Cambiar contraseña” y “Home” siempre están disponibles para todos.
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-outline-secondary" onClick={closeEdit} disabled={mutation.isPending}>
                  Cancelar
                </button>
                <button type="button" className="btn btn-primary" onClick={save} disabled={mutation.isPending}>
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

