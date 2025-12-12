import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { getAuth } from "../api/auth";

type Props = { collapsed?: boolean; onToggleSidebar?: () => void };

const linkCls = ({ isActive }: { isActive: boolean }) =>
  "vi-sidebar-link d-flex align-items-center" + (isActive ? " active" : "");

type GroupKey =
  | "oi"
  | "oi_formato_ac"
  | "oi_consolidacion"
  | "oi_verificacion"
  | "usuarios"
  | "administrar";

const INDENT_STEP_REM = 0.9;

function indentStyle(depth: number, collapsed?: boolean) {
  if (collapsed || depth <= 0) return undefined;
  return { paddingLeft: `calc(0.75rem + ${depth * INDENT_STEP_REM}rem)` } as const;
}

function isPathIn(pathname: string, prefixes: string[]) {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function SidebarNavItem({
  to,
  icon,
  label,
  depth,
  collapsed,
}: {
  to: string;
  icon: string;
  label: string;
  depth: number;
  collapsed?: boolean;
}) {
  return (
    <li className="vi-sidebar-item">
      <NavLink
        to={to}
        className={linkCls}
        style={indentStyle(depth, collapsed)}
        title={label}
        aria-label={label}
      >
        <i className={`ti ${icon} vi-sidebar-icon`} />
        <span className="vi-sidebar-text vi-sidebar-label">{label}</span>
      </NavLink>
    </li>
  );
}

function SidebarDisabledItem({
  icon,
  label,
  depth,
  collapsed,
}: {
  icon: string;
  label: string;
  depth: number;
  collapsed?: boolean;
}) {
  return (
    <li className="vi-sidebar-item">
      <button
        type="button"
        className="vi-sidebar-link vi-sidebar-link--disabled d-flex align-items-center w-100 border-0 bg-transparent"
        style={indentStyle(depth, collapsed)}
        title={label}
        aria-label={label}
        aria-disabled="true"
        disabled
      >
        <i className={`ti ${icon} vi-sidebar-icon`} />
        <span className="vi-sidebar-text vi-sidebar-label">{label}</span>
      </button>
    </li>
  );
}

function SidebarGroup({
  groupKey,
  icon,
  label,
  depth,
  collapsed,
  open,
  active,
  onToggle,
  children,
}: {
  groupKey: GroupKey;
  icon: string;
  label: string;
  depth: number;
  collapsed?: boolean;
  open: boolean;
  active: boolean;
  onToggle: (key: GroupKey) => void;
  children: ReactNode;
}) {
  const controlsId = `sidebar-group-${groupKey}`;
  const caret = open ? "ti-angle-down" : "ti-angle-right";

  return (
    <li className="vi-sidebar-item">
      <button
        type="button"
        className={
          "vi-sidebar-link d-flex align-items-center w-100 border-0 bg-transparent" +
          (active ? " active" : "")
        }
        style={indentStyle(depth, collapsed)}
        onClick={() => {
          if (collapsed) return;
          onToggle(groupKey);
        }}
        aria-expanded={!collapsed && open}
        aria-controls={controlsId}
        title={label}
      >
        <i className={`ti ${icon} vi-sidebar-icon`} />
        <span className="vi-sidebar-text vi-sidebar-label flex-grow-1">{label}</span>
        <span className="vi-sidebar-text vi-sidebar-caret ms-auto">
          <i className={`ti ${caret}`} />
        </span>
      </button>

      {!collapsed && open && (
        <ul id={controlsId} className="list-unstyled mb-0">
          {children}
        </ul>
      )}
    </li>
  );
}

export default function Sidebar({ collapsed, onToggleSidebar }: Props) {
  const location = useLocation();
  const auth = getAuth();
  const isAuth = !!auth;
  const isAdmin = auth?.role === "admin";

  const [open, setOpen] = useState<Record<GroupKey, boolean>>({
    oi: true,
    oi_formato_ac: true,
    oi_consolidacion: false,
    oi_verificacion: true,
    usuarios: false,
    administrar: false,
  });

  const pathname = location.pathname;

  const activeGroups = useMemo(() => {
    return {
      oi: isPathIn(pathname, ["/oi"]),
      oi_formato_ac: isPathIn(pathname, ["/oi/tools"]),
      oi_consolidacion: isPathIn(pathname, ["/oi/tools/consolidacion"]),
      oi_verificacion: isPathIn(pathname, ["/oi", "/oi/list"]),
      usuarios: isPathIn(pathname, ["/users", "/password"]),
      administrar: isPathIn(pathname, ["/admin"]),
    } satisfies Record<GroupKey, boolean>;
  }, [pathname]);

  useEffect(() => {
    if (collapsed) return;
    setOpen((prev) => {
      const next = { ...prev };
      if (activeGroups.oi) next.oi = true;
      if (activeGroups.oi_formato_ac) {
        next.oi = true;
        next.oi_formato_ac = true;
      }
      if (activeGroups.oi_consolidacion) {
        next.oi = true;
        next.oi_formato_ac = true;
        next.oi_consolidacion = true;
      }
      if (activeGroups.oi_verificacion) {
        next.oi = true;
        next.oi_verificacion = true;
      }
      if (activeGroups.usuarios) next.usuarios = true;
      if (activeGroups.administrar) next.administrar = true;
      return next;
    });
  }, [activeGroups, collapsed]);

  function toggleGroup(key: GroupKey) {
    setOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  }

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
        {!isAuth && (
          <SidebarNavItem to="/" icon="ti-login" label="Login" depth={0} collapsed={collapsed} />
        )}

        <SidebarGroup
          groupKey="oi"
          icon="ti-panel"
          label="OI"
          depth={0}
          collapsed={collapsed}
          open={open.oi}
          active={activeGroups.oi}
          onToggle={toggleGroup}
        >
          <SidebarGroup
            groupKey="oi_formato_ac"
            icon="ti-folder"
            label="FORMATO A-C"
            depth={1}
            collapsed={collapsed}
            open={open.oi_formato_ac}
            active={activeGroups.oi_formato_ac}
            onToggle={toggleGroup}
          >
            {isAuth && (
              <SidebarNavItem
                to="/oi/tools/vima-to-lista"
                icon="ti-exchange-vertical"
                label="VIMA → LISTA"
                depth={2}
                collapsed={collapsed}
              />
            )}
            {isAuth && (
              <SidebarNavItem
                to="/oi/tools/actualizacion-base"
                icon="ti-reload"
                label="ACTUALIZACIÓN DE BASES"
                depth={2}
                collapsed={collapsed}
              />
            )}

            <SidebarGroup
              groupKey="oi_consolidacion"
              icon="ti-layers"
              label="CONSOLIDACIÓN DE BASES ORIGINALES"
              depth={2}
              collapsed={collapsed}
              open={open.oi_consolidacion}
              active={activeGroups.oi_consolidacion}
              onToggle={toggleGroup}
            >
              {isAuth && (
                <SidebarNavItem
                  to="/oi/tools/consolidacion/correlativo"
                  icon="ti-list"
                  label="CORRELATIVO"
                  depth={3}
                  collapsed={collapsed}
                />
              )}
              {isAuth && (
                <SidebarNavItem
                  to="/oi/tools/consolidacion/no-correlativo"
                  icon="ti-layout-list-thumb"
                  label="NO CORRELATIVO"
                  depth={3}
                  collapsed={collapsed}
                />
              )}
            </SidebarGroup>
          </SidebarGroup>

          <SidebarGroup
            groupKey="oi_verificacion"
            icon="ti-clipboard"
            label="VERIFICACIÓN INICIAL"
            depth={1}
            collapsed={collapsed}
            open={open.oi_verificacion}
            active={activeGroups.oi_verificacion}
            onToggle={toggleGroup}
          >
            <SidebarDisabledItem
              icon="ti-briefcase"
              label="ORDEN DE TRABAJO (FUTURO)"
              depth={2}
              collapsed={collapsed}
            />
            <SidebarNavItem
              to="/oi"
              icon="ti-layout-grid2"
              label="REGISTRO OI"
              depth={2}
              collapsed={collapsed}
            />
            {isAuth && (
              <SidebarNavItem
                to="/oi/list"
                icon="ti-view-list-alt"
                label="LISTADO OI"
                depth={2}
                collapsed={collapsed}
              />
            )}
          </SidebarGroup>
        </SidebarGroup>

        <SidebarDisabledItem icon="ti-package" label="LOGÍSTICA (FUTURO)" depth={0} collapsed={collapsed} />
        <SidebarDisabledItem icon="ti-bar-chart" label="SMART (FUTURO)" depth={0} collapsed={collapsed} />

        <SidebarGroup
          groupKey="usuarios"
          icon="ti-user"
          label="USUARIOS"
          depth={0}
          collapsed={collapsed}
          open={open.usuarios}
          active={activeGroups.usuarios}
          onToggle={toggleGroup}
        >
          {isAdmin && (
            <SidebarNavItem
              to="/users"
              icon="ti-user"
              label="GESTIÓN DE USUARIOS"
              depth={1}
              collapsed={collapsed}
            />
          )}
          {isAuth && (
            <SidebarNavItem
              to="/password"
              icon="ti-key"
              label="CAMBIAR CONTRASEÑA"
              depth={1}
              collapsed={collapsed}
            />
          )}
        </SidebarGroup>

        {isAdmin && (
          <SidebarGroup
            groupKey="administrar"
            icon="ti-settings"
            label="ADMINISTRAR"
            depth={0}
            collapsed={collapsed}
            open={open.administrar}
            active={activeGroups.administrar}
            onToggle={toggleGroup}
          >
            <SidebarNavItem
              to="/admin/permisos"
              icon="ti-lock"
              label="PERMISOS"
              depth={1}
              collapsed={collapsed}
            />
          </SidebarGroup>
        )}
      </ul>
    </aside>
  );
}
