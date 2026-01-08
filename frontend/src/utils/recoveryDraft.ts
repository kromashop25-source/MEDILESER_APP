const DRAFT_PREFIX = "medileser:draft:v1";
const RECOVERY_KEY = "medileser:recovery:v1";
const RESTORE_INTENT_KEY = "medileser:recovery:intent";
const AUTH_KEY_A = "vi.auth";
const AUTH_KEY_B = "vi_auth";
const SELECTED_BANK_KEY = "medileser.selectedBank";

export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export type RecoveryModal = {
  type: "bancada";
  bancadaId?: number | null;
  isNew?: boolean;
};

export type RecoveryContext = {
  version: 1;
  ts: string;
  userId: number;
  bankId: number;
  oiId: number;
  oiCode?: string | null;
  returnTo: string;
  mode: "edit";
  modal?: RecoveryModal;
};

export type DraftEnvelope<T> = {
  version: 1;
  ts: string;
  userId: number;
  bankId: number;
  oiId: number;
  bancadaId?: number | null;
  isNew?: boolean;
  data: T;
};

export type RestoreIntent = {
  version: 1;
  ts: string;
  userId: number;
  bankId: number;
  oiId: number;
  modal?: RecoveryModal;
  returnTo?: string;
};

type DraftKeyInput = {
  userId: number | null | undefined;
  bankId: number | null | undefined;
  oiId: number | null | undefined;
  type: "header" | "bancada";
  bancadaId?: number | null;
  isNew?: boolean;
};

const isExpired = (ts?: string | null) => {
  if (!ts) return false;
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return false;
  return Date.now() - parsed > DRAFT_TTL_MS;
};

export const buildDraftKey = (input: DraftKeyInput): string | null => {
  const { userId, bankId, oiId, type, bancadaId, isNew } = input;
  if (!userId || bankId == null) return null;
  const oiPart = oiId != null ? String(oiId) : "new";
  const prefix = `${DRAFT_PREFIX}:u${userId}:b${bankId}:oi:${oiPart}`;

  if (type === "header") {
    return `${prefix}:header`;
  }

  const idPart = isNew ? "new" : bancadaId;
  if (idPart == null) return null;
  return `${prefix}:bancada:${idPart}`;
};

export const saveDraft = <T>(
  key: string,
  envelope: DraftEnvelope<T>,
  recovery?: RecoveryContext | null
) => {
  try {
    localStorage.setItem(key, JSON.stringify(envelope));
  } catch {
    // ignore
  }
  if (recovery) {
    setRecoveryContext(recovery);
  }
};

export const loadDraft = <T>(key: string): DraftEnvelope<T> | null => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DraftEnvelope<T>;
    if (!parsed || typeof parsed !== "object") return null;
    if (isExpired(parsed.ts)) {
      localStorage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const clearDraft = (key: string) => {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
};

export const setRecoveryContext = (ctx: RecoveryContext) => {
  try {
    localStorage.setItem(RECOVERY_KEY, JSON.stringify(ctx));
  } catch {
    // ignore
  }
};

export const getRecoveryContext = (): RecoveryContext | null => {
  try {
    const raw = localStorage.getItem(RECOVERY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RecoveryContext;
    if (!parsed || typeof parsed !== "object") return null;
    if (isExpired(parsed.ts)) {
      localStorage.removeItem(RECOVERY_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const clearRecoveryContext = () => {
  try {
    localStorage.removeItem(RECOVERY_KEY);
  } catch {
    // ignore
  }
};

export const touchRecoveryContext = (partial: {
  userId: number | null | undefined;
  bankId: number | null | undefined;
  oiId: number | null | undefined;
  returnTo?: string;
  mode?: "edit";
  modal?: RecoveryModal;
  oiCode?: string | null;
}) => {
  const userId = partial.userId ?? null;
  const bankId = partial.bankId ?? null;
  const oiId = partial.oiId ?? null;
  if (!userId || bankId == null || !oiId) return;
  const existing = getRecoveryContext();
  const next: RecoveryContext = {
    version: 1,
    ts: new Date().toISOString(),
    userId,
    bankId,
    oiId,
    oiCode: partial.oiCode ?? existing?.oiCode ?? null,
    returnTo: partial.returnTo ?? existing?.returnTo ?? `/oi/${oiId}?mode=edit`,
    mode: "edit",
    modal: partial.modal ?? existing?.modal,
  };
  setRecoveryContext(next);
};

export const setRestoreIntent = (ctx: RecoveryContext) => {
  const intent: RestoreIntent = {
    version: 1,
    ts: new Date().toISOString(),
    userId: ctx.userId,
    bankId: ctx.bankId,
    oiId: ctx.oiId,
    modal: ctx.modal,
    returnTo: ctx.returnTo,
  };
  try {
    sessionStorage.setItem(RESTORE_INTENT_KEY, JSON.stringify(intent));
  } catch {
    // ignore
  }
};

export const getRestoreIntent = (): RestoreIntent | null => {
  try {
    const raw = sessionStorage.getItem(RESTORE_INTENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RestoreIntent;
    if (!parsed || typeof parsed !== "object") return null;
    if (isExpired(parsed.ts)) {
      sessionStorage.removeItem(RESTORE_INTENT_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const clearRestoreIntent = () => {
  try {
    sessionStorage.removeItem(RESTORE_INTENT_KEY);
  } catch {
    // ignore
  }
};

export const getStoredAuthMeta = (): { userId: number | null; bankId: number | null } => {
  try {
    const raw = localStorage.getItem(AUTH_KEY_A) ?? localStorage.getItem(AUTH_KEY_B);
    if (!raw) return { userId: null, bankId: null };
    const parsed = JSON.parse(raw) as { userId?: number; id?: number; bancoId?: number | null };
    const userId = Number(parsed.userId ?? parsed.id);
    const bankId = parsed.bancoId != null ? Number(parsed.bancoId) : null;
    return {
      userId: Number.isFinite(userId) ? userId : null,
      bankId: bankId != null && Number.isFinite(bankId) ? bankId : null,
    };
  } catch {
    // ignore
  }

  return { userId: null, bankId: null };
};

export const getSelectedBankFromStorage = (): number | null => {
  try {
    const raw = localStorage.getItem(SELECTED_BANK_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
};

export const maybeRestoreRecovery = (
  userId: number | null | undefined,
  bankId: number | null | undefined
): { target: string | null; reason?: string; recovery?: RecoveryContext } => {
  const recovery = getRecoveryContext();
  if (!recovery) return { target: null };

  if (!userId || recovery.userId !== userId) {
    return { target: "/home", reason: "user" };
  }

  if (bankId == null || recovery.bankId !== bankId) {
    return { target: "/home", reason: "bank" };
  }

  const rawTarget = recovery.returnTo || `/oi/${recovery.oiId}?mode=edit`;
  const target =
    rawTarget === "/oi" || rawTarget === "/oi/" ? `/oi/${recovery.oiId}?mode=edit` : rawTarget;
  setRestoreIntent(recovery);
  return { target, recovery };
};
