import axios from "axios";

const DEV_DEFAULT_API = "http://127.0.0.1:8000";
const OPEN_OI_KEY = "openOiId";
const CURRENT_OI_KEY = "vi.currentOI";
const AUTH_KEY_A = "vi.auth";
const AUTH_KEY_B = "vi_auth";
const SELECTED_BANK_KEY = "medileser.selectedBank";
const SELECTED_BANK_EVENT = "medileser:selectedBank";
const PENDING_TOAST_KEY = "medileser.pendingToast";

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
export async function handleAuthFailure(): Promise<void> {
    if (handlingAuthFailure) return;
    handlingAuthFailure = true;
    try {
        await closeOpenOiIfAny();
    } finally {
        clearLocalSession();
        setPendingToast("Sesión inválida o expirada");
        if (typeof window !== "undefined" && window.location.pathname !== "/login") {
            window.location.replace("/login");
        }
        // Si ya estamos en /login, no hacemos replace para evitar loops
    }
}

api.interceptors.response.use(
    (res) => res,
    async (error) => {
        const status = error?.response?.status;
        const url = String(error?.config?.url ?? "");
        const detail = error?.response?.data?.detail;

        const isLogin = url.includes("/auth/login");
        if (!isLogin && (status === 401 || (status === 403 && typeof detail === "string" && /sesi[oó]n|token/i.test(detail)))) {
            await handleAuthFailure();
        }

        return Promise.reject(error);
    }
);
