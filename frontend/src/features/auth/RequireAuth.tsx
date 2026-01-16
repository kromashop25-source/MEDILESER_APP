import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { getAuth, getSelectedBank, isSuperuser, isTechnicianRole, normalizeRole } from "../../api/auth";
import Spinner from "../../components/Spinner";
import { api, handleAuthFailure } from "../../api/client";

function getModuleIdForPath(pathname: string): string | null {
  if (pathname === "/home") return null;
  if (pathname === "/oi") return "oi_formulario";
  if (pathname === "/oi/list") return "oi_listado";
  if (pathname === "/oi/tools/vima-to-lista") return "tools_vima_lista";
  if (pathname === "/oi/tools/actualizacion-base") return "tools_actualizacion_bases";
  if (pathname === "/oi/tools/formato-ac/history") return "tools_historial_ac";
  if (pathname === "/oi/tools/consolidacion/correlativo") return "tools_consol_correlativo";
  if (pathname === "/oi/tools/consolidacion/no-correlativo") return "tools_consol_no_correlativo";
  if (pathname === "/logistica/log01/history") return "logistica_history";
  if (pathname === "/logistica/log01/excel") return "logistica";
  if (pathname === "/logistica/log02/pdfs") return "logistica_pdfs";
  if (pathname.startsWith("/logistica/")) return "logistica";
  if (pathname.startsWith("/oi/")) return "oi_formulario";
  if (pathname === "/users") return "users_admin";
  if (pathname === "/admin/permisos") return "admin_permisos";
  return null;
}

export default function RequireAuth() {
  const auth = getAuth();
  const location = useLocation();

  const token = auth?.token ?? null;
  const [checkingSession, setCheckingSession] = useState<boolean>(() => !!token);

  // Validación de sesión: evita quedar "dentro" del módulo con sesión expirada.
  useEffect(() => {
    if (!token) {
      setCheckingSession(false);
      return;
    }
    let cancelled = false;
    setCheckingSession(true);
    api
      .get("/auth/me")
      .then(() => {
        if (!cancelled) setCheckingSession(false);
      })
      .catch(async (e: any) => {
        if (cancelled) return;
        const status = e?.response?.status;
        if (status === 401) {
          await handleAuthFailure();
          return;
        }
        setCheckingSession(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!token) return <Navigate to="/login" replace />;
  if (checkingSession) return <Spinner show />;

  const authed = auth!;
  const role = normalizeRole(authed.role, authed.username);
  const superuser = isSuperuser(authed);
  const isTech = isTechnicianRole(role);

  const selectedBank = getSelectedBank();
  const isOiArea = location.pathname === "/oi" || location.pathname.startsWith("/oi/");
  const needsBank = isTech && isOiArea && !(selectedBank && selectedBank > 0);
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
    const allowed = authed.allowedModules;
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
