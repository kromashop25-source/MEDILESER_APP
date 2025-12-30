import { Routes, Route, Navigate } from "react-router-dom";
import LoginPage from "../features/auth/LoginPage";
import OiPage from "../features/oi/OiPage";
import RequireAuth from "../features/auth/RequireAuth";
import AdminatorLayout from "../layouts/AdminatorLayout";
import OiListPage from "../features/oi/OiListPage";
import UsersPage from "../features/users/UsersPage";
import ChangePasswordPage from "../features/auth/ChangePasswordPage";
import AdminPermisosPage from "../features/admin/AdminPermisosPage";
import VimaToListaPage from "../features/oi_tools/VimaToListaPage";
import ActualizacionBasePage from "../features/oi_tools/ActualizacionBasePage";
import ConsolidacionOisPage from "../features/oi_tools/ConsolidacionOisPage";
import ConsolidacionCorrelativoPage from "../features/oi_tools/ConsolidacionCorrelativoPage";
import ConsolidacionNoCorrelativoPage from "../features/oi_tools/ConsolidacionNoCorrelativoPage";
import ExcelToolsPage from "../features/oi_tools/ExcelToolsPage";
import HomePage from "../features/home/HomePage";
import { getAuth } from "../api/auth";
import Log01ExcelPage  from "../features/logistica/Log01ExcelPage";


export default function AppRouter() {
  const auth = getAuth();

  return (
  <>
      {/* Login sin sidebar ni topbar */}
      <Routes>
        <Route
          path="/login"
          element={auth?.token ? <Navigate to="/home" replace /> : <LoginPage />}
        />

        {/* Rutas protegidas: el Topbar y el Sidebar están dentro de AdminatorLayout */}
        <Route element={<RequireAuth />}>
          <Route element={<AdminatorLayout />}>
            <Route path="/" element={<Navigate to="/home" replace />} />
            <Route path="/home" element={<HomePage />} />
            <Route path="/oi" element={<OiPage />} />
            <Route path="/oi/:oiId" element={<OiPage />} />
            <Route path="/oi/list" element={<OiListPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/password" element={<ChangePasswordPage />} />
            <Route path="/admin/permisos" element={<AdminPermisosPage />} />
            <Route path="/logistica/log01/excel" element={<Log01ExcelPage />} />

            {/* OI Tools (Fase 2.2: páginas cascarón; menú se habilita luego) */}
            <Route path="/oi/tools/vima-to-lista" element={<VimaToListaPage />} />
            <Route path="/oi/tools/actualizacion-base" element={<ActualizacionBasePage />} />
            <Route path="/oi/tools/consolidacion" element={<ConsolidacionOisPage />} />
            <Route path="/oi/tools/consolidacion/correlativo" element={<ConsolidacionCorrelativoPage />} />
            <Route path="/oi/tools/consolidacion/no-correlativo" element={<ConsolidacionNoCorrelativoPage />} />
            <Route path="/oi/tools/excel" element={<ExcelToolsPage />} />
           </Route>
        </Route>

        <Route path="*" element={<Navigate to={auth?.token ? "/home" : "/login"} replace />} />
      </Routes>
    </>
  );
}
