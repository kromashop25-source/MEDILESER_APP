import axios from "axios";

const DEV_DEFAULT_API = "http://127.0.0.1:8000";

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

// Adjuntar token almacenado (vi.auth o vi_auth) a cada request
api.interceptors.request.use((config) => {
    try {
        const raw = localStorage.getItem("vi.auth") ?? localStorage.getItem("vi_auth");
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
});
