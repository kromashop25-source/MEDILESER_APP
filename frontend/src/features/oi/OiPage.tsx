import { useQuery } from "@tanstack/react-query";
import { getCatalogs, type Catalogs } from "../../api/catalogs";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { OISchema, pressureFromPMA, type OIForm, type OIFormInput, type BancadaRowForm } from "./schema"
import { useMemo, useEffect, useState, useRef, useContext } from "react";
import { useToast } from "../../components/Toast";
import Spinner from "../../components/Spinner";
import { getAuth, getSelectedBank, normalizeRole } from "../../api/auth";
import { UNSAFE_NavigationContext, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  api,
  clearOpenOiId,
  setOpenOiId,
  getPendingAction,
  clearPendingAction,
  isAuthExpiredError,
  type PendingAction,
} from "../../api/client";
import {
  buildDraftKey,
  clearDraft,
  clearRecoveryContext,
  clearRestoreIntent,
  getRestoreIntent,
  loadDraft,
  saveDraft,
  type RecoveryModal,
  type DraftEnvelope,
  type RecoveryContext,
} from "../../utils/recoveryDraft";
import BancadaModal, { type BancadaForm } from "./BancadaModal";
import PasswordModal from "./PasswordModal";
import {
  createOI, updateOI, generateExcel,
  addBancada, updateBancada, deleteBancada,
  getOiFull, getOi, saveCurrentOI, loadCurrentOI, clearCurrentOI, lockOi, unlockOi, updateBancadaSavedAt, updateOiSavedAt, restoreBancada, restoreOiUpdatedAt,
  patchOiCode,
  type BancadaRead,
  type BancadaRow,
  type BancadaCreate,
  type BancadaDuplicateEntry,
  type BancadaUpdatePayload,
  type OIUpdatePayload,
  type OIRead
} from "../../api/oi";

const apiBlockToForm = (block?: BancadaRow["q3"]): BancadaRowForm["q3"] => {
  if (!block) return undefined;
  return {
    c1: block.c1 ?? null,
    c2: block.c2 ?? null,
    c3: block.c3 ?? null,
    c4: block.c4 ?? null,
    c5: block.c5 ?? null,
    c6: block.c6 ?? null,
    c7: block.c7 ?? "",
    c7_seconds: block.c7_seconds ?? null,
    caudal: block.caudal ?? null,
    error: block.error ?? null,
  };
};

const formBlockToApi = (block?: BancadaRowForm["q3"]): BancadaRow["q3"] => {
  if (!block) return undefined;
  return {
    c1: block.c1 ?? null,
    c2: block.c2 ?? null,
    c3: block.c3 ?? null,
    c4: block.c4 ?? null,
    c5: block.c5 ?? null,
    c6: block.c6 ?? null,
    c7: block.c7 ?? null,
    c7_seconds: block.c7_seconds ?? null,
    caudal: block.caudal ?? null,
    error: block.error ?? null,
  };
};

const apiRowToForm = (row: BancadaRow): BancadaRowForm => ({
  medidor: row.medidor ?? "",
  estado: row.estado ?? 0,
  q3: apiBlockToForm(row.q3),
  q2: apiBlockToForm(row.q2),
  q1: apiBlockToForm(row.q1),
});

const formRowToApi = (row: BancadaRowForm): BancadaRow => ({
  medidor: row.medidor ?? "",
  estado: row.estado ?? 0,
  q3: formBlockToApi(row.q3),
  q2: formBlockToApi(row.q2),
  q1: formBlockToApi(row.q1),
});

const resolveEditingRows = (row: BancadaRead): BancadaRow[] => {
  if (row.rows_data && row.rows_data.length > 0) {
    return row.rows_data;
  }
  return Array.from({ length: row.rows }).map((_, i) => ({
    medidor: i === 0 ? (row.medidor ?? "") : "",
    estado: row.estado,
    q3: i === 0 ? row.q3 ?? undefined : undefined,
    q2: i === 0 ? row.q2 ?? undefined : undefined,
    q1: i === 0 ? row.q1 ?? undefined : undefined,
  }));
};

const calcMedidoresFromBancadas = (items: BancadaRead[]) =>
  items.reduce((acc, item) => acc + (item.rows ?? 0), 0);

const cloneBancadas = (items: BancadaRead[]) =>
  JSON.parse(JSON.stringify(items)) as BancadaRead[];

const serializeBancada = (b: BancadaRead) =>
  JSON.stringify({
    medidor: b.medidor ?? null,
    estado: b.estado ?? 0,
    rows: b.rows ?? 0,
    rows_data: b.rows_data ?? null,
    q1: b.q1 ?? null,
    q2: b.q2 ?? null,
    q3: b.q3 ?? null,
  });

const getRowsDataForBancada = (row: BancadaRead): BancadaRow[] => {
  if (row.rows_data && row.rows_data.length > 0) {
    return row.rows_data;
  }
  return resolveEditingRows(row);
};

const resolveMode = (raw: string | null, hasExisting: boolean) => {
  if (raw === "view" && hasExisting) return "view";
  return "edit";
};

