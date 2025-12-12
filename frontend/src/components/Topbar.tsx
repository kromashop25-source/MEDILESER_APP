import { NavLink, Link } from "react-router-dom";
import { getAuth, logout } from "../api/auth";

type Props = {
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
};

export default function Topbar({ sidebarCollapsed, onToggleSidebar }: Props) {
  const auth = getAuth();
  const displayUser = (auth as any)?.user ?? (auth as any)?.username ?? "";

  const handleLogout = () => {
    logout();
    // Recarga total para limpiar estado (auth, react-query, banner)
    location.assign("/");
  };

  return (
    <header className="navbar navbar-expand bg-white border-bottom sticky-top vi-topbar px-3">
      {onToggleSidebar && (
        <button
          type="button"
          className="btn btn-link text-secondary me-2 vi-sidebar-toggle"
          aria-label={sidebarCollapsed ? "Expandir menú" : "Contraer menú"}
          onClick={onToggleSidebar}
        >
          <i className={`ti ${sidebarCollapsed ? "ti-menu-alt" : "ti-menu"}`} />
        </button>
      )}

      <Link to={auth ? "/oi" : "/"} className="navbar-brand fw-semibold">VI</Link>

      <ul className="navbar-nav me-auto">
        {!auth && (
          <li className="nav-item">
            <NavLink className="nav-link" to="/">Login</NavLink>
          </li>
        )}
        <li className="nav-item"><NavLink className="nav-link" to="/oi">Formulario OI</NavLink></li>
        <li className="nav-item"><NavLink className="nav-link" to="/oi/list">Listado OI</NavLink></li>
      </ul>

      <div className="d-flex align-items-center gap-3">
        {auth && (
          <span className="text-muted small text-truncate" style={{ maxWidth: "360px" }}>
            Usuario: <strong>{displayUser || "?"}</strong> · Banco {auth.bancoId} · Técnico {auth.techNumber}
          </span>
        )}
        {auth && (
          <button className="btn btn-sm btn-outline-secondary" onClick={handleLogout}>
            CERRAR SESIÓN
          </button>
        )}
      </div>
    </header>
  );
}
