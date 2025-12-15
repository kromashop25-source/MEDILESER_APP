import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { api } from "../../api/client";
import { getAuth, isSuperuser, normalizeRole } from "../../api/auth";
import { useToast } from "../../components/Toast";
import Spinner from "../../components/Spinner";
import PasswordModal from "../oi/PasswordModal";
import PasswordInput from "../../components/PasswordInput";

type User = {
  id: number;
  username: string;
  first_name: string;
  last_name: string;
  tech_number: number;
  role: "admin" | "administrator" | "technician" | "standard" | "user";
};

export default function UsersPage() {
  const { toast } = useToast();
  const auth = getAuth();
  const role = normalizeRole(auth?.role, auth?.username);
  const canManageUsers = role === "admin" || role === "administrator";
  const superuser = isSuperuser(auth);

  // Estado
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pwdUser, setPwdUser] = useState<User | null>(null); // Usuario al que se cambiará la clave

  // Fetch Usuarios
  const { data: users, refetch, isLoading } = useQuery<User[]>({
    queryKey: ["users"],
    queryFn: async () => (await api.get("/auth/users")).data,
    enabled: canManageUsers,
  });

  const { register, handleSubmit, reset } = useForm<any>();

  // Crear Usuario
  const onCreate = async (data: any) => {
    try {
      setBusy(true);
      await api.post("/auth/users", { ...data, tech_number: Number(data.tech_number) });
      toast({ kind: "success", message: "Usuario creado correctamente" });
      setShowCreate(false);
      reset();
      refetch();
    } catch (e: any) {
      toast({ kind: "error", title: "Error", message: e.response?.data?.detail || "Error al crear" });
    } finally {
      setBusy(false);
    }
  };

  // Eliminar Usuario
  const onDelete = async (u: User) => {
    if (!confirm(`¿Eliminar usuario ${u.username}?\nEsto solo es posible si no tiene registros.`)) return;
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

  // Cambio de Clave (Admin -> Usuario)
  const onChangePass = async (newPass: string) => {
    if (!pwdUser) return;
    try {
      setBusy(true);
      await api.put(`/auth/users/${pwdUser.id}/password`, { new_password: newPass });
      toast({ kind: "success", message: `Contraseña de ${pwdUser.username} actualizada` });
      setPwdUser(null);
    } catch (e: any) {
      toast({ kind: "error", message: e.response?.data?.detail || "Error actualizando clave" });
    } finally {
      setBusy(false);
    }
  };

  if (!canManageUsers) return <div className="p-4 text-danger">Acceso no autorizado</div>;

  return (
    <div className="container-fluid p-4 vi-oi-light">
      <Spinner show={isLoading || busy} />

      <div className="d-flex justify-content-between align-items-center mb-4">
        <h2 className="h4 m-0">Gestión de Usuarios</h2>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          + Nuevo Usuario
        </button>
      </div>

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
              {users?.map((u) => (
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
                      title="Cambiar contraseña"
                      aria-label={`Cambiar contraseña de ${u.username}`}
                      disabled={u.username === "admin" || (!superuser && normalizeRole(u.role, u.username) === "administrator")}
                      onClick={() => setPwdUser(u)}
                    >
                      <i className="ti ti-key" />
                    </button>
                    <button
                      className="btn btn-sm btn-outline-danger"
                      title="Eliminar usuario"
                      aria-label={`Eliminar ${u.username}`}
                      // Bloqueo visual simple, validación real en backend
                      disabled={u.username === "admin" || (!superuser && normalizeRole(u.role, u.username) === "administrator")}
                      onClick={() => onDelete(u)}
                    >
                      <i className="ti ti-trash" />
                    </button>
                  </td>
                </tr>
              ))}
              {users?.length === 0 && (
                <tr><td colSpan={5} className="text-center py-4">No hay usuarios registrados</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal Crear */}
      {showCreate && (
        <div className="modal d-block" style={{ backgroundColor: "rgba(0,0,0,0.5)" }}>
          <div className="modal-dialog">
            <form className="modal-content" onSubmit={handleSubmit(onCreate)}>
              <div className="modal-header">
                <h5 className="modal-title">Nuevo Usuario</h5>
                <button type="button" className="btn-close" onClick={() => setShowCreate(false)}></button>
              </div>
              <div className="modal-body row g-3">
                <div className="col-6">
                  <label className="form-label">Usuario</label>
                  <input className="form-control" {...register("username", { required: true })} />
                </div>
                <div className="col-6">
                  <PasswordInput
                    label="Contraseña"
                    {...register("password", { required: true })}
                    autoComplete="new-password"
                  />
                </div>
                <div className="col-6">
                  <label className="form-label">Nombre</label>
                  <input className="form-control" {...register("first_name", { required: true })} />
                </div>
                <div className="col-6">
                  <label className="form-label">Apellido</label>
                  <input className="form-control" {...register("last_name", { required: true })} />
                </div>
                <div className="col-6">
                  <label className="form-label">Rol</label>
                  <select className="form-select" {...register("role")}>
                    <option value="technician">Técnico</option>
                    <option value="standard">Estándar</option>
                    {superuser ? <option value="administrator">Administrador</option> : null}
                  </select>
                </div>
                <div className="col-6">
                  <label className="form-label">N° Técnico</label>
                  <input type="number" className="form-control" {...register("tech_number", { required: true })} />
                  <div className="form-text small">Use 0 si no aplica (admin/estándar)</div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancelar</button>
                <button type="submit" className="btn btn-primary">Guardar</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Cambio de Clave */}
      <PasswordModal
        show={!!pwdUser}
        title={`Cambiar contraseña de ${pwdUser?.username}`}
        onClose={() => setPwdUser(null)}
        onConfirm={onChangePass}
        confirmLabel="Cambiar contraseña"
        helpText="Esta acción cambia la contraseña de inicio de sesión del usuario."
      />
    </div>
  );
}
