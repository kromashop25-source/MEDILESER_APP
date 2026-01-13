import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { NavLink, matchPath, useLocation } from "react-router-dom";
import { getAuth, isSuperuser, normalizeRole } from "../api/auth";

type Props = { collapsed?: boolean; onToggleSidebar?: () => void };

const linkCls = ({ isActive }: { isActive: boolean }) =>
  "vi-sidebar-link d-flex align-items-center" + (isActive ? " active" : "");

type GroupKey =
  | "oi"
  | "oi_formato_ac"
  | "oi_consolidacion"
  | "oi_verificacion"
  | "logistica"
  | "usuarios"
  | "administrar";

const INDENT_STEP_REM = 0.9;

function indentStyle(depth: number, collapsed?: boolean) {
  if (collapsed || depth <= 0) return undefined;
  return { paddingLeft: `calc(0.75rem + ${depth * INDENT_STEP_REM}rem)` } as const;
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
        end
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
  const role = normalizeRole(auth?.role, auth?.username);
  const superuser = isSuperuser(auth);
  const canManageUsers = role === "admin" || role === "administrator";
  const allowedModules = auth?.allowedModules;

  const isAllowed = (moduleId: string) =>
    superuser || !Array.isArray(allowedModules) || allowedModules.includes(moduleId);

  const canVimaToLista = isAuth && isAllowed("tools_vima_lista");
  const canActualizacionBases = isAuth && isAllowed("tools_actualizacion_bases");
  const canConsolCorrelativo = isAuth && isAllowed("tools_consol_correlativo");
  const canConsolNoCorrelativo = isAuth && isAllowed("tools_consol_no_correlativo");
  const canRegistroOi = isAuth && isAllowed("oi_formulario");
  const canListadoOi = isAuth && isAllowed("oi_listado");
  const canUsersAdmin = isAuth && canManageUsers && isAllowed("users_admin");
  const canFutureOt = isAuth && isAllowed("future_ot");
  const canLogistica = isAuth && isAllowed("logistica");
  const canFutureSmart = isAuth && isAllowed("future_smart");

  const showConsolidacionGroup = canConsolCorrelativo || canConsolNoCorrelativo;
  const showFormatoAcGroup = canVimaToLista || canActualizacionBases;
  const showVerificacionGroup = canRegistroOi || canListadoOi || canFutureOt;
  const showOiGroup = showFormatoAcGroup || showVerificacionGroup || showConsolidacionGroup;

  const DEFAULT_OPEN: Record<GroupKey, boolean> = useMemo(
    () => ({
      oi: true,
      oi_formato_ac: true,
      oi_consolidacion: true,
      oi_verificacion: true,
      logistica: true,
      usuarios: false,
      administrar: false,
    }),
    []
  );

  const [open, setOpen] = useState<Record<GroupKey, boolean>>(() => {
    const raw =
      localStorage.getItem("medileser.sidebar.openGroups") ??
      localStorage.getItem("vi.sidebar.openGroups");
    if (!raw) return DEFAULT_OPEN;
    try {
      const parsed = JSON.parse(raw) as Partial<Record<GroupKey, unknown>>;
      const next: Record<GroupKey, boolean> = { ...DEFAULT_OPEN };
      (Object.keys(next) as GroupKey[]).forEach((k) => {
        if (typeof parsed[k] === "boolean") next[k] = parsed[k] as boolean;
      });
      return next;
    } catch {
      return DEFAULT_OPEN;
    }
  });

  const pathname = location.pathname;

  useEffect(() => {
    localStorage.setItem("medileser.sidebar.openGroups", JSON.stringify(open));
  }, [open]);

  const activeLeaves = useMemo(() => {
    const exact = (path: string) => !!matchPath({ path, end: true }, pathname);

    return {
      vimaToLista: exact("/oi/tools/vima-to-lista"),
      actualizacionBases: exact("/oi/tools/actualizacion-base"),
      consolidacionCorrelativo: exact("/oi/tools/consolidacion/correlativo"),
      consolidacionNoCorrelativo: exact("/oi/tools/consolidacion/no-correlativo"),
      registroOi: exact("/oi"),
      listadoOi: exact("/oi/list"),
      users: exact("/users"),
      password: exact("/password"),
      permisos: exact("/admin/permisos"),
      log01Excel: exact("/logistica/log01/excel"),
      log01History: exact("/logistica/log01/history"),
    };
  }, [pathname]);

  const activeGroups = useMemo(
    () =>
      ({
        oi_consolidacion:
          activeLeaves.consolidacionCorrelativo || activeLeaves.consolidacionNoCorrelativo,
        oi_formato_ac:
          activeLeaves.vimaToLista ||
          activeLeaves.actualizacionBases,
        oi_verificacion: activeLeaves.registroOi || activeLeaves.listadoOi,
        oi:
          activeLeaves.vimaToLista ||
          activeLeaves.actualizacionBases ||
          activeLeaves.consolidacionCorrelativo ||
          activeLeaves.consolidacionNoCorrelativo ||
          activeLeaves.registroOi ||
          activeLeaves.listadoOi,
        usuarios: activeLeaves.users || activeLeaves.password,
        logistica: activeLeaves.log01Excel || activeLeaves.log01History,
        administrar: activeLeaves.permisos,
      }) satisfies Record<GroupKey, boolean>,
    [activeLeaves]
  );

  function toggleGroup(key: GroupKey) {
    setOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <aside className={`vi-sidebar ${collapsed ? "vi-sidebar--collapsed" : ""}`}>
      <div className="vi-sidebar__header">
        <div className="vi-sidebar__brand">
          <img
            className="vi-brand-logo"
            src="/medileser/logo-vertical.jpg"
            alt="Medileser"
            draggable={false}
          />
          <span className="vi-brand-text">MEDILESER APP</span>
        </div>
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
          <SidebarNavItem to="/login" icon="ti-login" label="Login" depth={0} collapsed={collapsed} />
        )}

        {showOiGroup && (
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
          {showFormatoAcGroup && (
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
            {canVimaToLista && (
              <SidebarNavItem
                to="/oi/tools/vima-to-lista"
                icon="ti-exchange-vertical"
                label="VIMA → LISTA"
                depth={2}
                collapsed={collapsed}
              />
            )}
            {canActualizacionBases && (
              <SidebarNavItem
                to="/oi/tools/actualizacion-base"
                icon="ti-reload"
                label="ACTUALIZACIÓN DE BASES"
                depth={2}
                collapsed={collapsed}
              />
            )}

          </SidebarGroup>
          )}
          {showConsolidacionGroup && (
          <SidebarGroup
            groupKey="oi_consolidacion"
            icon="ti-layers"
            label="CONSOLIDACIÓN DE BASES ORIGINALES"
            depth={1}
            collapsed={collapsed}
            open={open.oi_consolidacion}
            active={activeGroups.oi_consolidacion}
            onToggle={toggleGroup}
          >
            {canConsolCorrelativo && (
              <SidebarNavItem
                to="/oi/tools/consolidacion/correlativo"
                icon="ti-list"
                label="CORRELATIVO"
                depth={3}
                collapsed={collapsed}
              />
            )}
            {canConsolNoCorrelativo && (
              <SidebarNavItem
                to="/oi/tools/consolidacion/no-correlativo"
                icon="ti-layout-list-thumb"
                label="NO CORRELATIVO"
                depth={3}
                collapsed={collapsed}
              />
            )}
          </SidebarGroup>
          )}

          {showVerificacionGroup && (
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
            {canFutureOt && (
              <SidebarDisabledItem
                icon="ti-briefcase"
                label="ORDEN DE TRABAJO (FUTURO)"
                depth={2}
                collapsed={collapsed}
              />
            )}
            {canRegistroOi && (
              <SidebarNavItem
                to="/oi"
                icon="ti-layout-grid2"
                label="REGISTRO OI"
                depth={2}
                collapsed={collapsed}
              />
            )}
            {canListadoOi && (
              <SidebarNavItem
                to="/oi/list"
                icon="ti-view-list-alt"
                label="LISTADO OI"
                depth={2}
                collapsed={collapsed}
              />
            )}
          </SidebarGroup>
          )}
        </SidebarGroup>
        )}

        {canLogistica && (
          <SidebarGroup
            groupKey="logistica"
            icon="ti-package"
            label="LOGÍSTICA"
            depth={0}
            collapsed={collapsed}
            open={open.logistica}
            active={activeGroups.logistica}
            onToggle={toggleGroup}
          >
            <SidebarNavItem
              to="/logistica/log01/excel"
              icon="ti-files"
              label="Consolidación Excel"
              depth={1}
              collapsed={collapsed}
            />
            <SidebarNavItem
              to="/logistica/log01/history"
              icon="ti-view-list-alt"
              label="Historial de consolidaciones"
              depth={1}
              collapsed={collapsed}
            />
          </SidebarGroup>
        )}

        {canFutureSmart && (
          <SidebarDisabledItem icon="ti-bar-chart" label="SMART (FUTURO)" depth={0} collapsed={collapsed} />
        )}

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
          {canUsersAdmin && (
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

        {superuser && (
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
