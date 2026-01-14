import axios from "axios";
import { getSelectedBankFromStorage, getStoredAuthMeta, touchRecoveryContext } from "../utils/recoveryDraft";

const DEV_DEFAULT_API = "http://127.0.0.1:8000";
const OPEN_OI_KEY = "openOiId";
const CURRENT_OI_KEY = "vi.currentOI";
const AUTH_KEY_A = "vi.auth";
const AUTH_KEY_B = "vi_auth";
const SELECTED_BANK_KEY = "medileser.selectedBank";
const SELECTED_BANK_EVENT = "medileser:selectedBank";
const PENDING_TOAST_KEY = "medileser.pendingToast";
const PENDING_ACTION_KEY = "medileser.pendingAction";
const AUTH_EXPIRED_EVENT = "medileser:auth-expired";
const SESSION_USER_KEY = "medileser.sessionUserId";
const SESSION_BANK_KEY = "medileser.sessionBankId";

const resolveBaseURL = () => {
    const envUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
    if (envUrl) return envUrl;

    if (typeof window !== "undefined") {
        // Keep the existing dev experience while allowing packaged builds to use their own port.
        if (window.location.port === "5173") return DEV_DEFAULT_API;
        return window.location.origin;
    }

    return DEV_DEFAULT_API;
};

export const api = axios.create({ baseURL: resolveBaseURL() });
const apiRaw = axios.create({ baseURL: resolveBaseURL() });

// Adjuntar token almacenado (vi.auth o vi_auth) a cada request
const attachToken = (config: any) => {
    try {
        const raw = localStorage.getItem(AUTH_KEY_A) ?? localStorage.getItem(AUTH_KEY_B);
        if (raw) {
            const { token } = JSON.parse(raw);
            if (token) {
                // Axios v1: headers puede ser AxiosHeaders (time .set) o un objeto plano
                if (config.headers && typeof (config.headers as any).set === "function") {
                    (config.headers as any).set("Authorization", `Bearer ${token}`);
                } else {
                    config.headers = { ...(config.headers || {}), Authorization: `Bearer ${token}` } as any;
                }
            }
        }
    } catch {}
    return config;
};

api.interceptors.request.use(attachToken);
apiRaw.interceptors.request.use(attachToken);

export function getOpenOiId(): number | null {
    try {
        const raw = sessionStorage.getItem(OPEN_OI_KEY);
        if (!raw) return null;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
        return null;
    }
}

