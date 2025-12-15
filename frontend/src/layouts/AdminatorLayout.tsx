import { Outlet, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";

export default function AdminatorLayout() {
  const location = useLocation();
  const isHome = location.pathname === "/";

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("vi.sidebar.collapsed") === "true";
    } catch {
      return false;
    }
  });
  const toggleSidebar = () => setCollapsed((prev) => !prev);

  useEffect(() => {
    try {
      localStorage.setItem("vi.sidebar.collapsed", String(collapsed));
    } catch {
      // ignore
    }
  }, [collapsed]);

  return (
    <div className={`vi-layout ${collapsed ? "vi-layout--collapsed" : ""}`}>
      <Sidebar collapsed={collapsed} onToggleSidebar={toggleSidebar} />

      <div className="vi-main">
        <Topbar
          sidebarCollapsed={collapsed}
          onToggleSidebar={toggleSidebar}
        />
        <main className={`vi-content${isHome ? " vi-content--home" : ""}`}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
