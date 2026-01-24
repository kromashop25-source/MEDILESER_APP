import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import type { AxiosError } from "axios";
import {
  log02ValidarRutasUnc,
  type Log02ValidarRutasUncResponse,
  log02ExplorerRoots,
  log02ExplorerListar,
  type Log02ExplorerListItem,
  log01HistoryList,
  type Log01HistoryListItem,
  log02CopyConformesStart,
  subscribeLog02CopyConformesProgress,
  pollLog02CopyConformesProgress,
  log02CopyConformesCancel,
} from "../../api/oiTools";
import { translateProgressStage  } from "../oi_tools/progressTranslations";

function badge(ok?: boolean | null) {
  if (ok === true) return "badge bg-success";
  if (ok === false) return "badge bg-danger";
  return "badge bg-secondary";
}

type ExplorerMode = "origen" | "destino";

// Wizard UI
type WizardStep = 1 | 2 | 3;
const MAX_LIVE_EVENTS = 250;

const LS_KEY = "medileser_log02_rutas_v1";
const PERU_TZ = "America/Lima";
const DEBUG_PROGRESS =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("debugProgress") === "1";
const DEBUG_PROGRESS_PREFIX = "[log02-copy-progress]";
const STREAM_SILENCE_MS = 2000;
const POLL_INTERVAL_MS = 500;

function debugProgress(...args: any[]) {
  if (!DEBUG_PROGRESS) return;
  console.log(DEBUG_PROGRESS_PREFIX, ...args);
}

function formatDateTime(value?: string | null): string {
  if (!value) return "N/D";
  const hasTz =
    /[zZ]$/.test(value) || /[+-]\d{2}:\d{2}$/.test(value) || /[+-]\d{4}$/.test(value);
  const safe = hasTz ? value : `${value}Z`;
  const d = new Date(safe);
  if (Number.isNaN(d.getTime())) return String(value);

  const fmt = new Intl.DateTimeFormat("es-PE", {
    timeZone: PERU_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}

function isAbortLikeError(err: unknown): boolean {
  const e = err as any;
  const name = String(e?.name || "");
  const msg = String(e?.message || e || "");
  return name === "AbortError" || /aborted/i.test(msg) || /abort/i.test(msg);
}

function isTypingElement(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  // contenteditable (por si en tu UI existe alguno)
  if ((el as any).isContentEditable) return true;
  return false;
}

async function copyTextSafe(txt?: string | null) {
   const value = (txt || "").trim();
   if (!value) return;
   try {
     await navigator.clipboard.writeText(value);
     return;
   } catch {
     // fallback simple
     const ta = document.createElement("textarea");
     ta.value = value;
     document.body.appendChild(ta);
     ta.select();
     document.execCommand("copy");
     document.body.removeChild(ta);
   }
 }

export default function Log02PdfPage() {

  const [rutasOrigen, setRutasOrigen] = useState<string[]>([""]);
  const [rutaDestino, setRutaDestino] = useState<string>("");
  const [validando, setValidando] = useState<boolean>(false);
  const [error, setError ] = useState<string>("");
  const [resultado, setResultado] = useState<Log02ValidarRutasUncResponse | null>(null);
  const [touched, setTouched] = useState<boolean>(false);

  // ====================================
  // Selección de corrida LOG-01 (run_id)
  // ====================================
  const [runModalOpen, setRunModalOpen] = useState<boolean>(false);
  const [runsLoading, setRunsLoading] = useState<boolean>(false);
  const [runsError, setRunsError] = useState<string>("");
  const [runs, setRuns] = useState<Log01HistoryListItem[]>([]);
  const [runSelected, setRunSelected] = useState<Log01HistoryListItem | null>(null);

  // filtros opcionales del modal
  const [runQ, setRunQ] = useState<string>("");
  const [runDateFrom, setRunDateFrom] = useState<string>("");
  const [runDateTo, setRunDateTo] = useState<string>("");
  const [runSource, setRunSource] = useState<string>("");
  const [runStatus, setRunStatus] = useState<string>("COMPLETADO"); // exitosas por defecto

  // ====================
  // Copiado (PB-LOG-015)
  // ====================
  const [copying, setCopying] = useState<boolean>(false);
  const [copyOperationId, setCopyOperationId] = useState<string>("");
  const [copyProgress, setCopyProgress] = useState<number>(0);
  const [copyStage, setCopyStage] = useState<string>("");
  const [copyMessage, setCopyMessage] = useState<string>("");
  const [copyOi, setCopyOi] = useState<string>("");
  const [copyWarnings, setCopyWarnings] = useState<Array<{ oi: string; code?: string; message: string }>>([]);
  const [copyErrors, setCopyErrors] = useState<Array<{ oi?: string; file?: string; message: string }>>([]);
  const [copyAudit, setCopyAudit] = useState<any | null>(null);

  const copyAbortRef = useRef<AbortController | null>(null);
  const copyCancelRef = useRef<boolean>(false);
  const copyCompletedRef = useRef<boolean>(false);
  const pollTimerRef = useRef<number | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const pollInFlightRef = useRef<boolean>(false);
  const pollingActiveRef = useRef<boolean>(false);
  const pollCursorRef = useRef<number>(-1);
  const lastCursorRef = useRef<number>(-1);
  const pollOperationIdRef = useRef<string>("");
  const streamWatchdogRef = useRef<number | null>(null);
  const streamActiveRef = useRef<boolean>(false);
  const streamOperationIdRef = useRef<string>("");
  const lastStreamEventAtRef = useRef<number>(0);
  const mountedRef = useRef<boolean>(true);
  const activeOperationIdRef = useRef<string>("");



  // Explorador (modal inline)
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [explorerMode, setExplorerMode] = useState<ExplorerMode>("origen");
  // Si es null => "Agregar origen" (no edita fila existente)
  const [originEditIndex, setOriginEditIndex] = useState<number | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [rootSel, setRootSel] = useState<string>("");
  const [currentPath, setCurrentPath] = useState<string>("");
  const [folders, setFolders] = useState<Log02ExplorerListItem[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [explorerError, setExplorerError] = useState<string>("");
  const [selectedFolderPath, setSelectedFolderPath] = useState<string>("");
  const [folderQuery, setFolderQuery] = useState<string>("");
  const [gotoPath, setGotoPath] = useState<string>("");

  // WIZARD UI
  const [wizardStep, setWizardStep] = useState<WizardStep>(1);
  const [liveOpen, setLiveOpen] = useState<boolean>(false);
  const [liveEvents, setLiveEvents] = useState<
  Array<{
    ts: number;
    source: "stream" | "poll";
    type: string;
    stage?: string;
    message?: string;
    oi?: string;
    progress?: number;
  }>
  >([]);

  const filteredFolders = useMemo(() => {
    const q = folderQuery.trim().toLocaleLowerCase();
    if (!q) return folders;
    return folders.filter((f) => (f.name || "").toLocaleLowerCase().includes(q));
  }, [folders, folderQuery]);

  // Mantener selección consistente al filtrar/cambiar carpeta
  useEffect(() => {
    if (!explorerOpen) return;
    if (!filteredFolders.length) {
      if (selectedFolderPath) setSelectedFolderPath("");
      return;
    }
    const exists = selectedFolderPath && filteredFolders.some((f) => f.path === selectedFolderPath);
    if (!exists) setSelectedFolderPath(filteredFolders[0].path);
  }, [explorerOpen, filteredFolders, selectedFolderPath]);


  // Cargar configuración previa (calidad de vida)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { origenes?: string[]; destino?: string; run_id?: number };
      const origenes = Array.isArray(parsed.origenes) ? parsed.origenes : [];
      const destino = typeof parsed?.destino === "string" ? parsed.destino : "";
      const runId = typeof parsed?.run_id === "number" ? parsed.run_id : null;
      if (origenes.length) setRutasOrigen(origenes);
      if (destino) setRutaDestino(destino);
      if (runId !== null) {
        // placeholder mínimo; se reemplaza cuando carguemos lista
        setRunSelected({ id: runId} as any)
      }
    } catch {
      // ignorar
    }

  }, []);

  // Persistir configuración
  useEffect(() => {
    try {
      const payload = {
        origenes: rutasOrigen,
        destino: rutaDestino,
        run_id: runSelected?.id ?? null,
      };
      localStorage.setItem(LS_KEY, JSON.stringify(payload));
    } catch {
      // ignorar
  }
}, [rutasOrigen, rutaDestino, runSelected?.id]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeOperationIdRef.current = "";
      stopPolling("unmount");
      stopStream("unmount");
    };
  }, []);

function limpiarConfiguracion() {
  setRutasOrigen([""]);
  setRutaDestino("");
  setResultado(null);
  setError("");
  setTouched(false);
  setRunSelected(null);
  setCopyAudit(null);
  setCopyWarnings([]);
  setCopyErrors([]);
  setCopyMessage("");
  setCopyStage("");
  setCopyProgress(0);
  setCopyOi("");
  setCopyOperationId("");
  setWizardStep(1);
  setLiveEvents([]);
  setLiveOpen(false);
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    // ignorar
  }
}


function quitarDuplicadosUI() {
  setRutasOrigen((prev) => {
    const seen = new Set<string>();
    const next: string[] = [];
    for (const raw of prev) {
      const v = (raw || "").trim();
      if (!v) continue;
      const k = v.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      next.push(v);
    }
    return next.length ? next : [""];
  });
}

