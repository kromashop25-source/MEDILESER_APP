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

function badge(ok?: boolean | null) {
  if (ok === true) return "badge bg-success";
  if (ok === false) return "badge bg-danger";
  return "badge bg-secondary";
}

type ExplorerMode = "origen" | "destino";

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

  async function openExplorer(mode:ExplorerMode) {
    setExplorerMode(mode);
    setExplorerError("");
    setExplorerOpen(true);
    try {
      const res = await log02ExplorerRoots();
      const rs = res.roots || [];
      setRoots(rs);
      const first = rs[0] || "";
      setRootSel(first);
      setCurrentPath(first);
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
      const res = await log02ExplorerListar(path);
      setCurrentPath(res.path);
      setFolders(res.folders || []);
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

  function upOneLevel() {
    // Subir un nivel: recortamos por separador de Windows "\".
    // Mantener dentro de la raíz: el backend bloqueará si sale del allowlist.
    const p = (currentPath || "").replace(/[\\\/]+$/, "");
    const idx = p.lastIndexOf("\\");
    if (idx <= 0) return;
    const parent = p.slice(0, idx);
    void loadFolders(parent);
  }

  function selectCurrentFolder() {
    if (!currentPath) return;
    if (explorerMode === "destino") {
      setRutaDestino(currentPath);
    } else {
      setRutasOrigen((prev) =>  {
        const clean = currentPath.trim();
       if (!clean) return prev;

        const next = prev.slice();

        // Editar fila existente
        if (originEditIndex !== null && originEditIndex >= 0 && originEditIndex < next.length) {
          next[originEditIndex] = clean;
          return next;
        }

        // Agregar nuevo origen SOLO al seleccionar
        const exists = next.map((x) => (x || "").trim().toLowerCase()).includes(clean.toLowerCase());
        if (exists) return next;

        // si la primera fila está vacía, la reemplazamos
        if (next.length === 1 && !(next[0] || "").trim()) return [clean];

        return [...next, clean];
      });
    }
    setOriginEditIndex(null);
    // Cerrar modal al seleccionar
    setExplorerOpen(false);
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
  }

  function stopPolling(reason: string) {
    void reason;
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
  }

  function clearStreamWatchdog() {
    if (streamWatchdogRef.current != null) {
      window.clearTimeout(streamWatchdogRef.current);
      streamWatchdogRef.current = null;
    }
  }

  function markStreamClosed(reason: string) {
    void reason;
    streamActiveRef.current = false;
    streamOperationIdRef.current = "";
    clearStreamWatchdog();
  }

  function stopStream(reason: string) {
    void reason;
    markStreamClosed(reason);
    try {
      copyAbortRef.current?.abort();
    } catch {}
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
    if (pollingActiveRef.current) return;
    pollingActiveRef.current = true;
    pollOperationIdRef.current = operationId;
    pollAbortRef.current = new AbortController();
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
    stopStream("reset");
    stopPolling("reset");
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
          noteStreamEvent(opId);
          handleCopyEvent(ev as any, "stream");
        },
        ac.signal
      );
      streamPromise
        .then(() => {
          markStreamClosed("stream_closed");
          if (!copyCompletedRef.current && !copyCancelRef.current) {
            startPolling(opId, "stream_closed");
          }
        })
        .catch((err) => {
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
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // fallback
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy")
        document.body.removeChild(ta);
      } catch {
        // ignorar
      }
    }
  }


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

            <div className="mT-15">
              <h6 className="c-grey-900 mB-10">Rutas UNC</h6>

              <div className="row g-2">
                <div className="col-12">
                  <label className="form-label">Rutas origen (UNC) — lectura</label>

                  {rutasOrigen.map((value, i) => (
                    <div key={i} className="d-flex gap-10 mB-10">
                      <input
                        className={
                          "form-control form-control-sm" +
                          (touched && !(origenesLimpios[i] || "") ? " is-invalid" : "")
                        }
                        value={value}
                        onChange={(e) => setOrigenAt(i, e.target.value)}
                        placeholder="\\\\SERVIDOR\\Compartido\\Certificados"
                        disabled={validando}
                      />
                      {touched && !(origenesLimpios[i] || "") ? (
                        <div className="small text-danger mT-5">Requerido</div>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-primary"
                        onClick={() => abrirEditarOrigen(i)}
                        disabled={validando}
                        title="Elegir carpeta"
                      >
                        {(value || "").trim() ? "Editar" : "Agregar"}
                      </button>
                      
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-danger"
                        onClick={() => removeOrigen(i)}
                        disabled={validando}
                        title="Quitar ruta"
                        style={{ width: 52, textAlign: "center" }}
                      >
                        –
                      </button>
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
                    <input
                      className={
                        "form-control form-control-sm " +
                        (touched && !destinoLimpio ? "is-invalid" : "")
                      }
                      value={rutaDestino}
                      onChange={(e) => setRutaDestino(e.target.value)}
                      placeholder="\\\\SERVIDOR\\Compartido\\Salida_LOG02"
                      disabled={validando}
                    />
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-primary"
                      onClick={abrirDestino}
                      disabled={validando}
                      title="Editar carpeta"
                    >
                      {destinoLimpio ? "Editar" : "Agregar"}
                    </button>                  </div>
                  {touched && !destinoLimpio ? (
                    <div className="small text-danger mT-5">Destino requerido.</div>
                  ) : null}
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

            {resultado ? (
              <div className="mT-20">
                <h6 className="c-grey-900 mB-10">Resultado de validación</h6>
                
                {resumenValidacion ? (
                  <div className="d-flex flex-wrap gap-10 align-items-center mB-10">
                    <span className="badge bg-light text-dark">
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

                {/* ========================= */}
            {/* PB-LOG-015 - Copiado PDFs */}
            {/* ========================= */}
            <div className="mT-25">
              <h6 className="c-grey-900 mB-10">Copiado de PDFs conformes por OI (PB-LOG-015)</h6>

              <div className="d-flex flex-wrap align-items-center justify-content-between gap-10">
                <div className="small text-muted">
                  Corrida LOG-01 seleccionada:{" "}
                  {runSelected?.id ? (
                    <span className="badge bg-light text-dark">
                      #{runSelected.id}
                      {runSelected?.created_at ? ` · ${formatDateTime(runSelected.created_at)}` : ""}
                      {runSelected?.source ? ` · ${runSelected.source}` : ""}
                      {runSelected?.status ? ` · ${runSelected.status}` : ""}
                    </span>
                  ) : (
                    <span className="badge bg-warning text-dark">No seleccionada</span>
                  )}
                </div>

                <button
                  type="button"
                  className="btn btn-sm btn-outline-primary"
                  onClick={abrirModalCorridas}
                  disabled={copying}
                >
                  {runSelected?.id ? "Cambiar corrida" : "Elegir corrida"}
                </button>
              </div>

              {!runSelected?.id ? (
                <div className="alert alert-warning mT-10" role="alert">
                  Debes seleccionar una corrida de LOG-01 (historial) para usar su manifiesto y NO CONFORME.
                </div>
              ) : null}

              <div className="d-flex flex-wrap gap-10 mT-10">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => void iniciarCopiado()}
                  disabled={!puedeIniciarCopiado}
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
                </h6>
                {copyStage || copyMessage ? (
                  <div className="small text-muted">
                    <strong>Estado:</strong> {copyStage || "—"}
                    {copyOi ? (
                      <span>
                        {" "}
                        · <strong>OI:</strong> {copyOi}
                      </span>
                    ) : null}
                    {copyMessage ? <span> · {copyMessage}</span> : null}
                  </div>
                ) : null}
                <div className="progress" style={{ height: 10 }}>
                  <div
                    className="progress-bar"
                    role="progressbar"
                    style={{ width: `${Math.max(0, Math.min(100, copyProgress))}%` }}
                    aria-valuenow={copyProgress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  />
                </div>
                <div className="small text-muted mT-5">{copyProgress.toFixed(0)}%</div>
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
            </div>

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
            ) : null}
          </div>
        </div>
      </div>
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
                  <button type="button" className="close" aria-label="Close" onClick={() => setExplorerOpen(false)}>
                    <span aria-hidden="true">&times;</span>
                  </button>
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

                  <div className="d-flex gap-10 mT-10">
                    <button type="button" className="btn btn-sm btn-outline-secondary" onClick={upOneLevel} disabled={!currentPath || loadingFolders}>
                      Subir nivel
                    </button>
                    <button type="button" className="btn btn-sm btn-primary" onClick={selectCurrentFolder} disabled={!currentPath || loadingFolders}>
                      Seleccionar esta carpeta
                    </button>
                  </div>

                  <hr />

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
                          {folders.length ? (
                            folders.map((f) => (
                              <tr key={f.path} className="small">
                                <td style={{ wordBreak: "break-all" }}>{f.name}</td>
                                <td>
                                  <button type="button" className="btn btn-sm btn-outline-primary" onClick={() => void loadFolders(f.path)}>
                                    Entrar
                                  </button>
                                </td>
                              </tr>
                            ))
                          ) : (
                            <tr className="small">
                             <td colSpan={2} className="text-muted">
                               Sin subcarpetas o sin permisos para listar.
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
          <div className="modal-backdrop fade show"></div>
        </>
      ) : null}
    </div>
  );
}
