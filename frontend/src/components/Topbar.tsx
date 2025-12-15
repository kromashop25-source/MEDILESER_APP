import { useEffect, useState } from "react";
import {
  getAuth,
  getSelectedBank,
  isTechnicianRole,
  logout,
  subscribeSelectedBank,
} from "../api/auth";

type Props = {
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
};

export default function Topbar({ sidebarCollapsed, onToggleSidebar }: Props) {
  const auth = getAuth();
  const username = auth?.username ?? auth?.user ?? "";
  const isTech = auth ? isTechnicianRole(auth.role) : false;

  const [selectedBank, setSelectedBank] = useState<number | null>(() => getSelectedBank());
  useEffect(() => subscribeSelectedBank(() => setSelectedBank(getSelectedBank())), []);

  const bankLabel = selectedBank && selectedBank > 0 ? `Banco ${selectedBank}` : "Banco sin seleccionar";

  const handleLogout = () => {
    logout();
    location.assign("/login");
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

      <div className="me-auto" />

      <div className="d-flex align-items-center gap-3">
        {auth && (
          <span className="text-muted small text-truncate" style={{ maxWidth: "360px" }}>
            Usuario: <strong>{username || "?"}</strong>
            {isTech && (
              <>
                {" · "}
                {bankLabel}
                {auth.techNumber ? (
                  <>
                    {" · "}Técnico {auth.techNumber}
                  </>
                ) : null}
              </>
            )}
          </span>
        )}

        {auth && (
          <button className="btn btn-sm btn-outline-secondary" onClick={handleLogout}>
            Cerrar sesión
          </button>
        )}
      </div>
    </header>
  );
}