function abrirAgregarOrigen() {
  // NO agrega fila aquí. La fila se agrega recién cuando el usuario selecciona una carpeta.
  setTouched(true);
  setOriginEditIndex(null);
  void openExplorer("origen");
}

function abrirEditarOrigen(i: number) {
  setTouched(true);
  setOriginEditIndex(i);
  void openExplorer("origen");
}

function abrirDestino() {
  setTouched(true);
  setOriginEditIndex(null);
  void openExplorer("destino");
}

// =========================
// Modal de corridas LOG-01
// =========================
async function cargarUltimasCorridasExitosas(limit = 5) {
  setRunsError("");
  setRunsLoading(true);
  try {
    const data = await log01HistoryList({
      limit,
      offset: 0,
      include_deleted: false,
      status: "COMPLETADO",
    });
    const items = Array.isArray(data?.items) ? data.items : [];
    setRuns(items);
    if (!runSelected?.id && items.length) {
      setRunSelected(items[0]);
    } else if (runSelected?.id && items.length) {
      const match = items.find((x) => x.id === runSelected.id);
      if (match) setRunSelected(match);
    }
  } catch (e) {
    const ax = e as AxiosError<any>;
    const detail =
      (ax.response?.data?.detail as string) ||
      ax.message ||
      "No se pudo cargar las corridas.";
    setRunsError(detail);
    setRuns([]);
  } finally {
    setRunsLoading(false);
  }
}

async function buscarCorridasConFiltros() {
  setRunsError("");
  setRunsLoading(true);
  try {
    const data = await log01HistoryList({
      limit: 20,
      offset: 0,
      include_deleted: false,
      q: runQ.trim() || undefined,
      dateFrom: runDateFrom.trim() || undefined,
      dateTo: runDateTo.trim() || undefined,
      source: runSource.trim() || undefined,
      status: runStatus.trim() || undefined,
    });
    const items = Array.isArray(data?.items) ? data.items : [];
    setRuns(items);
  } catch (e)  {
    const ax = e as AxiosError<any>;
    const detail =
      (ax.response?.data?.detail as string) ||
      ax.message ||
      "No se pudo cargar las corridas.";
    setRunsError(detail);
    setRuns([]);
  } finally {
    setRunsLoading(false);
  }
}

function abrirModalCorridas() {
  setRunModalOpen(true);
  void cargarUltimasCorridasExitosas(5);
}