const getCurrentOiIdFromSession = (): number | null => {
    try {
        const raw = sessionStorage.getItem(CURRENT_OI_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { id?: number } | null;
        const n = Number(parsed?.id);
        return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
        return null;
    }
};

export function setOpenOiId(oiId: number) {
    try {
        sessionStorage.setItem(OPEN_OI_KEY, String(oiId));
    } catch {
        // ignore
    }
}

export function clearOpenOiId() {
    try {
        sessionStorage.removeItem(OPEN_OI_KEY);
    } catch {
        // ignore
    }
}

export async function closeOpenOiIfAny(): Promise<void> {
    const oiId = getOpenOiId();
    if (!oiId) return;
    try {
        await apiRaw.post(`/oi/${oiId}/close`);
    } catch {
        // best-effort
    } finally {
        clearOpenOiId();
    }
}

export function setPendingToast(message: string) {
    try {
        sessionStorage.setItem(PENDING_TOAST_KEY, message);
    } catch {
        // ignore
    }
}

export function popPendingToast(): string | null {
    try {
        const msg = sessionStorage.getItem(PENDING_TOAST_KEY);
        if (!msg) return null;
        sessionStorage.removeItem(PENDING_TOAST_KEY);
        return msg;
    } catch {
        return null;
    }
}

export type PendingAction = {
    type: "save_oi" | "save_bancada";
    route: string;
    oiId?: number | null;
    bancadaId?: number | null;
    ts: string;
};

export function setPendingAction(action: PendingAction) {
    try {
        sessionStorage.setItem(PENDING_ACTION_KEY, JSON.stringify(action));
    } catch {
        // ignore
    }
}

export function getPendingAction(): PendingAction | null {
    try {
        const raw = sessionStorage.getItem(PENDING_ACTION_KEY);
        if (!raw) return null;
        return JSON.parse(raw) as PendingAction;
    } catch {
        return null;
    }
}

export function clearPendingAction() {
    try {
        sessionStorage.removeItem(PENDING_ACTION_KEY);
    } catch {
        // ignore
    }
}

export function getSessionUserId(): number | null {
    try {
        const raw = sessionStorage.getItem(SESSION_USER_KEY);
        if (!raw) return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    } catch {
        return null;
    }
}

export function setSessionUserId(userId: number | null) {
    try {
        if (userId == null) {
            sessionStorage.removeItem(SESSION_USER_KEY);
        } else {
            sessionStorage.setItem(SESSION_USER_KEY, String(userId));
        }
    } catch {
        // ignore
    }
}

export function getSessionBankId(): number | null {
    try {
        const raw = sessionStorage.getItem(SESSION_BANK_KEY);
        if (!raw) return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    } catch {
        return null;
    }
}

export function setSessionBankId(bankId: number | null) {
    try {
        if (bankId == null) {
            sessionStorage.removeItem(SESSION_BANK_KEY);
        } else {
            sessionStorage.setItem(SESSION_BANK_KEY, String(bankId));
        }
    } catch {
        // ignore
    }
}

export function clearDraftSessionIfUserChanged(nextUserId: number | null): boolean {
    const prev = getSessionUserId();
    if (nextUserId == null) return false;
    if (prev === null || prev === nextUserId) {
        setSessionUserId(nextUserId);
        return false;
    }

    try {
        const keys: string[] = [];
        for (let i = 0; i < sessionStorage.length; i += 1) {
            const key = sessionStorage.key(i);
            if (!key) continue;
            if (
                key.startsWith("oi:") ||
                key === OPEN_OI_KEY ||
                key === CURRENT_OI_KEY ||
                key === PENDING_ACTION_KEY
            ) {
                keys.push(key);
            }
        }
        keys.forEach((key) => sessionStorage.removeItem(key));
    } catch {
        // ignore
    }

    setSessionUserId(nextUserId);
    setSessionBankId(null);
    return true;
}

export function clearDraftSessionIfBankChanged(nextBankId: number | null): boolean {
    const prev = getSessionBankId();
    if (nextBankId == null) return false;
    if (prev === null || prev === nextBankId) {
        setSessionBankId(nextBankId);
        return false;
    }

    try {
        const keys: string[] = [];
        for (let i = 0; i < sessionStorage.length; i += 1) {
            const key = sessionStorage.key(i);
            if (!key) continue;
            if (
                key.startsWith("oi:") ||
                key === OPEN_OI_KEY ||
                key === CURRENT_OI_KEY ||
                key === PENDING_ACTION_KEY
            ) {
                keys.push(key);
            }
        }
        keys.forEach((key) => sessionStorage.removeItem(key));
    } catch {
        // ignore
    }

    setSessionBankId(nextBankId);
    return true;
}

function clearLocalSession() {
    try {
        localStorage.removeItem(AUTH_KEY_A);
        localStorage.removeItem(AUTH_KEY_B);
        localStorage.removeItem(SELECTED_BANK_KEY);
    } catch {
        // ignore
    } finally {
        try {
            window.dispatchEvent(new Event(SELECTED_BANK_EVENT));
        } catch {
            // ignore
        }
    }

    try {
        sessionStorage.removeItem(CURRENT_OI_KEY);
        sessionStorage.removeItem(OPEN_OI_KEY);
    } catch {
        // ignore
    }
}

let handlingAuthFailure = false;
export async function handleAuthFailure(options?: { returnTo?: string; pending?: boolean }): Promise<void> {
    if (handlingAuthFailure) return;
    handlingAuthFailure = true;
    try {
        await closeOpenOiIfAny();
    } finally {
        clearLocalSession();
        const msg = options?.pending
            ? "Sesion expirada. Inicia sesion para guardar. Tu borrador esta guardado."
            : "Sesion invalida o expirada";
        setPendingToast(msg);
        if (typeof window !== "undefined" && window.location.pathname !== "/login") {
            const returnTo = options?.returnTo;
            const qs = returnTo
                ? `?returnTo=${encodeURIComponent(returnTo)}${options?.pending ? "&pending=1" : ""}`
                : "";
            window.location.replace(`/login${qs}`);
        }
        // Si ya estamos en /login, no hacemos replace para evitar loops
    }
}

export const isAuthExpiredError = (error: any) => {
    const status = error?.response?.status;
    const code = String(error?.response?.headers?.["x-code"] ?? "").toUpperCase();
    if (code === "PASSWORD_REQUIRED" || code === "WRONG_PASSWORD") return false;
    if (status === 401 || status === 403) return true;
    const detail = error?.response?.data?.detail;
    if (typeof detail === "string" && /token requerido/i.test(detail)) return true;
    return false;
};

const parseIdFromUrl = (pattern: RegExp, url: string) => {
    const match = url.match(pattern);
    if (!match) return null;
    const id = Number(match[1]);
    return Number.isFinite(id) ? id : null;
};

const buildPendingActionFromRequest = (error: any): PendingAction | null => {
    if (typeof window === "undefined") return null;
    const method = String(error?.config?.method ?? "").toUpperCase();
    const url = String(error?.config?.url ?? "");
    const route = `${window.location.pathname}${window.location.search}`;

    if (method === "PUT" && /\/oi\/\d+$/.test(url)) {
        return {
            type: "save_oi",
            route,
            oiId: parseIdFromUrl(/\/oi\/(\d+)$/, url),
            ts: new Date().toISOString(),
        };
    }
    if (method === "POST" && url === "/oi") {
        return {
            type: "save_oi",
            route,
            oiId: null,
            ts: new Date().toISOString(),
        };
    }
    if (method === "POST" && /\/oi\/\d+\/bancadas$/.test(url)) {
        return {
            type: "save_bancada",
            route,
            oiId: parseIdFromUrl(/\/oi\/(\d+)\/bancadas$/, url),
            ts: new Date().toISOString(),
        };
    }
    if (method === "PUT" && /\/oi\/bancadas\/\d+$/.test(url)) {
        return {
            type: "save_bancada",
            route,
            bancadaId: parseIdFromUrl(/\/oi\/bancadas\/(\d+)$/, url),
            ts: new Date().toISOString(),
        };
    }

    return null;
};

const resolveReturnTo = (pending: PendingAction | null) => {
    if (typeof window === "undefined") return undefined;
    const { pathname, search, hash } = window.location;
    const params = new URLSearchParams(search);
    const isOiRoute = pathname === "/oi" || pathname.startsWith("/oi/");
    if (isOiRoute) {
        params.set("mode", "edit");
    }
    const query = params.toString();
    const withQuery = (base: string) => `${base}${query ? `?${query}` : ""}${hash ?? ""}`;
    let next = withQuery(pathname);
    if (pathname === "/oi" || pathname === "/oi/") {
        const oiId = pending?.oiId ?? getCurrentOiIdFromSession();
        if (oiId) {
            next = withQuery(`/oi/${oiId}`);
        }
    }
    return next;
};

const dispatchAuthExpired = (
    detail: unknown,
    status: number | undefined,
    url: string,
    method: string,
    pending: PendingAction | null
) => {
    try {
        window.dispatchEvent(
            new CustomEvent(AUTH_EXPIRED_EVENT, {
                detail: { status, detail, url, method, pending },
            })
        );
    } catch {
        // ignore
    }
};

api.interceptors.response.use(
    (res) => res,
    async (error) => {
        const status = error?.response?.status;
        const url = String(error?.config?.url ?? "");
        const detail = error?.response?.data?.detail;
        const method = String(error?.config?.method ?? "").toUpperCase();

        const isLogin = url.includes("/auth/login");
        if (!isLogin && isAuthExpiredError(error)) {
            const pending = buildPendingActionFromRequest(error);
            if (pending) {
                setPendingAction(pending);
            }
            dispatchAuthExpired(detail, status, url, method, pending);
            const returnTo = resolveReturnTo(pending);
            const authMeta = getStoredAuthMeta();
            const storedBankId = authMeta.bankId ?? getSelectedBankFromStorage();
            const targetOiId = pending?.oiId ?? getCurrentOiIdFromSession();
            if (authMeta.userId && storedBankId != null && targetOiId) {
                const modal =
                    pending?.type === "save_bancada"
                        ? {
                              type: "bancada" as const,
                              bancadaId: pending.bancadaId ?? null,
                              isNew: pending.bancadaId == null,
                          }
                        : undefined;
                touchRecoveryContext({
                    userId: authMeta.userId,
                    bankId: storedBankId,
                    oiId: targetOiId,
                    returnTo,
                    mode: "edit",
                    modal,
                });
            }
            await handleAuthFailure({ returnTo, pending: Boolean(pending) });
        }

        return Promise.reject(error);
    }
);
