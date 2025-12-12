import { NavLink } from "react-router-dom";
import { getAuth } from "../api/auth";

type Props = { collapsed?: boolean; onToggleSidebar?: () => void };

const linkCls = ({ isActive }: { isActive: boolean }) =>
  "vi-sidebar-link d-flex align-items-center" + (isActive ? " active" : "");

export default function Sidebar({ collapsed, onToggleSidebar }: Props) {
  const auth = getAuth();
  const isAuth = !!auth;
  const isAdmin = auth?.role === "admin";

  return (
    <aside className={`vi-sidebar ${collapsed ? "vi-sidebar--collapsed" : ""}`}>
      <div className="vi-sidebar__header">
        <span className="vi-sidebar__brand">VI</span>
        {onToggleSidebar && (
          <button
            type="button"
            className="vi-sidebar-toggle"
            aria-label={collapsed ? "Expandir menú" : "Contraer menú"}
            onClick={onToggleSidebar}
          >
            <i className={`ti ${collapsed ? "ti-angle-right" : "ti-angle-left"}`} />
          </button>
        )}
      </div>

      <ul className="vi-sidebar-menu list-unstyled mb-0">
        {/* Login solo cuando NO hay sesión */}
        {!isAuth && (
          <li className="vi-sidebar-item">
            <NavLink to="/" className={linkCls} title="Login" aria-label="Login">
              <i className="ti ti-login vi-sidebar-icon" />
              <span className="vi-sidebar-text">Login</span>
            </NavLink>
          </li>
        )}
        <li className="vi-sidebar-item">
          <NavLink to="/oi" className={linkCls} title="Formulario OI" aria-label="Formulario OI">
            <i className="ti ti-layout-grid2 vi-sidebar-icon" />
            <span className="vi-sidebar-text">Formulario OI</span>
          </NavLink>
        </li>
        {/* Listado OI (solo con sesión) */}
        {isAuth && (
          <li className="vi-sidebar-item">
            <NavLink to="/oi/list" className={linkCls} title="Listado OI" aria-label="Listado OI">
              <i className="ti ti-view-list-alt vi-sidebar-icon" />
              <span className="vi-sidebar-text">Listado OI</span>
            </NavLink>
          </li>
        )}
        {/* Cambio de contraseña para cualquier usuario autenticado */}
        {isAuth && (
          <li className="vi-sidebar-item">
            <NavLink to="/password" className={linkCls} title="Cambiar contraseña" aria-label="Cambiar contraseña">
              <i className="ti ti-key vi-sidebar-icon" />
              <span className="vi-sidebar-text">Cambiar contraseña</span>
            </NavLink>
          </li>
        )}
        {/* Gestión de Usuarios (Solo Admin) */}
        {isAdmin && (
          <li className="vi-sidebar-item">
            <NavLink to="/users" className={linkCls} title="Usuarios" aria-label="Usuarios">
              <i className="ti ti-user vi-sidebar-icon" />
              <span className="vi-sidebar-text">Usuarios</span>
            </NavLink>
          </li>
        )}
      </ul>
    </aside>
  );
}