const toDatetimeLocal = (iso?: string | null) => {
  if (!iso) return "";
  const hasTz = /([zZ]|[+-]\d{2}:?\d{2})$/.test(iso);
  const normalized = hasTz ? iso : `${iso}Z`;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const toUtcNaiveIso = (value: string) => {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().replace("Z", "");
};

type DuplicateInfo = {
  message: string;
  bancadaItem?: number;
  bancadaId?: number;
};

const normalizeMedidorKey = (value?: string | null) =>
  (value ?? "").trim().toUpperCase();

const buildDuplicateMap = (entries: BancadaDuplicateEntry[]) => {
  const grouped: Record<string, { items: number[]; ids: number[] }> = {};
  entries.forEach((entry) => {
    const key = normalizeMedidorKey(entry.medidor);
    if (!key) return;
    if (!grouped[key]) {
      grouped[key] = { items: [], ids: [] };
    }
    if (entry.bancada_item != null && !grouped[key].items.includes(entry.bancada_item)) {
      grouped[key].items.push(entry.bancada_item);
    }
    if (entry.bancada_id != null && !grouped[key].ids.includes(entry.bancada_id)) {
      grouped[key].ids.push(entry.bancada_id);
    }
  });

  const result: Record<string, DuplicateInfo> = {};
  Object.entries(grouped).forEach(([key, data]) => {
    let message = "Este medidor existe en otra bancada de esta misma OI.";
    if (data.items.length > 0) {
      const items = [...data.items].sort((a, b) => a - b).join(", ");
      message = `Este medidor existe en la bancada #${items} de esta misma OI.`;
    }
    result[key] = {
      message,
      bancadaItem: data.items[0],
      bancadaId: data.ids[0],
    };
  });

  return result;
};

const EXIT_WARNING_MESSAGE =
  "Tienes una OI abierta en edicion. Cierra la OI antes de salir. Deseas salir de todas formas?";

type BlockerTx = {
  retry: () => void;
  location: { pathname: string; search?: string; hash?: string };
};

const useBlocker = (blocker: (tx: BlockerTx) => void, when = true) => {
  const navigationContext = useContext(UNSAFE_NavigationContext) as { navigator?: any };
  const navigator = navigationContext?.navigator;

  useEffect(() => {
    if (!when) return;
    if (!navigator || typeof navigator.block !== "function") return;

    const unblock = navigator.block((tx: BlockerTx) => {
      const autoUnblockingTx = {
        ...tx,
        retry() {
          unblock();
          tx.retry();
        },
      };
      blocker(autoUnblockingTx);
    });
    return unblock;
  }, [navigator, blocker, when]);
};

const buildApiUrl = (path: string) => {
  const base = api.defaults.baseURL ?? (typeof window !== "undefined" ? window.location.origin : "");
  return `${String(base).replace(/\/$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
};

const useNetworkStatus = () => {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true
  );

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return isOnline;
};

const isNetworkError = (e: any) => {
  const status = e?.status ?? e?.response?.status;
  if (status) return false;
  const code = e?.code ?? e?.name;
  if (code === "ERR_NETWORK" || code === "ECONNABORTED") return true;
  return !e?.response;
};

export default function OiPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { oiId: oiIdParam } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const isOnline = useNetworkStatus();
  const { data } = useQuery<Catalogs>({ queryKey: ["catalogs"], queryFn: getCatalogs });
  const { register, handleSubmit, watch, formState:{errors}, reset, getValues } = useForm<OIFormInput, unknown, OIForm>({
    resolver: zodResolver(OISchema),
    defaultValues: {
      oi: `OI-0001-${new Date().getFullYear()}`,
      numeration_type: "correlativo",
      pma: 16,
      q3: 2.5,
      alcance: 80,
    },
  });
  const auth = getAuth();
  const authUserId = auth?.userId ?? null;
  const bankId = auth?.bancoId ?? getSelectedBank();
  const isAdmin = normalizeRole(auth?.role, auth?.username) !== "technician";
  const storedCurrent = loadCurrentOI();
  const parsedOiId = oiIdParam ? Number(oiIdParam) : null;
  const oiIdFromRoute = Number.isFinite(parsedOiId) ? parsedOiId : null;
  const hasExistingOi = oiIdFromRoute != null || (storedCurrent?.id ?? null) != null;
  const rawMode = (searchParams.get("mode") || "").toLowerCase();
  const mode = resolveMode(rawMode, hasExistingOi);
  const isViewMode = mode === "view";
  const isEditMode = mode === "edit";
  const [busy, setBusy] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [lockedByName, setLockedByName] = useState<string | null>(null);
  const [lockedByUserId, setLockedByUserId] = useState<number | null>(null);
  const [hasLock, setHasLock] = useState(false);
  const isReadOnly = readOnly || isViewMode;
  
  const [isEditingOI, setIsEditingOI] = useState(false);
  const [originalOI, setOriginalOI] = useState<OIForm | null>(null);
  const [oiSavedAt, setOiSavedAt] = useState<string | null>(null);
  const [oiCreatedAt, setOiCreatedAt] = useState<string | null>(null);
  const [showSavedAtModal, setShowSavedAtModal] = useState(false);
  const [savedAtInput, setSavedAtInput] = useState("");
  const [savedAtTarget, setSavedAtTarget] = useState<BancadaRead | null>(null);
  const [savedAtScope, setSavedAtScope] = useState<"oi" | "bancada">("bancada");
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [pendingBancadaSave, setPendingBancadaSave] = useState(false);
  const [pendingAuthAction, setPendingAuthAction] = useState<PendingAction | null>(null);
  const originalBancadasRef = useRef<BancadaRead[]>([]);
  const originalOiUpdatedAtRef = useRef<string | null>(null);
  const skipExitWarnRef = useRef(false);
  const didSendCloseRef = useRef(false);
  const pendingHeaderSaveRef = useRef(false);
  const headerDraftTimerRef = useRef<number | null>(null);
  const headerDraftRestoredRef = useRef(false);
  const wasOnlineRef = useRef(isOnline);
  const pendingAuthNotifiedRef = useRef(false);
  const restoreIntentHandledRef = useRef(false);

  // Id del OI creado y lista local de bancadas
  const [oiId, setOiId] = useState<number | null>(null);
  // Marca de tiempo de la última versión conocida de la OI (para control optimista)
  const [oiVersion, setOiVersion] = useState<string | null>(null);
  const [bancadas, setBancadas] = useState<BancadaRead[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<BancadaRead | null>(null);
  const [showPwd, setShowPwd] = useState(false);
  const [medidoresUsuarioApi, setMedidoresUsuarioApi] = useState<number | null>(null);
  const [medidoresTotalCode, setMedidoresTotalCode] = useState(0);
  const [duplicateMap, setDuplicateMap] = useState<Record<string, DuplicateInfo>>({});

  // Borradores temporales de bancadas (por id o "new")
  const [bancadaDrafts, setBancadaDrafts] = useState<Record<string, BancadaForm>>({});

  const returnTo = (location.state as { returnTo?: string } | null)?.returnTo;
  const getReturnTo = () =>
    typeof returnTo === "string" && returnTo ? returnTo : "/oi/list";
  const setModeParam = (nextMode: "view" | "edit") => {
    const next = new URLSearchParams(searchParams);
    next.set("mode", nextMode);
    setSearchParams(next, { replace: true });
  };

  const NEW_BANCADA_DRAFT_KEY = "new";
  const DEFAULT_BANCADA_ROWS = 15;
  const getDraftKey = (row: BancadaRead | null) =>
  row ? `bancada-${row.id}` : NEW_BANCADA_DRAFT_KEY;

  const isMeaningfulDraftValue = (value: unknown) => {
    if (value === null || value === undefined) return false;
    if (typeof value === "string") return value.trim() !== "";
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "boolean") return true;
    return true;
  };

  const isDraftKeyIgnored = (key: string) =>
    key === "c7_seconds" || key === "caudal" || key === "error";

  const hasAnyBlockValue = (block?: Record<string, unknown> | null) => {
    if (!block) return false;
    return Object.entries(block).some(([key, value]) => {
      if (isDraftKeyIgnored(key)) return false;
      return isMeaningfulDraftValue(value);
    });
  };

  const hasBancadaDraftContent = (draft: BancadaForm | null) => {
    if (!draft || !Array.isArray(draft.rowsData)) return false;
    return draft.rowsData.some((row) => {
      if (!row) return false;
      const estado = Number((row as any).estado ?? 0);
      if (estado !== 0) return true;
      const medidor = (row as any).medidor;
      if (typeof medidor === "string" && medidor.trim() !== "") return true;
      return (
        hasAnyBlockValue((row as any).q3) ||
        hasAnyBlockValue((row as any).q2) ||
        hasAnyBlockValue((row as any).q1)
      );
    });
  };

  const buildEmptyRows = (count = DEFAULT_BANCADA_ROWS): BancadaRowForm[] =>
    Array.from({ length: count }).map(() => ({
      medidor: "",
      estado: 0,
      q3: {},
      q2: {},
      q1: {},
    }));

  const makeDraftId = () => {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
    return `draft-${Date.now()}`;
  };

  const createNewBancadaDraft = (createdAt?: string): BancadaForm => ({
    draftId: makeDraftId(),
    draftCreatedAt: createdAt ?? new Date().toISOString(),
    estado: 0,
    rows: DEFAULT_BANCADA_ROWS,
    rowsData: buildEmptyRows(),
    version: null,
  });

  const buildReturnTo = (targetId?: number | null) => {
    const params = new URLSearchParams(location.search);
    params.set("mode", "edit");
    const basePath =
      location.pathname === "/oi" || location.pathname === "/oi/"
        ? targetId
          ? `/oi/${targetId}`
          : "/oi"
        : location.pathname;
    const qs = params.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  const buildRecoveryContext = (targetId: number | null, modal?: RecoveryModal): RecoveryContext | null => {
    if (!targetId || !authUserId || bankId == null) return null;
    return {
      version: 1,
      ts: new Date().toISOString(),
      userId: authUserId,
      bankId,
      oiId: targetId,
      oiCode: getValues("oi") ?? null,
      returnTo: buildReturnTo(targetId),
      mode: "edit",
      modal,
    };
  };

  const resolveModalRecovery = (): RecoveryModal | undefined => {
    if (!showModal) return undefined;
    return editing
      ? { type: "bancada", bancadaId: editing.id }
      : { type: "bancada", isNew: true };
  };

  const getNewDraftStorageKey = (id: number | null) =>
    buildDraftKey({
      userId: authUserId,
      bankId,
      oiId: id,
      type: "bancada",
      isNew: true,
    });

  const loadNewBancadaDraft = (id: number | null): BancadaForm | null => {
    const key = getNewDraftStorageKey(id);
    if (!key) return null;
    const envelope = loadDraft<BancadaForm>(key);
    if (!envelope || !authUserId || bankId == null || !id) return null;
    if (envelope.userId !== authUserId || envelope.bankId !== bankId || envelope.oiId !== id) {
      return null;
    }
    const draft = envelope?.data ?? null;
    if (!hasBancadaDraftContent(draft)) {
      clearDraft(key);
      return null;
    }
    return draft;
  };

  const persistNewBancadaDraft = (id: number | null, draft: BancadaForm | null) => {
    const key = getNewDraftStorageKey(id);
    if (!key) return;
    if (!draft || !hasBancadaDraftContent(draft)) {
      clearDraft(key);
      return;
    }
    if (!authUserId || bankId == null || !id) return;
    const envelope: DraftEnvelope<BancadaForm> = {
      version: 1,
      ts: new Date().toISOString(),
      userId: authUserId,
      bankId,
      oiId: id,
      isNew: true,
      data: draft,
    };
    const recovery = buildRecoveryContext(id, { type: "bancada", isNew: true });
    saveDraft(key, envelope, recovery);
  };

  const getHeaderDraftStorageKey = (id: number | null) =>
    buildDraftKey({
      userId: authUserId,
      bankId,
      oiId: id,
      type: "header",
    });

  const loadHeaderDraft = (key: string | null) => {
    if (!key) return null;
    const envelope = loadDraft<Partial<OIFormInput>>(key);
    if (!envelope || !authUserId || bankId == null) return null;
    if (envelope.userId !== authUserId || envelope.bankId !== bankId) return null;
    if (oiId != null && envelope.oiId !== oiId) return null;
    return envelope?.data ?? null;
  };

  const persistHeaderDraft = (key: string | null, data: Partial<OIFormInput>) => {
    if (!key || !authUserId || bankId == null) return;
    const oiIdValue = oiId ?? 0;
    const envelope: DraftEnvelope<Partial<OIFormInput>> = {
      version: 1,
      ts: new Date().toISOString(),
      userId: authUserId,
      bankId,
      oiId: oiIdValue,
      data,
    };
    const recovery = buildRecoveryContext(oiId, resolveModalRecovery());
    saveDraft(key, envelope, recovery);
  };

  const clearHeaderDraft = (key: string | null) => {
    if (!key) return;
    clearDraft(key);
  };

  const buildHeaderDraftData = (value: Partial<OIFormInput>) => {
    const data: Partial<OIFormInput> = {};
    if (value.q3 != null) data.q3 = Number(value.q3);
    if (value.alcance != null) data.alcance = Number(value.alcance);
    if (value.pma != null) data.pma = Number(value.pma);
    if (value.numeration_type) data.numeration_type = value.numeration_type;
    return data;
  };

  const getBancadaDraftStorageKey = (id: number | null, bancadaId: number | null) =>
    buildDraftKey({
      userId: authUserId,
      bankId,
      oiId: id,
      type: "bancada",
      bancadaId,
    });

  const loadBancadaDraft = (id: number | null, bancadaId: number | null) => {
    const key = getBancadaDraftStorageKey(id, bancadaId);
    if (!key) return null;
    const envelope = loadDraft<BancadaForm>(key);
    if (!envelope || !authUserId || bankId == null || !id || !bancadaId) return null;
    if (envelope.userId !== authUserId || envelope.bankId !== bankId || envelope.oiId !== id) {
      return null;
    }
    const draft = envelope?.data ?? null;
    if (!hasBancadaDraftContent(draft)) {
      clearDraft(key);
      return null;
    }
    return draft;
  };

  const persistBancadaDraft = (id: number | null, bancadaId: number | null, draft: BancadaForm) => {
    const key = getBancadaDraftStorageKey(id, bancadaId);
    if (!key) return;
    if (!hasBancadaDraftContent(draft)) {
      clearDraft(key);
      return;
    }
    if (!authUserId || bankId == null || !id || !bancadaId) return;
    const envelope: DraftEnvelope<BancadaForm> = {
      version: 1,
      ts: new Date().toISOString(),
      userId: authUserId,
      bankId,
      oiId: id,
      bancadaId,
      data: draft,
    };
    const recovery = buildRecoveryContext(id, { type: "bancada", bancadaId });
    saveDraft(key, envelope, recovery);
  };

  const clearBancadaDraft = (id: number | null, bancadaId: number | null) => {
    const key = getBancadaDraftStorageKey(id, bancadaId);
    if (!key) return;
    clearDraft(key);
  };

  const headerDraftKey = getHeaderDraftStorageKey(oiId);


  // Set defaults de selects al cargar catálogos
  useEffect(() => {
    if (data) {
      reset(v => ({ ...v, q3: data.q3[0], alcance: data.alcance[0], pma: 16 }));
    }
  }, [data, reset]);

  // Al montar: si hay un OI activo (ruta o sesi?n), cargarlo (incluye bancadas)
  useEffect(() => {
    const stored = loadCurrentOI();
    const targetId = oiIdFromRoute ?? stored?.id ?? null;
    if (!targetId) {
      setOiId(null);
      setBancadas([]);
      originalBancadasRef.current = [];
      originalOiUpdatedAtRef.current = null;
      setMedidoresUsuarioApi(null);
      setMedidoresTotalCode(0);
      setOiVersion(null);
      setOiSavedAt(null);
      setOiCreatedAt(null);
      setIsEditingOI(false);
      setReadOnly(false);
      setLockedByName(null);
      setLockedByUserId(null);
      setHasLock(false);
      setOriginalOI(null);
      return;
    }
    (async () => {
      try {
        const full = await getOiFull(targetId);
        setOiId(full.id);
        saveCurrentOI({ id: full.id, code: full.code });
        setBancadas(full.bancadas ?? []);
        originalBancadasRef.current = cloneBancadas(full.bancadas ?? []);
        originalOiUpdatedAtRef.current = full.updated_at ?? null;
        setMedidoresUsuarioApi(full.medidores_usuario ?? null);
        setMedidoresTotalCode(full.medidores_total_code ?? 0);
        setOiSavedAt(full.saved_at ?? null);
        setOiCreatedAt(full.created_at ?? null);
        // Guardamos la versi?n (updated_at o, en su defecto, created_at)
        setOiVersion(full.updated_at ?? full.created_at);
        const initial: OIForm = {
          oi: full.code,
          q3: full.q3,
          alcance: full.alcance,
          pma: full.pma,
          numeration_type: full.numeration_type ?? "correlativo",
        };
        reset(initial);
        setIsEditingOI(false);
        setReadOnly(full.read_only_for_current_user ?? false);
        setLockedByName(full.locked_by_full_name ?? null);
        setLockedByUserId(full.locked_by_user_id ?? null);
        setHasLock((full.locked_by_user_id ?? null) === authUserId);
        setOriginalOI(initial);
      } catch {
        clearCurrentOI();
      }
    })();
  }, [reset, authUserId, oiIdFromRoute]);

  useEffect(() => {
    if (!oiId) return;
    if (bancadaDrafts[NEW_BANCADA_DRAFT_KEY]) return;
    const storedDraft = loadNewBancadaDraft(oiId);
    if (!storedDraft) return;
    setBancadaDrafts((prev) => ({ ...prev, [NEW_BANCADA_DRAFT_KEY]: storedDraft }));
    toast({ kind: "info", message: "Se restauro un borrador local." });
  }, [oiId, bancadaDrafts, toast]);

  // Lock de OI para t?cnicos: intenta tomar o refrescar lock al abrir la pantalla
  useEffect(() => {
    if (!oiId || !authUserId || !isEditMode) return;
    let cancelled = false;
    (async () => {
      const applyLockInfo = (res: any) => {
        setReadOnly(res?.read_only_for_current_user ?? false);
        setLockedByName(res?.locked_by_full_name ?? null);
        setLockedByUserId(res?.locked_by_user_id ?? null);
        setHasLock((res?.locked_by_user_id ?? null) === authUserId);
      };
      try {
        const res = await lockOi(oiId);
        if (cancelled) return;
        applyLockInfo(res);
      } catch (e: any) {
        if (cancelled) return;
        const status = e?.status ?? e?.response?.status;
        let lockedName: string | null = null;
        try {
          const full = await getOiFull(oiId);
          if (cancelled) return;
          lockedName = full.locked_by_full_name ?? null;
          applyLockInfo({
            read_only_for_current_user: true,
            locked_by_full_name: lockedName,
            locked_by_user_id: full.locked_by_user_id ?? null,
          });
        } catch {
          setReadOnly(true);
          setHasLock(false);
        }
        const message =
          lockedName
            ? `La OI est? siendo editada por ${lockedName}. Se abre en modo lectura.`
            : e?.message ?? "La OI est? siendo editada por otro usuario. Int?ntelo m?s tarde.";
        toast({
          kind: status === 423 || status === 409 ? "warning" : "error",
          title: status === 423 || status === 409 ? "OI bloqueada" : "Error",
          message,
        });
        setReadOnly(true);
        setHasLock(false);
        if (rawMode !== "view") {
          setModeParam("view");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [oiId, authUserId, isEditMode]);

  // Libera lock al desmontar si lo posee el usuario actual
  useEffect(() => {
    return () => {
      if (oiId && hasLock) {
        unlockOi(oiId).catch(() => undefined);
      }
    };
  }, [oiId, hasLock]);

  // Marca el OI con lock activo para cierre automático en logout (best-effort)
  useEffect(() => {
    if (!oiId) return;
    if (!hasLock || isReadOnly || !isEditMode) return;
    setOpenOiId(oiId);
  }, [hasLock, oiId, isReadOnly, isEditMode]);

  useEffect(() => {
    didSendCloseRef.current = false;
    pendingHeaderSaveRef.current = false;
    setPendingBancadaSave(false);
    headerDraftRestoredRef.current = false;
    restoreIntentHandledRef.current = false;
  }, [oiId]);

  useEffect(() => {
    if (!wasOnlineRef.current && isOnline) {
      const hasToken = Boolean(getAuth()?.token);
      if (!hasToken) {
        toast({
          kind: "warning",
          message: "Conexion restablecida, pero debes iniciar sesion para guardar.",
        });
        wasOnlineRef.current = isOnline;
        return;
      }
      if (pendingHeaderSaveRef.current || pendingBancadaSave) {
        toast({
          kind: "info",
          message: "Conexion restablecida. Puedes reintentar guardar.",
        });
      }
    }
    wasOnlineRef.current = isOnline;
  }, [isOnline, pendingBancadaSave, toast]);

  useEffect(() => {
    const handler = () => {
      toast({
        kind: "warning",
        message: "Sesion expirada. Inicia sesion para guardar. Tu borrador esta guardado.",
      });
    };
    window.addEventListener("medileser:auth-expired", handler);
    return () => window.removeEventListener("medileser:auth-expired", handler);
  }, [toast]);

  useEffect(() => {
    const pending = getPendingAction();
    if (!pending) {
      setPendingAuthAction(null);
      pendingAuthNotifiedRef.current = false;
      return;
    }
    const currentRoute = `${location.pathname}${location.search}`;
    const matchesRoute = pending.route === currentRoute;
    const matchesOi = pending.oiId == null || pending.oiId === oiId;
    if (!matchesRoute && !matchesOi) {
      setPendingAuthAction(null);
      pendingAuthNotifiedRef.current = false;
      return;
    }
    setPendingAuthAction(pending);
    if (pending.type === "save_bancada") {
      setPendingBancadaSave(true);
    }
    if (pending.type === "save_oi") {
      pendingHeaderSaveRef.current = true;
    }
    if (!pendingAuthNotifiedRef.current) {
      toast({ kind: "info", message: "Sesion restaurada. Reintenta guardar." });
      pendingAuthNotifiedRef.current = true;
    }
  }, [location.pathname, location.search, oiId, toast]);

  const shouldPersistHeaderDraft = isEditMode && !isReadOnly && (isEditingOI || !oiId);

  useEffect(() => {
    if (!shouldPersistHeaderDraft) return;
    if (headerDraftRestoredRef.current) return;
    const stored = loadHeaderDraft(headerDraftKey);
    if (!stored) return;
    const current = getValues();
    reset({
      ...current,
      ...stored,
      numeration_type: stored.numeration_type ?? current.numeration_type ?? "correlativo",
    });
    headerDraftRestoredRef.current = true;
    toast({ kind: "info", message: "Se restauro un borrador local." });
  }, [shouldPersistHeaderDraft, headerDraftKey, getValues, reset, toast]);

  useEffect(() => {
    if (!shouldPersistHeaderDraft) return;
    const subscription = watch((value) => {
      if (headerDraftTimerRef.current) {
        window.clearTimeout(headerDraftTimerRef.current);
      }
      headerDraftTimerRef.current = window.setTimeout(() => {
        persistHeaderDraft(headerDraftKey, buildHeaderDraftData(value));
      }, 400);
    });
    return () => {
      subscription.unsubscribe();
      if (headerDraftTimerRef.current) {
        window.clearTimeout(headerDraftTimerRef.current);
      }
    };
  }, [watch, shouldPersistHeaderDraft, headerDraftKey]);

  const hasDrafts = useMemo(() => Object.keys(bancadaDrafts).length > 0, [bancadaDrafts]);
  const shouldWarnOnExit = isEditMode && !isReadOnly && (hasLock || isEditingOI || hasDrafts);

  useEffect(() => {
    if (!shouldWarnOnExit) return;
    const handler = (e: BeforeUnloadEvent) => {
      if (skipExitWarnRef.current) return;
      e.preventDefault();
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [shouldWarnOnExit]);

  useBlocker((tx) => {
    if (!shouldWarnOnExit) {
      tx.retry();
      return;
    }
    if (skipExitWarnRef.current) {
      tx.retry();
      return;
    }
    if (tx.location.pathname === location.pathname) {
      tx.retry();
      return;
    }
    if (window.confirm(EXIT_WARNING_MESSAGE)) {
      tx.retry();
    }
  }, shouldWarnOnExit);

  useEffect(() => {
    if (!oiId || !hasLock || isReadOnly || !isEditMode) return;
    const releaseLockBestEffort = () => {
      if (skipExitWarnRef.current || didSendCloseRef.current) return;
      didSendCloseRef.current = true;
      const token = getAuth()?.token;
      const url = buildApiUrl(`/oi/${oiId}/close`);
      fetch(url, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        keepalive: true,
      }).catch(() => undefined);
    };
    const handlePageHide = () => {
      releaseLockBestEffort();
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [oiId, hasLock, isReadOnly, isEditMode]);

  const pma = watch("pma");
  const presion = useMemo(() => pressureFromPMA(Number(pma)), [pma]);
  const numerationType = watch("numeration_type") ?? "correlativo";


  const onSubmitCreate = async (v: OIForm): Promise<boolean> => {
    try {
      setBusy(true);
      const auth = getAuth();
      if (!auth) throw new Error("Sesión no válida");
      const bancoId = auth.bancoId;
      if (bancoId == null) throw new Error("Debe seleccionar un banco para crear una OI.");
      const payload = {
        code: v.oi,
        q3: Number(v.q3),
        alcance: Number(v.alcance),
        pma: Number(v.pma),
        banco_id: bancoId,
        tech_number: auth.techNumber,
        numeration_type: v.numeration_type ?? "correlativo",
      };
      const created = await createOI(payload);
      setOiId(created.id);
      setOiVersion(created.updated_at ?? created.created_at);
      setMedidoresUsuarioApi(created.medidores_usuario ?? 0);
      setMedidoresTotalCode(created.medidores_total_code ?? 0);
      setOiSavedAt(created.saved_at ?? null);
      setOiCreatedAt(created.created_at ?? null);
      saveCurrentOI({ id: created.id, code: created.code });
      setOriginalOI(v);

      pendingHeaderSaveRef.current = false;
      clearHeaderDraft(getHeaderDraftStorageKey(null));
      clearHeaderDraft(getHeaderDraftStorageKey(created.id));
      clearPendingAction();
      setPendingAuthAction(null);
      
      toast({ kind: "success", title: "OI creada", message: `${created.code} (#${created.id})` });
      return true;
    } catch (e: any) {
      if (isNetworkError(e)) {
        pendingHeaderSaveRef.current = true;
        persistHeaderDraft(headerDraftKey, buildHeaderDraftData(v));
        toast({
          kind: "warning",
          title: "Sin conexion",
          message: "Sin conexion. Cambios guardados localmente. Reintenta al reconectar.",
        });
        return false;
      }
      if (isAuthExpiredError(e)) {
        pendingHeaderSaveRef.current = true;
        persistHeaderDraft(headerDraftKey, buildHeaderDraftData(v));
        return false;
      }
      toast({ kind:"error", title:"Error", message: e?.message ?? "Error creando OI" });
      return false;
    }
     finally { setBusy(false); }
  };

  const onSubmitUpdate = async (v: OIForm): Promise<boolean> => {
    if (!oiId) return false;
    if (isReadOnly) {
      toast({ kind: "warning", title: "Solo lectura", message: "La OI está bloqueada por otro usuario." });
      return false;
    }
    try {
      setBusy(true);
      if (!oiId) {
        throw new Error("No hay OI seleccionada para actualizar.");
      }
      const trimmedCode = v.oi?.trim();
      const normalizedNumeration = v.numeration_type ?? "correlativo";
      const originalNumeration = originalOI?.numeration_type ?? "correlativo";
      const hasHeaderChanges =
        !originalOI ||
        Number(v.q3) !== Number(originalOI.q3) ||
        Number(v.alcance) !== Number(originalOI.alcance) ||
        Number(v.pma) !== Number(originalOI.pma) ||
        normalizedNumeration !== originalNumeration;
      const codeChanged = isAdmin && !!trimmedCode && trimmedCode !== (originalOI?.oi ?? "");
      const shouldUpdateHeader = !codeChanged || hasHeaderChanges;

      const applyUpdatedState = (next: OIRead) => {
        setOiVersion(next.updated_at ?? next.created_at);
        setOiSavedAt(next.saved_at ?? null);
        setOiCreatedAt(next.created_at ?? null);
        if (next.code) {
          saveCurrentOI({ id: next.id, code: next.code });
        }
        setLockedByUserId(next.locked_by_user_id ?? null);
        setLockedByName(next.locked_by_full_name ?? null);
        setReadOnly(next.read_only_for_current_user ?? false);
        setHasLock((next.locked_by_user_id ?? null) === authUserId);
      };

      let updated: OIRead | null = null;

      if (shouldUpdateHeader) {
        if (!oiVersion) {
          throw new Error("No se pudo determinar la version actual de la OI. Recargue la pagina e intentelo de nuevo.");
        }
        const updatePayload: OIUpdatePayload = {
          q3: Number(v.q3),
          alcance: Number(v.alcance),
          pma: Number(v.pma),
          numeration_type: normalizedNumeration,
          updated_at: oiVersion,
        };
        updated = await updateOI(oiId, updatePayload);
        applyUpdatedState(updated);
      }

      if (codeChanged && trimmedCode) {
        try {
          const patched = await patchOiCode(oiId, trimmedCode);
          updated = patched;
          applyUpdatedState(patched);
        } catch (e: any) {
          if (isNetworkError(e) || isAuthExpiredError(e)) {
            throw e;
          }
          const status = e?.status ?? e?.response?.status;
          if (status === 409) {
            toast({
              kind: "error",
              title: "Conflicto",
              message: "Ya existe una OI con ese codigo.",
            });
          } else if (status === 403) {
            toast({
              kind: "error",
              title: "No autorizado",
              message: "No autorizado.",
            });
          } else if (status === 422 || status === 400) {
            toast({
              kind: "error",
              title: "Formato",
              message: "Formato de OI invalido. Debe ser OI-####-YYYY.",
            });
          } else {
            toast({ kind: "error", title: "Error", message: e?.message ?? "Error actualizando OI" });
          }
          return false;
        }
      }

      if (!updated) {
        setIsEditingOI(false);
        pendingHeaderSaveRef.current = false;
        clearHeaderDraft(headerDraftKey);
        clearPendingAction();
        setPendingAuthAction(null);
        toast({ kind: "success", title: "OI actualizada", message: v.oi });
        return true;
      }

      setOriginalOI({ ...v, oi: updated.code, numeration_type: normalizedNumeration });
      setIsEditingOI(false);
      pendingHeaderSaveRef.current = false;
      clearHeaderDraft(headerDraftKey);
      clearPendingAction();
      setPendingAuthAction(null);
      toast({ kind: "success", title: "OI actualizada", message: updated.code ?? v.oi });
      return true;
    } catch (e: any) {
      if (isNetworkError(e)) {
        pendingHeaderSaveRef.current = true;
        persistHeaderDraft(headerDraftKey, buildHeaderDraftData(v));
        toast({
          kind: "warning",
          title: "Sin conexion",
          message: "Sin conexion. Cambios guardados localmente. Reintenta al reconectar.",
        });
        return false;
      }
      if (isAuthExpiredError(e)) {
        pendingHeaderSaveRef.current = true;
        persistHeaderDraft(headerDraftKey, buildHeaderDraftData(v));
        return false;
      }
      const status = e?.status ?? e?.response?.status;
      if (status === 409) {
        toast({
          kind: "error",
          title: "Conflicto",
          message: "La OI fue modificada por otro usuario. Recargue la página y vuelva a intentar.",
        });
      } else {
        toast({ kind:"error", title:"Error", message: e?.message ?? "Error actualizando OI" });
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const isEditingExisting = !!oiId && isEditingOI && !isReadOnly;

  const clearDuplicateMap = () => setDuplicateMap({});
  const clearDuplicateForMedidor = (value?: string | null) => {
    const key = normalizeMedidorKey(value);
    if (!key) return;
    setDuplicateMap((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  

  const openNew = () => {
    if (isReadOnly) {
      toast({ kind: "warning", title: "Solo lectura", message: "No puede agregar bancadas mientras la OI está bloqueada." });
      return;
    }
    if (!oiId) return;
    clearDuplicateMap();
    setPendingBancadaSave(false);
    const stored = loadNewBancadaDraft(oiId);
    const draft = stored ?? createNewBancadaDraft();
    setBancadaDrafts((prev) => ({ ...prev, [NEW_BANCADA_DRAFT_KEY]: draft }));
    persistNewBancadaDraft(oiId, draft);
    if (stored) {
      toast({ kind: "info", message: "Se restauro un borrador local." });
    }
    setEditing(null);
    setShowModal(true);
  };
  const openEdit = (row: BancadaRead) => {
    if (isReadOnly && !isViewMode) {
      toast({ kind: "warning", title: "Solo lectura", message: "No puede editar bancadas mientras la OI est? bloqueada." });
      return;
    }
    clearDuplicateMap();
    setPendingBancadaSave(false);
    const stored = loadBancadaDraft(oiId, row.id);
    if (stored) {
      const key = getDraftKey(row);
      setBancadaDrafts((prev) => ({ ...prev, [key]: stored }));
      toast({ kind: "info", message: "Se restauro un borrador local." });
    }
    setEditing(row);
    setShowModal(true);
  };

  useEffect(() => {
    if (!oiId || restoreIntentHandledRef.current) return;
    const intent = getRestoreIntent();
    if (!intent) return;
    if (!authUserId || bankId == null) return;
    if (intent.userId !== authUserId || intent.bankId !== bankId) return;
    if (intent.oiId !== oiId) return;
    if (intent.modal?.type === "bancada") {
      if (intent.modal.isNew) {
        restoreIntentHandledRef.current = true;
        clearRestoreIntent();
        openNew();
        return;
      }
      if (intent.modal.bancadaId) {
        const row = bancadas.find((item) => item.id === intent.modal?.bancadaId);
        if (!row) return;
        restoreIntentHandledRef.current = true;
        clearRestoreIntent();
        openEdit(row);
        return;
      }
    }
    restoreIntentHandledRef.current = true;
    clearRestoreIntent();
  }, [authUserId, bankId, bancadas, oiId, openNew, openEdit]);

    const editingInitial = useMemo(() => {
    const key = getDraftKey(editing);
    const draft = bancadaDrafts[key];

    // Si hay borrador en memoria (nueva o existente), lo usamos primero
    if (draft) {
      const version = draft.version ?? editing?.updated_at ?? editing?.created_at ?? null;
      return { ...draft, version };
    }

    // Nueva bancada sin borrador: que la modal use sus defaults internos
    if (!editing) return undefined;

    // Bancada existente sin borrador: construir a partir de lo que viene del backend
    const resolvedRows = resolveEditingRows(editing);
    const rowsData = resolvedRows.map(apiRowToForm);
    return {
      estado: editing.estado,
      rows: rowsData.length || editing.rows,
      rowsData,
      version: editing.updated_at ?? editing.created_at ?? null,
    };
  }, [editing, bancadaDrafts]);


  const handleSaveBancada = async (form: BancadaForm) => {
    if (!oiId) return;
    if (isReadOnly) {
      toast({ kind: "warning", title: "Solo lectura", message: "No puede guardar bancadas mientras la OI está bloqueada." });
      return;
    }
    clearDuplicateMap();
    setPendingBancadaSave(false);
    try {
      setBusy(true);

      const draftCreatedAt = form.draftCreatedAt ?? bancadaDrafts[NEW_BANCADA_DRAFT_KEY]?.draftCreatedAt;
      // Normalizamos las filas antes de enviarlas a la API
      const payload: BancadaCreate = {
        estado: Number(form.estado ?? 0),
        rows: Number(form.rowsData.length),
        rows_data: form.rowsData.map(formRowToApi),
      };

      if (editing) {
        const expectedVersion = form.version ?? editing.updated_at ?? editing.created_at ?? null;
        if (!expectedVersion) {
          throw new Error("No se pudo determinar la versión actual de la bancada. Recargue y vuelva a intentar.");
        }
        const updPayload: BancadaUpdatePayload = { ...payload, updated_at: expectedVersion };
        const upd = await updateBancada(editing.id, updPayload);
        setBancadas(prev => prev.map(x => (x.id === upd.id ? upd : x)));
        setOiVersion(upd.updated_at ?? upd.created_at ?? oiVersion);
        setMedidoresUsuarioApi(null);
        clearBancadaDraft(oiId, editing.id);
        // Limpiar borrador de esta bancada editada
        setBancadaDrafts(prev => {
          const key = `bancada-${editing.id}`;
          const { [key]: _, ...rest } = prev;
          return rest;
        });
        toast({ kind: "success", message: "Bancada actualizada" });
      } else {
        if (draftCreatedAt) {
          payload.draft_created_at = draftCreatedAt;
        }
        const created = await addBancada(oiId, payload);
        setBancadas(prev => [...prev, created]);
        setOiVersion(created.updated_at ?? created.created_at ?? oiVersion);
        setMedidoresUsuarioApi(null);
        // Limpiar borrador de "nueva bancada"
        setBancadaDrafts(prev => {
          const { new: _, ...rest } = prev;
          return rest;
        });
        persistNewBancadaDraft(oiId, null);
        toast({ kind: "success", message: "Bancada agregada" });
      }

      try {
        const refreshed = await getOi(oiId);
        setMedidoresUsuarioApi(refreshed.medidores_usuario ?? null);
        setMedidoresTotalCode(refreshed.medidores_total_code ?? medidoresTotalCode);
        setOiSavedAt(refreshed.saved_at ?? null);
        setOiCreatedAt(refreshed.created_at ?? null);
      } catch {
        // ignore
      }

      // ✅ Cerrar la modal tras guardar correctamente
      setLockedByUserId(auth?.userId ?? lockedByUserId);
      setLockedByName(auth?.fullName ?? lockedByName);
      setHasLock(authUserId !== null);
      setReadOnly(false);

      setShowModal(false);
      setEditing(null);
      clearPendingAction();
      setPendingAuthAction(null);
      setPendingBancadaSave(false);

    } catch (e: any) {
      if (isNetworkError(e)) {
        if (editing) {
          persistBancadaDraft(oiId, editing.id, form);
        } else {
          persistNewBancadaDraft(oiId, form);
        }
        setPendingBancadaSave(true);
        toast({
          kind: "warning",
          title: "Sin conexion",
          message: "Sin conexion. La bancada se guardo localmente. Reintenta cuando vuelva la red.",
        });
        return;
      }
      if (isAuthExpiredError(e)) {
        if (editing) {
          persistBancadaDraft(oiId, editing.id, form);
        } else {
          persistNewBancadaDraft(oiId, form);
        }
        setPendingBancadaSave(true);
        return;
      }
      const status = e?.status ?? e?.response?.status;
      if (status === 409) {
        toast({
          kind: "error",
          title: "Conflicto",
          message: "La bancada fue modificada por otro usuario. Recargue la página y vuelva a intentar.",
        });
      } else if (status === 400) {
        const duplicates = Array.isArray(e?.duplicates)
          ? e.duplicates
          : Array.isArray(e?.response?.data?.duplicates)
            ? e.response.data.duplicates
            : [];
        if (duplicates.length > 0) {
          setDuplicateMap(buildDuplicateMap(duplicates));
        }
        toast({
          kind: "warning",
          title: "Validacion",
          message: e?.message ?? "Error guardando bancada",
        });
      } else {
        toast({
          kind: "error",
          title: "Error",
          message: e?.message ?? "Error guardando bancada",
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (row: BancadaRead) => {
    if (!confirm(`Eliminar bancada #${row.item}?`)) return;
    if (isReadOnly) {
      toast({ kind: "warning", title: "Solo lectura", message: "No puede eliminar bancadas mientras la OI está bloqueada." });
      return;
    }
    try {
      setBusy(true);
      if (!oiId) {
        throw new Error("No hay OI cargada.");
      }
      await deleteBancada(row.id);
      setBancadas(prev => prev.filter(x => x.id !== row.id));
      setMedidoresUsuarioApi(null);
      setBancadaDrafts(prev => {
        const key = `bancada-${row.id}`;
        const { [key]: _, ...rest } = prev;
        return rest;
      });
      clearBancadaDraft(oiId, row.id);
      const refreshed = await getOi(oiId);
      setOiVersion(refreshed.updated_at ?? refreshed.created_at ?? null);
      setOiSavedAt(refreshed.saved_at ?? null);
      setOiCreatedAt(refreshed.created_at ?? null);
      setLockedByUserId(refreshed.locked_by_user_id ?? null);
      setLockedByName(refreshed.locked_by_full_name ?? null);
      setReadOnly(refreshed.read_only_for_current_user ?? false);
      setHasLock((refreshed.locked_by_user_id ?? null) === authUserId);
      setMedidoresUsuarioApi(refreshed.medidores_usuario ?? null);
      setMedidoresTotalCode(refreshed.medidores_total_code ?? medidoresTotalCode);

      toast({ kind:"success", message:`Bancada #${row.item} eliminada` });
    } catch (e: any) {
      toast({ kind:"error", title:"Error", message: e?.message ?? "Error eliminando bancada" });
    }
    finally { setBusy(false); }
  };

  const handleExcelClick = () => {
    if (!oiId) {
      toast({ kind: "warning", message: "Primero guarda el OI." });
      return;
    }
    setShowPwd(true);
  };

  const handleExcelConfirmed = async (password: string) => {
    if (!oiId) return;
    try {
      setBusy(true);
      await generateExcel(oiId, password);
      toast({ kind: "success", message: "Excel generado" });
    } catch (e: any) {
      // 422 (listas E4/O4 no coinciden) vendrá como mensaje en e.message
      toast({ kind: "error", title: "Error", message: e?.message ?? "Error generando Excel" });
    } finally {
      setBusy(false);
    }
  };

  const handleOpenOiSavedAt = () => {
    if (!oiId || !isAdmin) return;
    const seed = oiSavedAt ?? oiCreatedAt;
    setSavedAtScope("oi");
    setSavedAtTarget(null);
    setSavedAtInput(toDatetimeLocal(seed));
    setShowSavedAtModal(true);
  };

  const handleOpenBancadaSavedAt = (row: BancadaRead) => {
    if (!isAdmin) return;
    setSavedAtScope("bancada");
    setSavedAtTarget(row);
    const seed = row.saved_at ?? row.created_at ?? oiSavedAt ?? oiCreatedAt;
    setSavedAtInput(toDatetimeLocal(seed));
    setShowSavedAtModal(true);
  };

  const handleSaveSavedAt = async () => {
    if (!oiId || !isAdmin) return;
    const nextIso = toUtcNaiveIso(savedAtInput);
    if (!nextIso) {
      toast({ kind: "warning", title: "Fecha", message: "Ingrese una fecha valida." });
      return;
    }
    if (savedAtScope === "bancada" && !savedAtTarget) return;
    try {
      setBusy(true);
      if (savedAtScope === "oi") {
        await updateOiSavedAt(oiId, {
          saved_at: nextIso,
          propagate_to_bancadas: true,
        });
      } else if (savedAtTarget) {
        await updateBancadaSavedAt(savedAtTarget.id, { saved_at: nextIso });
      }
      const refreshed = await getOiFull(oiId);
      setBancadas(refreshed.bancadas ?? []);
      setMedidoresUsuarioApi(refreshed.medidores_usuario ?? null);
      setMedidoresTotalCode(refreshed.medidores_total_code ?? 0);
      setOiSavedAt(refreshed.saved_at ?? null);
      setOiCreatedAt(refreshed.created_at ?? null);
      setOiVersion(refreshed.updated_at ?? refreshed.created_at);
      setLockedByName(refreshed.locked_by_full_name ?? null);
      setLockedByUserId(refreshed.locked_by_user_id ?? null);
      setReadOnly(refreshed.read_only_for_current_user ?? false);
      setHasLock((refreshed.locked_by_user_id ?? null) === authUserId);
      if (!isEditingOI) {
        const nextForm: OIForm = {
          oi: refreshed.code,
          q3: refreshed.q3,
          alcance: refreshed.alcance,
          pma: refreshed.pma,
          numeration_type: refreshed.numeration_type ?? "correlativo",
        };
        reset(nextForm);
        setOriginalOI(nextForm);
      }
      setShowSavedAtModal(false);
      setSavedAtTarget(null);
      setSavedAtInput("");
      setSavedAtScope("bancada");
      toast({ kind: "success", message: "Fecha guardada actualizada" });
    } catch (e: any) {
      toast({ kind: "error", title: "Error", message: e?.message ?? "Error actualizando fecha" });
    } finally {
      setBusy(false);
    }
  };

  const handleBancadaCancel = (draft: BancadaForm) => {
    clearDuplicateMap();
    setPendingBancadaSave(false);
    const key = getDraftKey(editing);
    let nextDraft = { ...draft };
    if (!editing) {
      const existingDraft = bancadaDrafts[NEW_BANCADA_DRAFT_KEY];
      if (!nextDraft.draftCreatedAt) {
        nextDraft.draftCreatedAt = existingDraft?.draftCreatedAt ?? new Date().toISOString();
      }
      if (!nextDraft.draftId) {
        nextDraft.draftId = existingDraft?.draftId ?? makeDraftId();
      }
    }
    setBancadaDrafts(prev => ({ ...prev, [key]: nextDraft }));
    if (!editing) {
      persistNewBancadaDraft(oiId, nextDraft);
    } else {
      persistBancadaDraft(oiId, editing.id, nextDraft);
    }
    setShowModal(false);
  };

  const handleStartEditOI = () => {
    if (isReadOnly) {
      toast({ kind: "warning", title: "Solo lectura", message: "La OI está bloqueada por otro usuario." });
      return;
    }
    const current = getValues();
    // Normalizamos `numeration_type` para que nunca sea undefined
    setOriginalOI({ 
      ...current, 
      numeration_type: current.numeration_type ?? "correlativo",
    });
    setIsEditingOI(true);
  };

  const handleSwitchToEditMode = () => {
    if (!oiId || isEditMode) return;
    setModeParam("edit");
  };

  const handleCancelEditOI = () => {
    if (originalOI) {
      reset(originalOI);
    }
    setIsEditingOI(false);
    pendingHeaderSaveRef.current = false;
    clearHeaderDraft(headerDraftKey);
    clearPendingAction();
    setPendingAuthAction(null);
  };


  const resetOiState = () => {
    if (oiId) {
      persistNewBancadaDraft(oiId, null);
      Object.keys(bancadaDrafts).forEach((key) => {
        if (!key.startsWith("bancada-")) return;
        const id = Number(key.replace("bancada-", ""));
        if (Number.isFinite(id)) {
          clearBancadaDraft(oiId, id);
        }
      });
    }
    clearHeaderDraft(getHeaderDraftStorageKey(oiId));
    clearHeaderDraft(getHeaderDraftStorageKey(null));
    clearRecoveryContext();
    pendingHeaderSaveRef.current = false;
    setPendingBancadaSave(false);
    clearPendingAction();
    setPendingAuthAction(null);
    clearCurrentOI();
    clearOpenOiId();
    setOiId(null);
    setBancadas([]);
    originalBancadasRef.current = [];
    setBancadaDrafts({});
    setIsEditingOI(false);
    setOriginalOI(null);
    setOiVersion(null);
    setOiSavedAt(null);
    setOiCreatedAt(null);
    setReadOnly(false);
    setLockedByName(null);
    setLockedByUserId(null);
    setHasLock(false);
    setMedidoresUsuarioApi(null);
    setMedidoresTotalCode(0);
    setShowModal(false);
    setEditing(null);
    setShowPwd(false);
    setShowSavedAtModal(false);
    setShowCancelModal(false);
    setSavedAtInput("");
    setSavedAtTarget(null);
    setSavedAtScope("bancada");
    // opcional: resetear a defaults
    reset({
      oi: `OI-0001-${new Date().getFullYear()}`,
      q3: data?.q3[0] ?? 2.5,
      alcance: data?.alcance[0] ?? 80,
      pma: 16,
      numeration_type: "correlativo",
    });
  };

  const handleBackToList = () => {
    didSendCloseRef.current = true;
    skipExitWarnRef.current = true;
    resetOiState();
    navigate(getReturnTo());
  };

  const rollbackBancadas = async (): Promise<boolean> => {
    if (!oiId) return true;
    const original = originalBancadasRef.current ?? [];
    if (original.length === 0 && bancadas.length === 0) return true;

    const originalMap = new Map(original.map((b) => [b.id, b]));
    const currentMap = new Map(bancadas.map((b) => [b.id, b]));

    try {
      // Eliminar bancadas nuevas
      for (const current of bancadas) {
        if (!originalMap.has(current.id)) {
          await deleteBancada(current.id);
        }
      }

      // Restaurar bancadas existentes modificadas
      for (const current of bancadas) {
        const orig = originalMap.get(current.id);
        if (!orig) continue;
        if (serializeBancada(orig) === serializeBancada(current)) continue;

        const rowsData = getRowsDataForBancada(orig);
        const rowsCount = rowsData.length || orig.rows || 1;
        const expectedVersion =
          current.updated_at ?? current.created_at ?? orig.updated_at ?? orig.created_at;
        if (!expectedVersion) {
          throw new Error("No se pudo determinar la version de la bancada para revertir cambios.");
        }
        await restoreBancada(current.id, {
          medidor: orig.medidor ?? null,
          estado: orig.estado ?? 0,
          rows: rowsCount,
          rows_data: rowsData,
          current_updated_at: expectedVersion,
          restore_updated_at: orig.updated_at ?? null,
          restore_saved_at: orig.saved_at ?? null,
        });
      }

      // Reponer bancadas eliminadas (item puede variar)
      for (const orig of original) {
        if (!currentMap.has(orig.id)) {
          const rowsData = getRowsDataForBancada(orig);
          const rowsCount = rowsData.length || orig.rows || 1;
          await addBancada(oiId, {
            estado: orig.estado ?? 0,
            rows: rowsCount,
            rows_data: rowsData,
          });
        }
      }

      const latest = await getOi(oiId);
      const currentUpdatedAt = latest.updated_at ?? latest.created_at;
      await restoreOiUpdatedAt(oiId, {
        current_updated_at: currentUpdatedAt,
        restore_updated_at: originalOiUpdatedAtRef.current,
      });
    } catch (e: any) {
      toast({
        kind: "error",
        title: "Error",
        message: e?.message ?? "No se pudo descartar los cambios en bancadas.",
      });
      return false;
    }
    return true;
  };

  const handleCancelClick = () => {
    if (busy) return;
    setShowCancelModal(true);
  };

  const handleCancelOI = async () => {
    if (busy) return;
    setShowCancelModal(false);
    setBusy(true);
    try {
      const ok = await rollbackBancadas();
      if (!ok) return;
      if (oiId && hasLock) {
        await unlockOi(oiId, "cancel");
      }
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
    didSendCloseRef.current = true;
    skipExitWarnRef.current = true;
    resetOiState();
    toast({ kind: "info", message: "Edicion cancelada" });
    navigate(getReturnTo());
  };

  const handleSaveAndReturn = async () => {
    if (busy) return;
    setShowCancelModal(false);

    let ok = true;
    if (isEditingOI || !oiId) {
      ok = false;
      const submit = handleSubmit(async (values) => {
        ok = oiId ? await onSubmitUpdate(values) : await onSubmitCreate(values);
      });
      await submit();
    }

    if (!ok) return;

    setBusy(true);
    try {
      if (oiId && hasLock) {
        await unlockOi(oiId);
      }
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
    didSendCloseRef.current = true;
    skipExitWarnRef.current = true;
    resetOiState();
    toast({ kind: "info", message: "Cambios guardados" });
    navigate(getReturnTo());
  };

  const handleCloseOI = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (oiId && hasLock) {
        await unlockOi(oiId);
      }
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
    didSendCloseRef.current = true;
    skipExitWarnRef.current = true;
    resetOiState();
    toast({ kind:"info", message:"OI cerrada"});
    navigate(getReturnTo());
  };

  const medidoresUsuarioLocal = useMemo(
    () => calcMedidoresFromBancadas(bancadas),
    [bancadas]
  );
  const medidoresUsuarioDisplay = medidoresUsuarioApi ?? medidoresUsuarioLocal;

    const formatDateTime = (iso?: string | null) => {
      if (!iso) return "-";
      // Fechas vienen en UTC sin zona; normalizamos a UTC y mostramos en hora de Peru.
      const hasTz = /([zZ]|[+-]\d{2}:?\d{2})$/.test(iso);
      const normalized = hasTz ? iso : `${iso}Z`;
      const d = new Date(normalized);
      if (Number.isNaN(d.getTime())) return iso;
      return new Intl.DateTimeFormat("es-PE", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
        timeZone: "America/Lima",
      }).format(d);
    };

  const modalDraftStorageKey = editing
    ? getBancadaDraftStorageKey(oiId, editing.id)
    : getNewDraftStorageKey(oiId);
  const modalDraftMeta =
    authUserId && bankId != null && oiId
      ? {
          userId: authUserId,
          bankId,
          oiId,
          bancadaId: editing?.id ?? null,
          isNew: !editing,
          returnTo: buildReturnTo(oiId),
          oiCode: getValues("oi") ?? null,
        }
      : null;

  return (
    <div className="oi-page vi-oi-light">
       <Spinner show={busy} />
      {!isOnline && (
        <div className="alert alert-warning py-1 mt-2 mb-2">
          Sin conexion. Los cambios se guardaran localmente hasta que vuelva la red.
        </div>
      )}
      {pendingAuthAction && (
        <div className="alert alert-info py-1 mt-2 mb-2">
          Sesion restaurada. Reintenta guardar.
        </div>
      )}
      <div className="d-flex align-items-center justify-content-between">
        <h1 className="h3">Formulario OI</h1>
        <div className="d-flex gap-2">
          {oiId && isAdmin && (
            <button
              type="button"
              className="btn btn-outline-auto btn-sm"
              onClick={handleOpenOiSavedAt}
              disabled={busy}
            >
              Editar fecha guardado
            </button>
          )}
          {oiId && isViewMode && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleSwitchToEditMode}
              disabled={busy}
            >
              Editar
            </button>
          )}
        </div>
      </div>
      {isReadOnly && (
        <div className="alert alert-warning mt-2">
          {isViewMode
            ? "Modo lectura. Use Editar para modificar."
            : lockedByName
              ? `Esta OI está siendo editada por ${lockedByName}. Se abre en modo lectura.`
              : "Esta OI está en modo lectura. No se pueden realizar cambios."}
        </div>
      )}

      <form
        onSubmit={handleSubmit(isEditingExisting ? onSubmitUpdate : onSubmitCreate)}
        className={`row g-3 mt-1 ${isEditingExisting ? "vi-form-editing" : "vi-form-readonly"}`}
      >
        <div className="col-md-4">
          <label htmlFor="oi" className="form-label">OI (OI-####-YYYY)</label>
          <input
            id="oi"
            className={`form-control ${oiId && !(isAdmin && isEditingOI && !isReadOnly) ? "vi-locked" : ""}`}
            {...register("oi")}
            disabled={!!oiId ? !(isAdmin && isEditingOI && !isReadOnly) : false}
          />
          {errors.oi && <div className="text-danger small">{errors.oi.message}</div>}
          {!isAdmin ? (
            <div className="form-text">Solo administradores pueden cambiar el codigo de OI.</div>
          ) : null}
        </div>

        <div className="col-md-4">
          <label htmlFor="q3" className="form-label">Q3 (m³/h)</label>
          <select id="q3" className="form-select" {...register("q3",{valueAsNumber:true})} disabled={(!!oiId && !isEditingOI) || isReadOnly}>
            {data?.q3.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>

        <div className="col-md-4">
          <label htmlFor="alcance" className="form-label">Alcance Q3/Q1</label>
          <select id="alcance" className="form-select" {...register("alcance",{valueAsNumber:true})} disabled={(!!oiId && !isEditingOI) || isReadOnly}>
            {data?.alcance.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>

        <div className="col-md-4">
          <label htmlFor="pma" className="form-label">PMA (bar)</label>
          <select id="pma" className="form-select" {...register("pma",{valueAsNumber:true})} disabled={(!!oiId && !isEditingOI) || isReadOnly}>
            {data?.pma.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
          <div className="form-text">Solo en formulario; calcula Presión (bar).</div>
        </div>

        <div className="col-md-4">
          <label htmlFor="presion" className="form-label">Presión (bar)</label>
          <input id="presion" className="form-control" value={isNaN(presion) ? "" : presion} disabled />
        </div>

        <div className="col-md-4">
          <label htmlFor="numeration_type" className="form-label">
            Tipo de numeración (# Medidor)
          </label>
          <select
            id="numeration_type"
            className="form-select"
            {...register("numeration_type")}
            disabled={(!!oiId && !isEditingOI) || isReadOnly}
          >
            <option value="correlativo">Correlativo</option>
            <option value="no correlativo">No Correlativo</option>
          </select>
          <div className="form-text">
            Define cómo se completa la columna # Medidor en el Grid.
          </div>
        </div>


        <div className="col-12 d-flex align-items-center gap-2">
          <button
            className="btn btn-primary"
            disabled={busy || (!!oiId && (!isEditingOI || isReadOnly))}
          >
            {!oiId
              ? "Guardar OI"
              : isEditingExisting
                ? "Guardar cambios"
                : "OI guardada"}
          </button>

          {oiId && !isEditingOI && isEditMode && (
            <button
              type="button"
              className="btn btn-outline-warning"
              onClick={handleStartEditOI}
              disabled={busy || isReadOnly}
            >
              Editar OI
            </button>
          )}
          {oiId && isEditingOI && isEditMode && (
            <button type="button" className="btn btn-outline-warning" onClick={handleCancelEditOI} disabled={busy}>
              Cancelar edicion
            </button>
          )}

          {isViewMode && (
            <button type="button" className="btn btn-outline-auto" onClick={handleBackToList} disabled={busy}>
              Volver al listado
            </button>
          )}

          <button type="button" className="btn btn-outline-success" onClick={handleExcelClick} disabled={!oiId || busy || isEditingOI}>
            Generar Excel
          </button>
          {isEditMode && (
            <button type="button" className="btn btn-outline-danger" onClick={handleCloseOI} disabled={!oiId || isEditingOI || busy}>
              Cerrar OI
            </button>
          )}
          {isEditMode && (
            <button type="button" className="btn btn-outline-auto" onClick={handleCancelClick} disabled={busy}>
              Cancelar
            </button>
          )}
        </div>
      </form>

      <hr className="my-4" />

      {/* ---- Tabla de Bancadas con estilo Adminator ---- */}
      <div className="card vi-card-table mt-3">
        <div className="card-header d-flex align-items-center justify-content-between">
          <div>
            <h2 className="h6 mb-0">Bancadas</h2>
            <small className="text-muted">
              Medidores (mi registro): {medidoresUsuarioDisplay} | Total OI: {medidoresTotalCode}
            </small>
          </div>
          <button className="btn btn-primary" onClick={openNew} disabled={!oiId || busy || isEditingOI || isReadOnly}>Agregar Bancada</button>
        </div>
        <div className="card-body p-0">
          <div className="table-responsive">
            <table className="table table-hover table-striped table-sm align-middle mb-0">
              <thead>
                <tr>
                  <th className="vi-col-60">Item</th>
                  <th># Medidor</th>
                  <th>Medidores</th>
                  <th className="vi-col-160">Fecha creación</th>
                  <th className="vi-col-160">Fecha guardado</th>
                  <th className="vi-col-160">Última fecha mod.</th>
                  <th className="vi-col-160 text-end">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {bancadas.length === 0 && (
                  <tr>
                    <td colSpan={7} className="text-muted text-center py-3">
                      Sin bancadas. Agrega la primera.
                    </td>
                  </tr>
                )}

                {bancadas.map(b => {
                  // Si tenemos la data completa, mostramos rango de medidores
                  const firstM = b.rows_data?.[0]?.medidor || b.medidor || "";
                  const lastM = b.rows_data?.[(b.rows_data?.length || 0) - 1]?.medidor || "";
                  const displayMed = (firstM && lastM && firstM !== lastM) ? `${firstM} ... ${lastM}` : firstM;

                  // AHORA HACEMOS EL RETURN DEL JSX
                  return (
                  <tr key={b.id}>
                    <td>{b.item}</td>
                    <td>{displayMed}</td>
                    <td>{b.rows}</td>
                    <td>{formatDateTime(b.created_at)}</td>
                    <td>{formatDateTime(b.saved_at)}</td>
                    <td>{formatDateTime(b.updated_at ?? b.created_at)}</td>
                    <td className="text-end">
                      {/* botones Editar / Eliminar */}
                        {isAdmin ? (
                          <button
                            className="btn btn-sm btn-outline-auto me-2"
                            onClick={() => handleOpenBancadaSavedAt(b)}
                            disabled={busy || isEditingOI || readOnly}
                            aria-label={`Editar fecha guardado bancada #${b.item}`}
                            title="Editar fecha guardado"
                          >
                            Editar fecha guardado
                          </button>
                        ) : null}
                        <button
                          className="btn btn-sm btn-outline-primary me-2"
                          onClick={() => openEdit(b)}
                          disabled={busy || isEditingOI || (!isViewMode && isReadOnly)}
                          aria-label={`${isViewMode ? "Ver" : "Editar"} bancada #${b.item}`}
                          title={isViewMode ? "Ver" : "Editar"}
                        >
                          {isViewMode ? "Ver" : "Editar"}
                        </button>
                        <button
                          className="btn btn-sm btn-outline-danger"
                          onClick={() => handleDelete(b)}
                          disabled={busy || isEditingOI || isReadOnly}
                          aria-label={`Eliminar bancada #${b.item}`}
                          title="Eliminar"
                        > 
                          🗑️
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      {showModal && (
      <BancadaModal
        show={showModal}
        title={editing ? `Editar bancada #${editing.item}` : "Nueva bancada"}
        initial={editingInitial}
        onClose={() => {
          clearDuplicateMap();
          setShowModal(false);
        }}
        onSubmit={handleSaveBancada}
        onCancelWithDraft={handleBancadaCancel}
        numerationType={numerationType}
        readOnly={isReadOnly}
        duplicateMap={duplicateMap}
        onClearDuplicate={clearDuplicateForMedidor}
        draftStorageKey={modalDraftStorageKey}
        draftMeta={modalDraftMeta}
        isOnline={isOnline}
        showRetry={pendingBancadaSave}
      />
       )}


      {showCancelModal && (
        <div
          className="modal fade show"
          style={{ display: "block" }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancelTitle"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowCancelModal(false);
          }}
        >
          <div className="modal-dialog">
            <div className="modal-content">
              <div className="modal-header">
                <h5 id="cancelTitle" className="modal-title">
                  Confirmar cancelacion
                </h5>
                <button
                  type="button"
                  className="btn-close"
                  aria-label="Cerrar"
                  onClick={() => setShowCancelModal(false)}
                />
              </div>
              <div className="modal-body">
                <p>Estas seguro de descartar cambios?</p>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-outline-auto"
                  onClick={handleCancelOI}
                  disabled={busy}
                >
                  Descartar cambios
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleSaveAndReturn}
                  disabled={busy}
                >
                  Guardar cambios y volver al listado
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {showSavedAtModal && (
        <div
          className="modal fade show"
          style={{ display: "block" }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="savedAtTitle"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowSavedAtModal(false);
              setSavedAtTarget(null);
              setSavedAtScope("bancada");
            }
          }}
        >
          <div className="modal-dialog">
            <form
              className="modal-content"
              onSubmit={(e) => {
                e.preventDefault();
                handleSaveSavedAt();
              }}
            >
              <div className="modal-header">
                <h5 id="savedAtTitle" className="modal-title">
                  Editar fecha guardado
                </h5>
                <button
                  type="button"
                  className="btn-close"
                  aria-label="Cerrar"
                  onClick={() => {
                    setShowSavedAtModal(false);
                    setSavedAtTarget(null);
                    setSavedAtScope("bancada");
                  }}
                />
              </div>
              <div className="modal-body">
                <div className="mb-3">
                  <label htmlFor="savedAtInput" className="form-label">
                    Fecha guardado
                  </label>
                  <input
                    id="savedAtInput"
                    type="datetime-local"
                    className="form-control"
                    value={savedAtInput}
                    onChange={(e) => setSavedAtInput(e.target.value)}
                    required
                  />
                  <div className="form-text">
                    {savedAtScope === "oi"
                      ? "Se aplicará a todas las bancadas de la OI."
                      : "Se aplica a la bancada seleccionada."}
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-outline-auto"
                  onClick={() => {
                    setShowSavedAtModal(false);
                    setSavedAtTarget(null);
                    setSavedAtScope("bancada");
                  }}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={busy || !savedAtInput}
                >
                  Guardar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <PasswordModal
        show={showPwd}
        title="Contraseña para proteger Excel"
        onClose={() => setShowPwd(false)}
        onConfirm={(pwd) => { setShowPwd(false); handleExcelConfirmed(pwd); }}
      />
    </div>
  );
}