function seleccionarCorrida(it: Log01HistoryListItem) {
  setRunSelected(it);
  setRunModalOpen(false);
  // Wizard: avanzar al paso 3 cuando ya hay corrida
  setWizardStep((prev) => (prev < 3 ? 3 : prev));
}


  const origenesLimpios = useMemo(
    () => rutasOrigen.map((x) => (x ?? "").trim()),
    [rutasOrigen]
  );

  const origenesNoVacios = useMemo(
    () => origenesLimpios.filter((x) => x),
    [origenesLimpios]
  );

  const destinoLimpio = useMemo(
    () => (rutaDestino ?? "").trim(),
    [rutaDestino]
  );

  const listoParaValidar = useMemo(() => {
    return origenesNoVacios.length > 0 && !!destinoLimpio;
  }, [origenesNoVacios.length, destinoLimpio]);

  function setOrigenAt(i: number, value: string) {
    setRutasOrigen((prev) => {
      const next = prev.slice();
      next[i]  = value;
      return next;
    });
  }


  function removeOrigen(i: number) {
    setRutasOrigen((prev) => {
      if (prev.length <= 1) {
        // mantener al menos 1 input: limpiar
        return [""];
      }
      const next = prev.slice();
      next.splice(i, 1);
      return next;
    });
  }

  // Teclas rápidas del explorador (modal)
  // - ESC: cerrar
  // - ↑/↓: mover selección
  // - Enter: entrar a la carpeta seleccionada
  useEffect(() => {
    if (!explorerOpen) return;
    
    function focusRowByIndex(i: number) {
      try {
        const el = document.querySelector(`[data-folder-idx="${i}"]`) as HTMLElement | null;
        if (el) {
          el.focus();
          // evitar saltos bruscos; solo alinear si está fuera de vista
          el.scrollIntoView({ block: "nearest" });
        }
      } catch {
        // ignorar
      }
    }

    const onKey = (e: KeyboardEvent) => {
      // ESC siempre debe funcionar, incluso si el foco está en un input
      if (e.key === "Escape") {
        e.preventDefault();
        setExplorerOpen(false);
        return;
      }

      // No interferir con inputs (búsqueda / goto / etc.)
      if (isTypingElement(e.target)) return;

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!filteredFolders.length) return;
        e.preventDefault();

        const curIdx = filteredFolders.findIndex((f) => f.path === selectedFolderPath);
        const baseIdx = curIdx >= 0 ? curIdx : 0;
        const nextIdx =
          e.key === "ArrowDown"
            ? Math.min(filteredFolders.length - 1, baseIdx + 1)
            : Math.max(0, baseIdx - 1);

        const next = filteredFolders[nextIdx];
        if (!next) return;

        setSelectedFolderPath(next.path);
        requestAnimationFrame(() => focusRowByIndex(nextIdx));
        return;
      }

      if (e.key === "Enter") {
        if (!selectedFolderPath) return;
        const found = filteredFolders.find((f) => f.path === selectedFolderPath);
        if (!found) return;
        e.preventDefault();
        void loadFolders(found.path);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [explorerOpen, selectedFolderPath, loadingFolders]);

  async function openExplorer(mode:ExplorerMode) {
    setExplorerMode(mode);
    setExplorerError("");
    setExplorerOpen(true);
    setFolderQuery("");
    try {
      const res = await log02ExplorerRoots();
      const rs = res.roots || [];
      setRoots(rs);
      const first = rs[0] || "";
      setRootSel(first);
      setCurrentPath(first);
      setGotoPath(first);
      if (first) {
        await loadFolders(first);
      } else {
        setFolders([]);
        setExplorerError("No hay rutas raíz configuradas para el explorador. Configure VI_LOG02_UNC_ROOTS en el servidor.");
      }
    } catch (e) {
      const ax = e as AxiosError<any>;
      const detail = 
      (ax.response?.data?.detail as string) ||
      ax.message ||
      "No se pudo cargar las rutas raíz.";
      setExplorerError(detail);
      setFolders([]);
    }
  }

  async function loadFolders(path: string) {
    setExplorerError("");
    if (!path) {
      setFolders([]);
      return;
    }
    try {
      setLoadingFolders(true);
      setSelectedFolderPath("")
      const res = await log02ExplorerListar(path);
      setCurrentPath(res.path);
      setGotoPath(res.path);
      const nextFolders = res.folders || [];
      setFolders(nextFolders);
      setSelectedFolderPath(nextFolders[0]?.path || "");
    } catch (e) {
      const ax = e as AxiosError<any>;
      const detail =
      (ax.response?.data?.detail as string) ||
      ax.message ||
      "No se pudo listar la carpeta.";
      setExplorerError(detail);
      setFolders([]);
    } finally {
      setLoadingFolders(false);
    }
  }

  function buildBreadcrumbs(pathRaw: string) {
    const p = (pathRaw || "").replace(/[\\\/]+$/, "");
    const isUnc = p.startsWith("\\\\");
    const segs = p.split("\\").filter((s) => s.length > 0);
    if (segs.length === 0) return [];

    const crumbs: Array<{ label: string; path: string}> = [];
    if (isUnc) {
      // \\server\share\...
      const server = segs[0] || "";
      const share = segs[1] || "";
      if (server) {
        const base = `\\\\${server}`;
        crumbs.push({ label: `\\\\${server}`, path: base});
      }
      if (server && share) {
        let acc = `\\\\${server}\\${share}`;
        crumbs.push({ label: share, path: acc });
        // resto de segmentos: \\server\share\...
        for (let i = 2; i < segs.length; i++) {
          acc = `${acc}\\${segs[i]}`;
          crumbs.push({ label: segs[i], path: acc });
        }
      }
      return crumbs;
    }

    // Drive path: D:\...
    let acc = segs[0];
    crumbs.push({ label: segs[0], path: segs[0]});
    for (let i = 1; i < segs.length; i++) {
      acc = `${acc}\\${segs[i]}`;
      crumbs.push({ label: segs[i], path: acc });
    }
    return crumbs;
  }

  async function onGoToPath() {
    const p = (gotoPath || "").trim();
    if (!p) return;
    await loadFolders(p);
  }

  async function copyCurrentPath() {
    const txt = (currentPath || "").trim();
    if (!txt) return;
    await copyTextSafe(txt);
  }

  function upOneLevel() {
    // Subir un nivel: recortamos por separador de Windows "\".
    // Mantener dentro de la raíz: el backend bloqueará si sale del allowlist.
    const p = (currentPath || "").replace(/[\\\/]+$/, "");
    const idx = p.lastIndexOf("\\");
    if (idx <= 0) return;
    const parent = p.slice(0, idx);
    void loadFolders(parent);
  }

  /**
   * Selecciona una carpeta para destino/origen y cierra el modal.
   * Si se pasa `pathOverride`, se usa ese path; si no, se usa `currentPath`.
   *
   * UX esperada:
   * - Click en fila: resalta (selectedFolderPath)
   * - Enter/Doble click: entra
   * - Botón "Seleccionar": usa carpeta resaltada si existe; si no, la actual.
   */
  function selectCurrentFolder(pathOverride?: string) {
    const picked = (pathOverride ?? currentPath ?? "").trim();
    if (!picked) return;

    if (explorerMode === "destino") {
      setRutaDestino(picked);
    } else {
      setRutasOrigen((prev) => {
        const clean = picked.trim();
        if (!clean) return prev;

        const next = prev.slice();

        // Editar fila existente
        if (originEditIndex !== null && originEditIndex >= 0 && originEditIndex < next.length) {
          next[originEditIndex] = clean;
          return next;
        }

        // Agregar nuevo origen SOLO al seleccionar
        const exists = next
          .map((x) => (x || "").trim().toLowerCase())
          .includes(clean.toLowerCase());
        if (exists) return next;

        // si la primera fila está vacía, la reemplazamos
        if (next.length === 1 && !(next[0] || "").trim()) return [clean];

        return [...next, clean];
      });
    }

    setOriginEditIndex(null);
    setExplorerOpen(false);
  }

  function selectExplorerCurrentFolder() {
  // Regla nueva: el botón "Seleccionar carpeta" SIEMPRE elige la carpeta actual (currentPath).
  // Ignora la subcarpeta resaltada en la tabla para evitar el bug reportado.
  const candidate = (currentPath || "").trim();
  if (!candidate) return;
  selectCurrentFolder(candidate);
}


  async function validar() {
    setError("");
    setResultado(null);
    setTouched(true)
    const destinos = destinoLimpio;
    const origenes = origenesNoVacios
    
    if (!origenes.length) {
      setError("Debes ingresar al menos una ruta de origen.");
      return;
    }
    if (!destinos) {
      setError("Debes ingresar una ruta de destino.");
      return;
    }

    try {
      setValidando(true);
      const res = await log02ValidarRutasUnc({
        rutas_origen: origenes,
        ruta_destino: destinos,
      });
      setResultado(res);
      if (!res.ok) {
        setError("Validación incompleta: revisa los detalles de permisos y existencia.");
      } else {
        // Wizard: avanzar al paso 2 cuando las rutas quedan OK
        setWizardStep((prev) => (prev < 2 ? 2 : prev));
      }
    } catch (e) {
      const ax = e as AxiosError<any>;
      if (axios.isCancel(ax)) return;
      const detail =
      (ax.response?.data?.detail as string) ||
      ax.message ||
      "No se pudo validar las rutas.";
      setError(detail);
    } finally {
      setValidando(false);
    }

  }

  const puedeIniciarCopiado = useMemo(() => {
    return !!resultado?.ok && !!runSelected?.id && !copying;
  }, [resultado?.ok, runSelected?.id, copying]);

  // Wizard: auto-avance hacia adelante (sin forzar retroceso)
  useEffect(() => {
    setWizardStep((prev) => {
      if (copying) return 3;
      if (resultado?.ok && runSelected?.id && prev < 3) return 3;
      if (resultado?.ok && !runSelected?.id && prev < 2) return 2;
      return prev;
    });
  }, [resultado?.ok, runSelected?.id, copying]);

  function getEventCursor(ev: any): number | null {
    const raw = ev?.cursor;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string") {
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function shouldSkipEvent(cursor: number | null): boolean {
    if (cursor == null) return false;
    if (cursor <= lastCursorRef.current) return true;
    lastCursorRef.current = cursor;
    if (cursor > pollCursorRef.current) pollCursorRef.current = cursor;
    return false;
  }

  function aplicarProgreso(ev: any) {
    const raw = ev?.progress ?? ev?.percent;
    const pct = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (Number.isFinite(pct)) {
      const safe = Math.max(0, Math.min(100, pct));
      setCopyProgress((prev) => {
        if (DEBUG_PROGRESS && prev !== safe) {
          debugProgress("setCopyProgress", { prev, next: safe });
        }
        return safe;
      });
    }
  }

  function onCopyEvent(ev: any) {
    const type = String(ev?.type || "");
    aplicarProgreso(ev);

    if (type === "status" || type === "progress") {
      const stage = ev?.stage ? String(ev.stage) : type;
      if (stage) setCopyStage(stage);
      if (typeof ev?.message === "string" && ev.message) setCopyMessage(ev.message);
      if (stage) {
        const stageNorm = stage.toLowerCase();
        if (stageNorm === "cancelado" || stageNorm === "cancelled") {
          copyCancelRef.current = true;
          activeOperationIdRef.current = "";        
          setCopying(false);
          stopPolling("cancelled");
          stopStream("cancelled");
        }
      }
      return;
    }
    if (type === "oi") {
      if (typeof ev?.oi === "string") setCopyOi(ev.oi);
      return;
    }
    if (type === "oi_warn") {
      const oi = String(ev?.oi || "");
      const msg = String(ev?.message || "");
      const code = ev?.code ? String(ev.code) : undefined;
      if (oi && msg) setCopyWarnings((prev) => [... prev, { oi, code, message: msg}]);
      return;
    }
    if (type === "oi_error" || type === "file_error") {
      const oi = ev?.oi ? String(ev.oi) : undefined;
      const file = ev?.file ? String(ev.file) : undefined;
      const msg = String(ev?.message || "Error");
      setCopyErrors((prev) => [...prev, { oi, file, message: msg}]);
      return;
    }
    if (type === "error") {
      const msg = String(ev?.message || "Fallo en el proceso.");
      setCopyErrors((prev) => [...prev, { message: msg}]);
      setCopyMessage(msg);
      setCopyStage("error");
      setCopying(false);
      stopPolling("error_event");
      stopStream("error_event");
      return;
    }
    if (type === "complete") {
      copyCompletedRef.current = true;
      if (typeof ev?.message === "string") setCopyMessage(ev.message);
      setCopyStage("completado");
      setCopyProgress(100);
      setCopyAudit(ev?.audit ?? null);
      setCopying(false);
      stopPolling("complete");
      stopStream("complete");
      return;
    }
  }

  function handleCopyEvent(ev: any, source: "stream" | "poll" = "stream") {
    const cursor = getEventCursor(ev);
    const type = String(ev?.type || "");
    const stage = ev?.stage ? String(ev.stage) : "";
    if (DEBUG_PROGRESS) {
      debugProgress("event", {
        source,
        type,
        stage,
        progress: ev?.progress,
        percent: ev?.percent,
        cursor,
      });
    }
    const lastCursor = lastCursorRef.current;
    if (shouldSkipEvent(cursor)) {
      if (DEBUG_PROGRESS) {
        debugProgress("skip_event", { source, cursor, lastCursor });
      }
      return;
    }
    onCopyEvent(ev);

    // Live log (soporte): registrar eventos relevantes sin saturar memoria
    const shouldLog =
      type === "status" ||
      type === "progress" ||
      type === "oi" ||
      type === "oi_warn" ||
      type === "oi_error" ||
      type === "file_error" ||
      type === "error" ||
      type === "complete";
    if (shouldLog) {
      const msg = typeof ev?.message === "string" ? ev.message : undefined;
      const stg = typeof stage === "string" && stage ? stageLabel(stage) : undefined;
      const oi = typeof ev?.oi ===  "string" ? ev.oi : undefined;
      const raw = ev?.progress ?? ev?.percent;
      const pct = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
      const progress = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : undefined;
      setLiveEvents((prev) => {
        const next = [
          ...prev,
          { ts: Date.now(), source, type, stage: stg, message: msg, oi, progress},
        ];
        if (next.length > MAX_LIVE_EVENTS) {
          next.splice(0, next.length - MAX_LIVE_EVENTS);
        }
        return next;
      });
    }
  }

  function stopPolling(reason: string) {
    if (DEBUG_PROGRESS) {
      debugProgress("stop_polling", { reason, operationId: pollOperationIdRef.current});
    }
    if (!pollingActiveRef.current) return;
    pollingActiveRef.current = false;
    if (pollTimerRef.current != null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    try {
      pollAbortRef.current?.abort();
    } catch {}
    pollAbortRef.current = null;
    pollInFlightRef.current = false;
    pollOperationIdRef.current = "";
  }

  function clearStreamWatchdog() {
    if (streamWatchdogRef.current != null) {
      window.clearTimeout(streamWatchdogRef.current);
      streamWatchdogRef.current = null;
    }
  }

  function markStreamClosed(reason: string) {
    if (DEBUG_PROGRESS) {
      debugProgress("stream_closed", { reason, operationId: streamOperationIdRef.current});
    }
    streamActiveRef.current = false;
    streamOperationIdRef.current = "";
    clearStreamWatchdog();
  }

  function stopStream(reason: string) {
    if (DEBUG_PROGRESS) {
      debugProgress("stop_stream", { reason, operationId: streamOperationIdRef.current});
    }
    markStreamClosed(reason);
    try {
      copyAbortRef.current?.abort();
    } catch {}
    copyAbortRef.current = null;
  }

  function scheduleStreamWatchdog(operationId: string) {
    if (!streamActiveRef.current) return;
    clearStreamWatchdog();
    streamWatchdogRef.current = window.setTimeout(() => {
      if (!streamActiveRef.current) return;
      const idleMs = Date.now() - lastStreamEventAtRef.current;
      if (idleMs >= STREAM_SILENCE_MS) {
        debugProgress("stream_silent_fallback", { idleMs, operationId });
        stopStream("stream_silent");
        if (!copyCompletedRef.current && !copyCancelRef.current) {
          startPolling(operationId, "stream_silent");
        }
        return;
      }
      scheduleStreamWatchdog(operationId);
    }, STREAM_SILENCE_MS);
  }

  function noteStreamEvent(operationId: string) {
    lastStreamEventAtRef.current = Date.now();
    if (streamActiveRef.current) scheduleStreamWatchdog(operationId);
  }

  function schedulePoll(delayMs: number) {
    if (!pollingActiveRef.current) return;
    if (pollTimerRef.current != null) window.clearTimeout(pollTimerRef.current);
    pollTimerRef.current = window.setTimeout(() => {
      void pollOnce();
    }, delayMs);
  }

  async function pollOnce() {
    if (!pollingActiveRef.current || pollInFlightRef.current) return;
    const operationId = pollOperationIdRef.current;
    if (!operationId) {
      stopPolling("no_operation_id");
      return;
    }
    if (activeOperationIdRef.current !== operationId) {
      stopPolling("operation_mismatch");
      return;
    }
    pollInFlightRef.current = true;
    try {
      const res = await pollLog02CopyConformesProgress(
        operationId,
        pollCursorRef.current,
        pollAbortRef.current?.signal
      );
      pollCursorRef.current = res.cursor_next;
      for (const ev of res.events || []) {
        handleCopyEvent(ev, "poll");
      }
      if (res.done && (!res.events || res.events.length === 0)) {
        stopPolling("done");
        return;
      }
    } catch (err) {
      if (copyCancelRef.current || copyCompletedRef.current) return;
      const name = (err as any)?.name as string | undefined;
      if (name !== "AbortError") {
        const ax = err as AxiosError<any>;
        const detail =
          (ax.response?.data?.detail as string) ||
          ax.message ||
          "No se pudo leer el progreso.";
        setCopyErrors((prev) => [...prev, { message: detail }]);
        setCopyStage("error");
        setCopyMessage(detail);
        setCopying(false);
        stopPolling("poll_error");
      }
    } finally {
      pollInFlightRef.current = false;
      if (pollingActiveRef.current) schedulePoll(POLL_INTERVAL_MS);
    }
  }

  function startPolling(operationId: string, reason: string) {
    void reason;
    if (activeOperationIdRef.current !== operationId) return;
    if (pollingActiveRef.current) return;
    pollingActiveRef.current = true;
    pollOperationIdRef.current = operationId;
    pollAbortRef.current = new AbortController();
    // Asegurar cursor coherente si el stream alcanzó a emitir algo antes del fallback.
    pollCursorRef.current = Math.max(pollCursorRef.current, lastCursorRef.current);
    if (DEBUG_PROGRESS) {
      debugProgress("start_polling", { operationId, reason });
    }
    schedulePoll(0);
  }

  async function iniciarCopiado() {
    setError("");
    if (!resultado?.ok) {
      setError("Debes validar rutas correctamente antes de iniciar el copiado.");
      return;
    }
    if (!runSelected?.id) {
      setError("Debes seleccionar una corrida de LOG-01 (Historial) para usar su manifiesto.");
      return;
    }

    const origenes = origenesNoVacios;
    const destino = destinoLimpio;
    if (!origenes.length || !destino) {
      setError("Completa orígenes y destino antes de iniciar.");
      return;
    }

    copyCancelRef.current = false;
    copyCompletedRef.current = false;
    setCopyErrors([]);
    setCopyWarnings([]);
    setCopyAudit(null);
    setCopyStage("inicio");
    setCopyMessage("Iniciando copiado...");
    setCopyProgress(0);
    setCopyOi("");
    setCopyOperationId("");
    setLiveEvents([]);
    setLiveOpen(false);
    stopStream("reset");
    stopPolling("reset");
    activeOperationIdRef.current = "";
    pollCursorRef.current = -1;
    lastCursorRef.current = -1;
    setCopying(true);

    try {
      const start = await log02CopyConformesStart({
        run_id: runSelected.id,
        rutas_origen: origenes,
        ruta_destino: destino,
      });

      const opId = start.operation_id;
      setCopyOperationId(opId);
      activeOperationIdRef.current = opId;

      const ac = new AbortController();
      copyAbortRef.current = ac;
      streamActiveRef.current = true;
      streamOperationIdRef.current = opId;
      lastStreamEventAtRef.current = Date.now();
      scheduleStreamWatchdog(opId);

      const streamPromise = subscribeLog02CopyConformesProgress(
        opId,
        (ev) => {
          if (!mountedRef.current) return;
          if (activeOperationIdRef.current !== opId) return;
          noteStreamEvent(opId);
          handleCopyEvent(ev as any, "stream");
        },
        ac.signal
      );
      streamPromise
        .then(() => {
          if (activeOperationIdRef.current !== opId) return;
          markStreamClosed("stream_closed");
          if (!copyCompletedRef.current && !copyCancelRef.current) {
            startPolling(opId, "stream_closed");
          }
        })
        .catch((err) => {
          if (activeOperationIdRef.current !== opId) return;
          if (isAbortLikeError(err) || copyCancelRef.current || copyCompletedRef.current) {
            markStreamClosed("stream_aborted");
            return;
          }
          markStreamClosed("stream_error");
          startPolling(opId, "stream_error");
        });
    } catch (e) {
      if (copyCancelRef.current || copyCompletedRef.current || isAbortLikeError(e)) return;
      const ax = e as AxiosError<any>;
      const detail=
        (ax.response?.data?.detail as string) ||
        ax.message ||
        "No se pudo iniciar/leer el progreso.";
        setCopyErrors((prev) => [...prev, { message: detail}]);
        setCopyStage("error");
        setCopyMessage(detail);
      stopStream("start_error");
      stopPolling("start_error");
      setCopying(false);
    }
  }

  async function cancelarCopiado() {
    if (!copyOperationId) return;
    copyCancelRef.current = true;
    activeOperationIdRef.current = "";
    try {
      await log02CopyConformesCancel(copyOperationId);
    } catch {
      // si falla el cancel, igual abortamos el stram local
    }
    try {
      copyAbortRef.current?.abort();
    } catch {}
    stopStream("user_cancel");
    stopPolling("user_cancel");
    setCopying(false);
    setCopyStage("cancelado");
    setCopyMessage("Cancelado por el usuario.");
  }

  const resumenValidacion = useMemo(() => {
    if (!resultado) return null;
    const okOrigenes = (resultado.origenes || []).filter((o) => o.existe && o.lectura).length;
    const totalOrigenes = (resultado.origenes || []).length;
    const okDestino = !!(resultado.destino?.existe 
      && resultado.destino?.es_directorio && resultado.destino?.lectura && resultado.destino?.escritura);
      return { okOrigenes, totalOrigenes, okDestino };
  }, [resultado]);

  async function copiarDetalle() {
    if (!resultado) return;
    const lines: string[] = [];
    lines.push("LOG-02 - Resultado de validación");
    lines.push("");
    for (const o of resultado.origenes || []) {
      lines.push(
        `ORIGEN | ${o.ruta} | existe=${o.existe ? "SI" : "NO"} | lectura=${o.lectura ? "SI" : "NO"} | detalle=${o.detalle || ""}`
      );
    }
    const d = resultado.destino;
    lines.push(
      `DESTINO | ${d?.ruta || ""} | existe=${d?.existe ? "SI" : "NO"} | lectura=${d?.lectura ? "SI" : "NO"} | escritura=${d?.escritura ? "SI" : "NO"} | detalle=${d?.detalle || ""}`
    );
    const text = lines.join("\n");
    await copyTextSafe(text);
  }

  async function copiarEstadoCopiado() {
     const lines: string[] = [];
     lines.push("LOG-02 - Estado de copiado (PB-LOG-015)");
     lines.push(`operation_id: ${copyOperationId || "N/D"}`);
     lines.push(`progreso: ${Number.isFinite(copyProgress) ? copyProgress.toFixed(0) : "0"}%`);
     lines.push(`estado: ${copyStage || "—"}`);
     if (copyOi) lines.push(`OI: ${copyOi}`);
     if (copyMessage) lines.push(`mensaje: ${copyMessage}`);
     await copyTextSafe(lines.join("\n"));
   }

  function parseCopyKpis(message: string) {
    const msg = String(message || "");
    const pdfMatch = msg.match(/(\d+)\s*\/\s*(\d+)\s*PDFs?/i);
    const oiMatch =
      msg.match(/(\d+)\s*\/\s*(\d+)\s*(?:OIs?|OI)/i) ||
      msg.match(/\b(\d+)\s*\/\s*(\d+)\b/);
    const pdf = pdfMatch ? { done: Number(pdfMatch[1]), total: Number(pdfMatch[2]) } : null;
    const oi = oiMatch ? { done: Number(oiMatch[1]), total: Number(oiMatch[2]) } : null;
    return { pdf, oi };
  }

  const copyKpis = useMemo(() => {
    const k = parseCopyKpis(copyMessage || "");
    return {
      pdfDone: k.pdf?.done,
      pdfTotal: k.pdf?.total,
      oiDone: k.oi?.done,
      oiTotal: k.oi?.total,
    };
  }, [copyMessage]);

  function stageLabel(stageRaw: string) {
    const s = (stageRaw || "").trim();
    if (!s) return "—";
    return translateProgressStage ? translateProgressStage(s) : s;
  }

  async function copyLiveLogToClipboard() {
    const lines: string[] = [];
    lines.push("LOG-02 - Detalle en vivo (últimos eventos)");
    lines.push("");
    for (const ev of liveEvents.slice(-80)) {
      const d = new Date(ev.ts);
      const ts = d.toLocaleString("es-PE", { timeZone: PERU_TZ, hour12: false });
      lines.push(
        `${ts} | ${ev.source} | ${ev.type}${ev.stage ? ` | ${ev.stage}` : ""}${
          ev.oi ? ` | oi=${ev.oi}` : ""
        }${typeof ev.progress === "number" ? ` | ${Math.round(ev.progress)}%` : ""}${
          ev.message ? ` | ${ev.message}` : ""
        }`
      );
    }
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        // ignorar
      }
    }
  }

  const canGoStep2 = !!resultado?.ok;
  const canGoStep3 = !!resultado?.ok && !!runSelected?.id;

  function goStep(step: WizardStep) {
    if (step === 2 && !canGoStep2) return;
    if (step === 3 && !canGoStep3) return;
    setWizardStep(step);
  }

  const copyStartTitle =
    !resultado?.ok ? "Falta validar rutas" : !runSelected?.id ? "Falta seleccionar corrida" : "";


  return (
    <div className="container-fluid">
      <div className="row">
        <div className="col-12">
          <div className="bd bgc-white p-20 mB-20">
            <h4 className="c-grey-900 mB-10">Filtrado de certificados PDF (LOG-02)</h4>
            <div className="text-muted small">
              Este módulo se orienta a <strong>copiar</strong> y <strong>filtrar</strong> certificados PDF desde una
              <strong> carpeta compartida</strong> (no ZIP).<br />
              Configura las rutas UNC y valida accesos antes de iniciar el filtrado.
            </div>

            {error ? (
              <div className="alert alert-danger mT-15" role="alert">
                {error}
              </div>
            ) : null}

            {/* Stepper */}
            <div className="vi-wizard-header mT-15">
              <ul className="nav nav-pills vi-stepper" role="tablist" aria-label="Flujo LOG-02">
                <li className="nav-item" role="presentation">
                  <button
                    type="button"
                    className={"nav-link " +(wizardStep === 1 ? "active" : "")}
                    onClick={() => goStep(1)}
                  >
                    <span className="vi-step-num">1</span> Rutas
                  </button>
                </li>
                <li className="nav-item" role="presentation">
                  <button
                    type="button"
                    className={"nav-link " + (wizardStep === 2 ? "active" : "")}
                    onClick={() => goStep(2)}
                    disabled={!canGoStep2}
                    title={!canGoStep2 ? "Primero valida rutas" : ""}
                  >
                    <span className="vi-step-num">2</span> Corrida LOG-01
                  </button>
                </li>
                <li className="nav-item" role="presentation">
                  <button
                    type="button"
                    className={"nav-link " + (wizardStep === 3 ? "active" : "")}
                    onClick={() => goStep(3)}
                    disabled={!canGoStep3}
                    title={!canGoStep3 ? "Falta validar rutas o elegir corrida" : ""}
                  >
                    <span className="vi-step-num">3</span> Ejecución
                  </button>
                </li>
              </ul>
              <div className="small text-muted mT-5">
                Flujo recomendado: <strong>1) Validar rutas</strong> → <strong>2) Elegir corrida</strong> →{" "}
                <strong>3) Iniciar copiado</strong>.
              </div>
            </div>

            {/* Wizard (Accordion) */}
            <div className="accordion vi-wizard mT-15" id="log02Wizard">
              {/* Paso 1: Rutas + Validación */}
              <div className="accordion-item">
                <h2 className="accordion-header" id="log02Step1Head">
                  <button
                    className={"accordion-button " + (wizardStep === 1 ? "" : "collapsed")}
                    type="button"
                    onClick={() => goStep(1)}
                  >
                    <span className="d-inline-flex align-items-center gap-10">
                      <span className="vi-step-num">1</span>
                      <span className="vi-step-title">Rutas UNC</span>
                      {resultado?.ok ? (
                        <span className="badge bg-success">OK</span>
                      ) : resultado ? (
                        <span className="badge bg-danger">Revisar</span>
                      ) : (
                        <span className="badge bg-secondary">Pendiente</span>
                      )}
                    </span>
                  </button>
                </h2>
                <div
                  id="log02Step1"
                  className={"accordion-collapse collapse " + (wizardStep === 1 ? "show" : "")}
                  aria-labelledby="log02Step1Head"
                  data-bs-parent="#log02Wizard"
                >
                  <div className="accordion-body">
                    <div className="row g-3">
                      <div className="col-12">
                        <div className="vi-card">
                          <h6 className="c-grey-900 mB-10">Rutas UNC</h6>

                          <div className="row g-2">
                            <div className="col-12">
                              <label className="form-label">Rutas origen (UNC) — lectura</label>
                              {rutasOrigen.map((value, i) => (
                                <div key={i} className="mB-10">
                                  <div className="d-flex gap-10 align-items-center">
                                    <div className="flex-grow-1">
                                      <input
                                        className={
                                          "form-control form-control-sm" +
                                          (touched && !(origenesLimpios[i] || "") ? " is-invalid" : "")
                                        }
                                        value={value}
                                        onChange={(e) => setOrigenAt(i, e.target.value)}
                                        placeholder="\\SERVIDOR\Compartido\Certificados"
                                        disabled={validando}
                                      />
                                      {touched && !(origenesLimpios[i] || "") ? (
                                        <div className="small text-danger mT-5">Requerido</div>
                                      ) : null}
                                    </div>

                                    <div className="btn-group" role="group" aria-label="Acciones origen">
                                      <button
                                        type="button"
                                        className="btn btn-sm btn-outline-secondary"
                                        onClick={() => void copyTextSafe((value || "").trim())}
                                        disabled={validando || !(value || "").trim()}
                                        title="Copiar ruta"
                                        style={{ minWidth: 84 }}
                                      >
                                        Copiar
                                      </button>
                                      <button
                                        type="button"
                                        className="btn btn-sm btn-outline-primary"
                                        onClick={() => abrirEditarOrigen(i)}
                                        disabled={validando}
                                        title="Elegir carpeta"
                                        style={{ minWidth: 84 }}
                                      >
                                        {(value || "").trim() ? "Editar" : "Agregar"}
                                      </button>
                                      <button
                                        type="button"
                                        className="btn btn-sm btn-outline-danger"
                                        onClick={() => removeOrigen(i)}
                                        disabled={validando}
                                        title="Quitar ruta"
                                        style={{ minWidth: 52 }}
                                      >
                                        –
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              ))}

                              <div className="d-flex gap-10">
                                <button
                                  type="button"
                                  className="btn btn-sm btn-primary"
                                  onClick={abrirAgregarOrigen}
                                  disabled={validando}
                                  title="Agregar origen"
                                >
                                  Agregar origen
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-sm btn-outline-secondary"
                                  onClick={quitarDuplicadosUI}
                                  disabled={validando}
                                  title="Quitar duplicados (solo UI)"
                                >
                                  Quitar duplicados
                                </button>
                              </div>

                              <div className="small text-muted">
                                Nota: estas rutas deben ser accesibles <strong>desde el servidor</strong> donde corre el backend.
                              </div>
                            </div>

                            <div className="col-12">
                              <label className="form-label">Ruta destino (UNC) — lectura y escritura</label>
                              <div className="d-flex gap-10 mB-10">
                                <div className="flex-grow-1">
                                  <input
                                    className={
                                      "form-control form-control-sm " +
                                      (touched && !destinoLimpio ? "is-invalid" : "")
                                    }
                                    value={rutaDestino}
                                    onChange={(e) => setRutaDestino(e.target.value)}
                                    placeholder="\\SERVIDOR\Compartido\Salida_LOG02"
                                    disabled={validando}
                                  />
                                  {touched && !destinoLimpio ? (
                                    <div className="small text-danger mT-5">Destino requerido.</div>
                                  ) : null}
                                </div>

                                <div className="btn-group" role="group" aria-label="Acciones destino">
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-outline-secondary"
                                    onClick={() => void copyTextSafe(destinoLimpio)}
                                    disabled={validando || !destinoLimpio}
                                    title="Copiar ruta"
                                    style={{ minWidth: 84 }}
                                  >
                                    Copiar
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-outline-primary"
                                    onClick={abrirDestino}
                                    disabled={validando}
                                    title="Elegir carpeta"
                                    style={{ minWidth: 84 }}
                                  >
                                    {destinoLimpio ? "Editar" : "Agregar"}
                                  </button>
                                </div>
                              </div>

                              <div className="mT-5">
                                <div className="small text-muted mB-5">
                                  {listoParaValidar ? "Listo para validar." : "Completa orígenes y destino."}
                                </div>
                                <div className="d-flex gap-10">
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-primary"
                                    onClick={() => void validar()}
                                    disabled={validando || !listoParaValidar}
                                  >
                                    {validando ? "Validando..." : "Validar"}
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-outline-danger"
                                    onClick={limpiarConfiguracion}
                                    disabled={validando}
                                    title="Limpia orígenes y destino"
                                  >
                                    Limpiar rutas
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="col-12">
                        {resultado ? (
                          <div className="vi-card">
                            <h6 className="c-grey-900 mB-10">Resultado de validación</h6>

                            {resumenValidacion ? (
                              <div className="d-flex flex-wrap gap-10 align-items-center mB-10">
                                <span className="badge vi-surface-2 vi-text">
                                  Orígenes OK: <strong>{resumenValidacion.okOrigenes}</strong> / {resumenValidacion.totalOrigenes}
                                </span>
                                <span className={resumenValidacion.okDestino ? "badge bg-success" : "badge bg-danger"}>
                                  Destino: {resumenValidacion.okDestino ? "OK" : "No OK"}
                                </span>
                                {!resultado.ok ? (
                                  <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => void copiarDetalle()}>
                                    Copiar detalle
                                  </button>
                                ) : null}
                              </div>
                            ) : null}

                            <div className="table-responsive">
                              <table className="table table-sm mB-0">
                                <thead>
                                  <tr className="small">
                                    <th style={{ whiteSpace: "nowrap" }}>Tipo</th>
                                    <th>Ruta</th>
                                    <th style={{ whiteSpace: "nowrap" }}>Existe</th>
                                    <th style={{ whiteSpace: "nowrap" }}>Lectura</th>
                                    <th style={{ whiteSpace: "nowrap" }}>Escritura</th>
                                    <th>Detalle</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {resultado.origenes.map((o, idx) => (
                                    <tr key={`o-${idx}`} className="small">
                                      <td style={{ whiteSpace: "nowrap" }}><strong>Origen</strong></td>
                                      <td style={{ wordBreak: "break-all" }}>{o.ruta || "N/D"}</td>
                                      <td><span className={badge(o.existe)}>{o.existe ? "Sí" : "No"}</span></td>
                                      <td><span className={badge(o.lectura)}>{o.lectura ? "Sí" : "No"}</span></td>
                                      <td><span className={badge(null)}>—</span></td>
                                      <td>{o.detalle || ""}</td>
                                    </tr>
                                  ))}

                                  <tr className="small">
                                    <td style={{ whiteSpace: "nowrap" }}><strong>Destino</strong></td>
                                    <td style={{ wordBreak: "break-all" }}>{resultado.destino.ruta || "N/D"}</td>
                                    <td><span className={badge(resultado.destino.existe)}>{resultado.destino.existe ? "Sí" : "No"}</span></td>
                                    <td><span className={badge(resultado.destino.lectura)}>{resultado.destino.lectura ? "Sí" : "No"}</span></td>
                                    <td>
                                      <span className={badge(!!resultado.destino.escritura)}>
                                        {resultado.destino.escritura ? "Sí" : "No"}
                                      </span>
                                    </td>
                                    <td>{resultado.destino.detalle || ""}</td>
                                  </tr>
                                </tbody>
                              </table>
                            </div>

                            {resultado.ok ? (
                              <div className="alert alert-success mT-15" role="alert">
                                Rutas validadas correctamente. Puedes continuar con la siguiente fase.
                              </div>
                            ) : (
                              <div className="alert alert-warning mT-15" role="alert">
                                Hay rutas con problemas. Corrige existencia/permisos y vuelve a validar.
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="vi-callout small">
                            Aún no has validado las rutas. Ejecuta “Validar” para continuar al paso 2.
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Paso 2: Corrida LOG-01 */}
              <div className="accordion-item">
                <h2 className="accordion-header" id="log02Step2Head">
                  <button
                    className={"accordion-button " + (wizardStep === 2 ? "" : "collapsed")}
                    type="button"
                    onClick={() => goStep(2)}
                    disabled={!canGoStep2}
                  >
                    <span className="d-inline-flex align-items-center gap-10">
                      <span className="vi-step-num">2</span>
                      <span className="vi-step-title">Corrida LOG-01</span>
                      {runSelected?.id ? (
                        <span className="badge bg-success">Seleccionada</span>
                      ) : canGoStep2 ? (
                        <span className="badge bg-warning vi-text-contrast">Pendiente</span>
                      ) : (
                        <span className="badge bg-secondary">Bloqueado</span>
                      )}
                    </span>
                  </button>
                </h2>
                <div
                  id="log02Step2"
                  className={"accordion-collapse collapse " + (wizardStep === 2 ? "show" : "")}
                  aria-labelledby="log02Step2Head"
                  data-bs-parent="#log02Wizard"
                >
                  <div className="accordion-body">
                    {!canGoStep2 ? (
                      <div className="vi-callout small">Valida rutas para habilitar este paso.</div>
                    ) : (
                      <>
                        <div className="d-flex flex-wrap align-items-center justify-content-between gap-10">
                          <div className="vi-card flex-grow-1">
                            <div className="small text-muted">Corrida seleccionada</div>
                            {runSelected?.id ? (
                              <div className="mT-5">
                                <div className="d-flex flex-wrap gap-10 align-items-center">
                                  <span className="badge vi-surface-2 vi-text">#{runSelected.id}</span>
                                  {runSelected?.created_at ? (
                                    <span className="small text-muted">{formatDateTime(runSelected.created_at)}</span>
                                  ) : null}
                                  {runSelected?.source ? <span className="small text-muted">{runSelected.source}</span> : null}
                                  {runSelected?.status ? <span className="small text-muted">{runSelected.status}</span> : null}
                                </div>
                              </div>
                            ) : (
                              <div className="text-muted small mT-5">Aún no se ha elegido una corrida.</div>
                            )}
                          </div>

                          <div className="d-flex gap-10">
                            <button
                              type="button"
                              className="btn btn-sm btn-outline-primary"
                              onClick={abrirModalCorridas}
                              disabled={copying}
                            >
                              {runSelected?.id ? "Cambiar corrida" : "Elegir corrida"}
                            </button>
                          </div>
                        </div>

                        {!runSelected?.id ? (
                          <div className="vi-callout mT-10 small">
                            Debes seleccionar una corrida de LOG-01 (historial) para usar su manifiesto y NO CONFORME.
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Paso 3: Ejecución + Progreso + Live log */}
              <div className="accordion-item">
                <h2 className="accordion-header" id="log02Step3Head">
                  <button
                    className={"accordion-button " + (wizardStep === 3 ? "" : "collapsed")}
                    type="button"
                    onClick={() => goStep(3)}
                    disabled={!canGoStep3}
                  >
                    <span className="d-inline-flex align-items-center gap-10">
                      <span className="vi-step-num">3</span>
                      <span className="vi-step-title">Ejecución</span>
                      {copying ? (
                        <span className="badge bg-primary">En progreso</span>
                      ) : copyAudit ? (
                        <span className="badge bg-success">Completado</span>
                      ) : canGoStep3 ? (
                        <span className="badge bg-secondary">Listo</span>
                      ) : (
                        <span className="badge bg-secondary">Bloqueado</span>
                      )}
                    </span>
                  </button>
                </h2>
                <div
                  id="log02Step3"
                  className={"accordion-collapse collapse " + (wizardStep === 3 ? "show" : "")}
                  aria-labelledby="log02Step3Head"
                  data-bs-parent="#log02Wizard"
                >
                  <div className="accordion-body">
                    {!canGoStep3 ? (
                      <div className="vi-callout small">
                        Valida rutas y selecciona una corrida para habilitar la ejecución.
                      </div>
                    ) : (
                      <>
                        <div className="d-flex flex-wrap gap-10 mB-10">
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            onClick={() => void iniciarCopiado()}
                            disabled={!puedeIniciarCopiado}
                            title={copyStartTitle}
                          >
                            {copying ? "Copiando..." : "Iniciar copiado"}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-outline-danger"
                            onClick={() => void cancelarCopiado()}
                            disabled={!copying || !copyOperationId}
                          >
                            Cancelar
                          </button>
                        </div>

                        <div className="mT-10">
                          <h6 className="c-grey-900 mB-10 d-flex align-items-center gap-2">
                            <span>Progreso</span>
                            {copying ? (
                              <img
                                className="vi-progress-spinner"
                                src="/medileser/Spinner-Logo-Medileser.gif"
                                alt="Procesando"
                              />
                            ) : null}
                            {copyOperationId ? (
                              <span className="badge vi-surface-2 vi-text">
                                op: <strong>{copyOperationId}</strong>
                              </span>
                            ) : null}
                            <button
                              type="button"
                              className="btn btn-sm btn-outline-secondary ms-auto"
                              onClick={() => void copiarEstadoCopiado()}
                              disabled={!copyStage && !copyMessage && !copyOperationId}
                              title="Copiar estado del progreso"
                            >
                              Copiar estado
                            </button>
                          </h6>

                          <div className="d-flex flex-wrap gap-10 mB-5">
                            <span className="badge vi-surface-2 vi-text">
                              PDFs: {copyKpis.pdfDone ?? "—"} / {copyKpis.pdfTotal ?? "—"}
                            </span>
                            <span className="badge vi-surface-2 vi-text">
                              OIs: {copyKpis.oiDone ?? "—"} / {copyKpis.oiTotal ?? "—"}
                            </span>
                            {copyWarnings.length ? (
                              <span className="badge bg-warning vi-text-contrast">Advertencias: {copyWarnings.length}</span>
                            ) : null}
                            {copyErrors.length ? (
                              <span className="badge bg-danger">Errores: {copyErrors.length}</span>
                            ) : null}
                          </div>

                          <div className="small text-muted">
                            <strong>{copyStage ? stageLabel(copyStage) : copying ? "En progreso" : "—"}</strong>
                            {copyMessage ? <span> · {copyMessage}</span> : null}
                          </div>
                          <div className="small text-muted">
                            {copyOi ? `OI actual: ${copyOi}` : "OI actual: —"}
                            {copyKpis.pdfDone != null && copyKpis.pdfTotal != null ? (
                              <span> · {copyKpis.pdfDone}/{copyKpis.pdfTotal} PDFs</span>
                            ) : null}
                            {copyKpis.oiDone != null && copyKpis.oiTotal != null ? (
                              <span> · {copyKpis.oiDone}/{copyKpis.oiTotal} OIs</span>
                            ) : null}
                          </div>

                          <div className="progress vi-progress">
                            <div
                              className="progress-bar"
                              role="progressbar"
                              style={{ width: `${Math.max(0, Math.min(100, copyProgress))}%` }}
                              aria-valuenow={copyProgress}
                              aria-valuemin={0}
                              aria-valuemax={100}
                            >
                              <span className="vi-progress-label">{copyProgress.toFixed(0)}%</span>
                            </div>
                          </div>
                          
                        </div>

                        {/* Detalle en vivo */}
                        <div className="accordion mT-10" id="log02LiveLog">
                          <div className="accordion-item">
                            <h2 className="accordion-header" id="log02LiveLogHead">
                              <button
                                className={"accordion-button vi-acc-sm " + (liveOpen ? "" : "collapsed")}
                                type="button"
                                onClick={() => setLiveOpen((v) => !v)}
                              >
                                Detalle en vivo {liveEvents.length ? `(${liveEvents.length})` : ""}
                              </button>
                            </h2>
                            <div
                              id="log02LiveLogBody"
                              className={"accordion-collapse collapse " + (liveOpen ? "show" : "")}
                              aria-labelledby="log02LiveLogHead"
                            >
                              <div className="accordion-body p-0">
                                <div className="d-flex flex-wrap align-items-center justify-content-between gap-10 p-10">
                                  <div className="small text-muted">Últimos eventos (máx {MAX_LIVE_EVENTS})</div>
                                  <div className="d-flex gap-10">
                                    <button
                                      type="button"
                                      className="btn btn-sm btn-outline-secondary"
                                      onClick={() => void copyLiveLogToClipboard()}
                                      disabled={!liveEvents.length}
                                    >
                                      Copiar
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn-sm btn-outline-danger"
                                      onClick={() => setLiveEvents([])}
                                      disabled={!liveEvents.length}
                                    >
                                      Limpiar
                                    </button>
                                  </div>
                                </div>
                                <div className="vi-logbox">
                                  {liveEvents.length ? (
                                    liveEvents.slice(-80).map((ev, idx) => {
                                      const d = new Date(ev.ts);
                                      const ts = d.toLocaleString("es-PE", { timeZone: PERU_TZ, hour12: false });
                                      const line = `${ts} | ${ev.source} | ${ev.type}${
                                        ev.stage ? ` | ${ev.stage}` : ""
                                      }${ev.oi ? ` | oi=${ev.oi}` : ""}${
                                        typeof ev.progress === "number" ? ` | ${Math.round(ev.progress)}%` : ""
                                      }${ev.message ? ` | ${ev.message}` : ""}`;
                                      return (
                                        <div key={`le-${idx}`} className="vi-logline">
                                          {line}
                                        </div>
                                      );
                                    })
                                  ) : (
                                    <div className="small text-muted">Sin eventos aún.</div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>

                        {copyErrors.length ? (
                          <div className="alert alert-danger mT-10" role="alert">
                            <strong>Se detectaron errores:</strong>
                            <ul className="mB-0 mT-5">
                              {copyErrors.slice(-8).map((x, idx) => (
                                <li key={`ce-${idx}`}>
                                  {x.oi ? `[${x.oi}] ` : ""}
                                  {x.file ? `${x.file}: ` : ""}
                                  {x.message}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}

                        {copyWarnings.length ? (
                          <div className="alert alert-warning mT-10" role="alert">
                            <strong>Advertencias:</strong>
                            <ul className="mB-0 mT-5">
                              {copyWarnings.slice(-8).map((x, idx) => (
                                <li key={`cw-${idx}`}>
                                  [{x.oi}] {x.code ? `${x.code}: ` : ""}
                                  {x.message}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}

                        {copyAudit ? (
                          <div className="mT-15">
                            <h6 className="c-grey-900 mB-10">Auditoría de copiado</h6>
                            <div className="row g-2">
                              <div className="col-12 col-md-4">
                                <div className="alert alert-light mB-0">
                                  <div>
                                    <strong>Total OIs:</strong> {copyAudit?.total_ois ?? "N/D"}
                                  </div>
                                  <div>
                                    <strong>OIs OK:</strong> {copyAudit?.ois_ok ?? "N/D"}
                                  </div>
                                </div>
                              </div>
                              <div className="col-12 col-md-8">
                                <div className="alert alert-light mB-0">
                                  <div className="d-flex flex-wrap gap-10">
                                    <span>
                                      <strong>PDF detectados:</strong> {copyAudit?.archivos?.pdf_detectados ?? "N/D"}
                                    </span>
                                    <span>
                                      <strong>PDF copiados:</strong> {copyAudit?.archivos?.pdf_copiados ?? "N/D"}
                                    </span>
                                    <span>
                                      <strong>Omitidos NO CONFORME:</strong> {copyAudit?.archivos?.pdf_omitidos_no_conforme ?? "N/D"}
                                    </span>
                                    <span>
                                      <strong>No PDF omitidos:</strong> {copyAudit?.archivos?.archivos_no_pdf_omitidos ?? "N/D"}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            </div>

                            {(copyAudit?.ois_faltantes?.length ||
                              copyAudit?.ois_duplicadas?.length ||
                              copyAudit?.destinos_duplicados?.length) ? (
                              <div className="mT-10">
                                {copyAudit?.ois_faltantes?.length ? (
                                  <div className="alert alert-warning" role="alert">
                                    <strong>OIs sin carpeta:</strong>
                                    <ul className="mB-0 mT-5">
                                      {copyAudit.ois_faltantes.slice(0, 10).map((x: any, idx: number) => (
                                        <li key={`of-${idx}`}>
                                          {x?.oi} — {x?.detalle || ""}
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                ) : null}

                                {copyAudit?.ois_duplicadas?.length ? (
                                  <div className="alert alert-warning" role="alert">
                                    <strong>OIs con múltiples carpetas (duplicadas):</strong>
                                    <ul className="mB-0 mT-5">
                                      {copyAudit.ois_duplicadas.slice(0, 10).map((x: any, idx: number) => (
                                        <li key={`od-${idx}`}>
                                          {x?.oi} — {Array.isArray(x?.carpetas) ? x.carpetas.join(" | ") : ""}
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                ) : null}

                                {copyAudit?.destinos_duplicados?.length ? (
                                  <div className="alert alert-warning" role="alert">
                                    <strong>Destinos ya existentes:</strong>
                                    <ul className="mB-0 mT-5">
                                      {copyAudit.destinos_duplicados.slice(0, 10).map((x: any, idx: number) => (
                                        <li key={`dd-${idx}`}>
                                          {x?.oi} — {x?.destino || ""}
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Sticky action bar (solo durante ejecución) */}
          {copying ? (
            <div className="vi-sticky-actions">
              <div className="d-flex flex-wrap align-items-center gap-10 vi-sticky-actions-row">
                <div className="small vi-sticky-progress">
                  <strong>{copyStage ? stageLabel(copyStage) : "En progreso"}</strong>
                  {copyOi ? <span> · OI: {copyOi}</span> : null}
                  <span className="text-muted"> · {copyProgress.toFixed(0)}%</span>
                </div>
                <div className="d-flex gap-10 vi-sticky-buttons">
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-danger"
                    onClick={() => void cancelarCopiado()}
                    disabled={!copyOperationId}
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary"
                    onClick={() => setLiveOpen(true)}
                  >
                    Ver detalle
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Modal corridas LOG-01 (inline Bootstrap/Adminator) */}
      {runModalOpen ? (
        <>
          <div className="modal fade show" style={{ display: "block" }} role="dialog" aria-modal="true">
            <div className="modal-dialog modal-lg" role="document">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Seleccionar corrida de LOG-01 (Historial)</h5>
                  <button type="button" className="close" aria-label="Close" onClick={() => setRunModalOpen(false)}>
                    <span aria-hidden="true">&times;</span>
                  </button>
                </div>

                <div className="modal-body">
                  <div className="text-muted small mB-10">
                    Por defecto se cargan las <strong>últimas 5 corridas completadas</strong>. Puedes usar filtros si lo
                    necesitas.
                  </div>

                  {runsError ? (
                    <div className="alert alert-danger" role="alert">
                      {runsError}
                    </div>
                  ) : null}

                  <form
                    className="row g-2 align-items-end"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void buscarCorridasConFiltros();
                    }}
                  >
                    <div className="col-12 col-md-4">
                      <label className="form-label">Buscar</label>
                      <input
                        className="form-control form-control-sm"
                        value={runQ}
                        onChange={(e) => setRunQ(e.target.value)}
                        placeholder="Serie / OI / usuario..."
                      />
                    </div>
                    <div className="col-6 col-md-2">
                      <label className="form-label">Desde</label>
                      <input
                        className="form-control form-control-sm"
                        type="date"
                        value={runDateFrom}
                        onChange={(e) => setRunDateFrom(e.target.value)}
                      />
                    </div>
                    <div className="col-6 col-md-2">
                      <label className="form-label">Hasta</label>
                      <input
                        className="form-control form-control-sm"
                        type="date"
                        value={runDateTo}
                        onChange={(e) => setRunDateTo(e.target.value)}
                      />
                    </div>
                    <div className="col-6 col-md-2">
                      <label className="form-label">Origen</label>
                      <input
                        className="form-control form-control-sm"
                        value={runSource}
                        onChange={(e) => setRunSource(e.target.value)}
                        placeholder="AUTO/BASES/..."
                      />
                    </div>
                    <div className="col-6 col-md-2">
                      <label className="form-label">Estado</label>
                      <input
                        className="form-control form-control-sm"
                        value={runStatus}
                        onChange={(e) => setRunStatus(e.target.value)}
                        placeholder="COMPLETADO"
                      />
                    </div>
                  <div className="col-12 d-flex gap-10">
                      <button type="submit" className="btn btn-sm btn-primary" disabled={runsLoading}>
                        {runsLoading ? "Buscando..." : "Aplicar filtros"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary"
                        onClick={() => {
                          setRunQ("");
                          setRunDateFrom("");
                          setRunDateTo("");
                          setRunSource("");
                          setRunStatus("COMPLETADO");
                          void cargarUltimasCorridasExitosas(5);
                        }}
                        disabled={runsLoading}
                      >
                        Ver últimas 5 exitosas
                      </button>
                    </div>
                  </form>

                  <hr />

                  {runsLoading ? (
                    <div className="text-muted small">Cargando corridas...</div>
                  ) : (
                    <div className="table-responsive">
                      <table className="table table-sm mB-0">
                        <thead>
                          <tr className="small">
                            <th style={{ width: 90 }}>ID</th>
                            <th>Creado</th>
                            <th style={{ width: 120 }}>Origen</th>
                            <th style={{ width: 140 }}>Estado</th>
                            <th style={{ width: 120 }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {runs.length ? (
                            runs.map((it) => (
                              <tr key={it.id} className="small">
                                <td>
                                  <strong>#{it.id}</strong>
                                </td>
                                <td>{formatDateTime(it.created_at)}</td>
                                <td>{it.source || "N/D"}</td>
                                <td>{it.status || "N/D"}</td>
                                <td>
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-outline-primary"
                                    onClick={() => seleccionarCorrida(it)}
                                  >
                                    Usar
                                  </button>
                                </td>
                              </tr>
                            ))
                          ) : (
                            <tr className="small">
                              <td colSpan={5} className="text-muted">
                                Sin resultados.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div className="modal-footer">
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => setRunModalOpen(false)}>
                    Cerrar
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      ) : null}

      {/* Modal explorador (inline Bootstrap/Adminator) */}
      {explorerOpen ? (
        <>
          <div className="modal fade show" style={{ display: "block" }} role="dialog" aria-modal="true">
            <div className="modal-dialog modal-lg" role="document">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">
                    {explorerMode === "destino" ? "Elegir carpeta de destino" : "Elegir carpeta de origen"}
                  </h5>
                  <button type="button" className="btn-close" aria-label="Cerrar" onClick={() => setExplorerOpen(false)} />
                </div>

                <div className="modal-body">
                  {explorerError ? (
                    <div className="alert alert-danger" role="alert">
                      {explorerError}
                    </div>
                  ) : null}

                  <div className="row g-2">
                    <div className="col-12 col-md-6">
                      <label className="form-label">Raíz</label>
                      <select
                        className="form-control form-control-sm"
                        value={rootSel}
                        onChange={(e) => {
                          const v = e.target.value;
                          setRootSel(v);
                          void loadFolders(v);
                        }}
                        disabled={!roots.length}
                      >
                       {roots.length ? (
                          roots.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))
                        ) : (
                          <option value="">Sin raíces</option>
                        )}
                      </select>
                    </div>

                    <div className="col-12 col-md-6">
                      <label className="form-label">Carpeta actual</label>
                      <input className="form-control form-control-sm" value={currentPath} readOnly />
                    </div>
                  </div>

                  {/* Breadcrumbs */}
                    <div className="mT-10">
                      <label className="form-label mB-5">Navegación</label>
                      <div className="p-10 vi-surface-2 border vi-border rounded">
                      <div className="d-flex flex-wrap align-items-center gap-10">
                        {buildBreadcrumbs(currentPath).map((c, idx, arr) => (
                          <span key={`${c.path}-${idx}`} className="small d-inline-flex align-items-center">
                            <button
                              type="button"
                              className="btn btn-link p-0 align-baseline"
                              onClick={() => void loadFolders(c.path)}
                              disabled={loadingFolders}
                              title={`Ir a: ${c.path}`}
                            >
                              {c.label}
                            </button>
                            {idx < arr.length - 1 ? (
                              <span className="text-muted mX-5">/</span>
                            ) : null}
                          </span>
                        ))}
                      </div>
                      <div className="small vi-text-muted mT-5">
                        Tip: Click en una sección para saltar a esa carpeta.
                      </div>
                    </div>
                  </div>

                  {/* Go to + copy */}
                  <div className="row g-2 mT-10">
                    <div className="col-12 col-md-8">
                      <label className="form-label">Ir a ruta</label>
                      <div className="input-group input-group-sm">
                        <input
                          className="form-control"
                          value={gotoPath}
                          onChange={(e) => setGotoPath(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void onGoToPath();
                            }
                          }}
                          placeholder="Pega una ruta (UNC o local) dentro de las raíces permitidas"
                          disabled={loadingFolders}
                        />
                        <button type="button" className="btn btn-outline-primary" onClick={() => void onGoToPath()} disabled={loadingFolders || !gotoPath.trim()}>
                          Ir
                        </button>
                      </div>
                    </div>
                    <div className="col-12 col-md-4">
                      <label className="form-label">Acciones</label>
                      {/* Alineación: hacemos que el contenedor tenga el mismo "alto" visual que el input-group */}
                      <div
                        className="d-flex align-items-end"
                        style={{ minHeight: 31 }} // altura típica de input-group-sm (aprox)
                      >
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-secondary"
                          onClick={() => void copyCurrentPath()}
                          disabled={!currentPath || loadingFolders}
                          title="Copiar la ruta actual al portapapeles"
                        >
                          Copiar ruta
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="d-flex gap-10 mT-10">
                    <button type="button" className="btn btn-sm btn-outline-secondary" onClick={upOneLevel} disabled={!currentPath || loadingFolders}>
                      Subir nivel
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={selectExplorerCurrentFolder}
                      disabled={!currentPath || loadingFolders}
                    >
                      Seleccionar carpeta
                    </button>
                  </div>

                  <hr />

                  <div className="row g-2 mB-10">
                    <div className="col-12 col-md-8">
                      <label className="form-label">Buscar subcarpeta</label>
                      <input
                        className="form-control form-control-sm"
                        value={folderQuery}
                        onChange={(e) => setFolderQuery(e.target.value)}
                        placeholder="Filtrar por nombre…"
                        disabled={loadingFolders}
                      />
                      <div className="form-text">
                        Mostrando {filteredFolders.length} de {folders.length}
                      </div>
                    </div>
                  </div>

                  {loadingFolders ? (
                    <div className="text-muted small">Cargando carpetas...</div>
                  ) : (
                    <div className="table-responsive">
                      <table className="table table-sm mB-0">
                        <thead>
                          <tr className="small">
                            <th>Subcarpetas</th>
                            <th style={{ width: 120 }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredFolders.length ? (
                            filteredFolders.map((f, idx) => (
                              <tr
                                key={f.path}
                                className={"small" + (selectedFolderPath === f.path ? " table-active" : "")}
                                role="button"
                                tabIndex={0}
                                data-folder-idx={idx}
                                title="Click para seleccionar · Doble click para entrar"
                                style={{ cursor: loadingFolders ? "default" : "pointer" }}
                                onClick={(e) => {
                                  if (loadingFolders) return;
                                  setSelectedFolderPath(f.path);
                                  (e.currentTarget as HTMLElement).focus();
                                }}
                                onDoubleClick={() => {
                                  if (loadingFolders) return;
                                  void loadFolders(f.path);
                                }}
                                onKeyDown={(e) => {
                                  if (loadingFolders) return;
                                  // Enter: entrar
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    void loadFolders(f.path);
                                    return;
                                  }
                                  // Space: seleccionar (útil si navegas con tab/teclado)
                                  if (e.key === " " || e.key === "Spacebar") {
                                    e.preventDefault();
                                    setSelectedFolderPath(f.path);
                                    return;
                                  }
                                }}
                              >
                                <td style={{ wordBreak: "break-all" }}>{f.name}</td>
                                <td>
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-outline-primary"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void loadFolders(f.path);
                                    }}
                                    disabled={loadingFolders}
                                  >
                                    Entrar
                                  </button>
                                </td>
                              </tr>
                            ))
                          ) : (
                            <tr className="small">
                             <td colSpan={2} className="text-muted">
                               Sin resultados para el filtro, o sin subcarpetas/permisos para listar.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div className="modal-footer">
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => setExplorerOpen(false)}>
                    Cerrar
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" onClick={() => setExplorerOpen(false)}></div>
        </>
      ) : null}
    </div>
  );
}
