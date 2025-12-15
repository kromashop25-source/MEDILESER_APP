import { Navigate, Outlet, useLocation } from "react-router-dom";
import { getAuth, getSelectedBank, isSuperuser, isTechnicianRole, normalizeRole } from "../../api/auth";

function getModuleIdForPath(pathname: string): string | null {
  if (pathname === "/home") return null;
  if (pathname === "/oi") return "oi_formulario";
  if (pathname === "/oi/list") return "oi_listado";
  if (pathname === "/oi/tools/vima-to-lista") return "tools_vima_lista";
  if (pathname === "/oi/tools/actualizacion-base") return "tools_actualizacion_bases";
  if (pathname === "/oi/tools/consolidacion/correlativo") return "tools_consol_correlativo";
  if (pathname === "/oi/tools/consolidacion/no-correlativo") return "tools_consol_no_correlativo";
  if (pathname === "/users") return "users_admin";
  if (pathname === "/admin/permisos") return "admin_permisos";
  return null;
}

export default function RequireAuth() {
  const auth = getAuth();
  const location = useLocation();

  if (!auth?.token) return <Navigate to="/login" replace />;

  const role = normalizeRole(auth.role, auth.username);
  const superuser = isSuperuser(auth);
  const isTech = isTechnicianRole(role);

  const selectedBank = getSelectedBank();
  const needsBank = isTech && !(selectedBank && selectedBank > 0);
  if (needsBank && location.pathname !== "/home") {
    return (
      <Navigate
        to="/home"
        replace
        state={{
          toast: { kind: "warning", title: "Banco", message: "Debe seleccionar un banco para continuar." },
        }}
      />
    );
  }

  // /admin/permisos: solo superusuario (username=admin), incluso si allowedModules lo incluye.
  if (location.pathname === "/admin/permisos" && !superuser) {
    return (
      <Navigate
        to="/home"
        replace
        state={{
          toast: {
            kind: "warning",
            title: "Permisos",
            message: "Solo el superusuario puede acceder a este módulo.",
          },
        }}
      />
    );
  }

  // /users: solo admin/superusuario
  if (location.pathname === "/users" && !(role === "admin" || role === "administrator")) {
    return (
      <Navigate
        to="/home"
        replace
        state={{
          toast: {
            kind: "warning",
            title: "Usuarios",
            message: "No tiene permiso para acceder a este módulo.",
          },
        }}
      />
    );
  }

  if (!superuser) {
    const moduleId = getModuleIdForPath(location.pathname);
    const allowed = auth.allowedModules;
    if (moduleId && Array.isArray(allowed) && !allowed.includes(moduleId)) {
      return (
        <Navigate
          to="/home"
          replace
          state={{
            toast: {
              kind: "warning",
              title: "Permisos",
              message: "No tiene permiso para acceder a este módulo.",
            },
          }}
        />
      );
    }
  }

  return <Outlet />;
}
