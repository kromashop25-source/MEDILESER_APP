import { Outlet } from "react-router-dom";
import { useState } from "react";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";

export default function AdminatorLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const toggleSidebar = () => setCollapsed((prev) => !prev);

  return (
    <div className={`vi-layout ${collapsed ? "vi-layout--collapsed" : ""}`}>
      <Sidebar collapsed={collapsed} onToggleSidebar={toggleSidebar} />

      <div className="vi-main">
        <Topbar
          sidebarCollapsed={collapsed}
          onToggleSidebar={toggleSidebar}
        />
        <main className="vi-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
