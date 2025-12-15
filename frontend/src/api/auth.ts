import { api } from "./client";

export type LoginInput = { username: string; password: string; bancoId?: number | null };

export type AuthPayload = {
  user?: string; // compatibilidad hacia atrás
  userId: number;
  username: string;
  firstName: string;
  lastName: string;
  fullName: string;
  bancoId: number | null;
  techNumber: number;
  token: string;
  role?: "admin" | "user";
  allowedModules?: string[];
};

export type LoginOut = AuthPayload;

const SELECTED_BANK_KEY = "medileser.selectedBank";
const SELECTED_BANK_EVENT = "medileser:selectedBank";

export function isTechnicianRole(role?: string): boolean {
  const r = (role ?? "").toLowerCase();
  return r === "user" || r === "tecnico" || r === "técnico" || r === "technician";
}

export function getSelectedBank(): number | null {
  try {
    const raw = localStorage.getItem(SELECTED_BANK_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function setSelectedBank(bankId: number) {
  try {
    localStorage.setItem(SELECTED_BANK_KEY, String(bankId));
  } finally {
    window.dispatchEvent(new Event(SELECTED_BANK_EVENT));
  }
}

export function clearSelectedBank() {
  try {
    localStorage.removeItem(SELECTED_BANK_KEY);
  } finally {
    window.dispatchEvent(new Event(SELECTED_BANK_EVENT));
  }
}

export function subscribeSelectedBank(onChange: () => void) {
  const onCustom = () => onChange();
  const onStorage = (e: StorageEvent) => {
    if (e.key === SELECTED_BANK_KEY) onChange();
  };
  window.addEventListener(SELECTED_BANK_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SELECTED_BANK_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

export async function changeOwnPassword(oldPassword: string, newPassword: string): Promise<void> {
  try {
    await api.put("/auth/password", { old_password: oldPassword, new_password: newPassword });
  } catch (e: any) {
    const msg = e?.response?.data?.detail ?? e?.message ?? "No se pudo actualizar la contraseña";
    throw new Error(msg);
  }
}


export async function login(payload: LoginInput): Promise<AuthPayload> {
  try {
    const { data } = await api.post<AuthPayload>("/auth/login", payload);
    localStorage.setItem("vi.auth", JSON.stringify(data));
    // Banco se selecciona post-login solo para técnicos
    if (isTechnicianRole(data.role)) clearSelectedBank();
    else setSelectedBank(0);
    return data;
  } catch (e: any) {
    const status = e?.response?.status;
    const detail = e?.response?.data?.detail;
    const msg =
      status === 401 ? "Credenciales inválidas" :
      detail ?? e?.message ?? "Error de autenticación";
    throw new Error(msg);
  }
}

export function getAuth(): LoginOut | null {
  const raw = localStorage.getItem("vi.auth") ?? localStorage.getItem("vi_auth");
  if (!raw) return null;

  try {
    const obj = JSON.parse(raw) as any;

    const fullNameFromParts =
      [obj.firstName, obj.lastName].filter(Boolean).join(" ") || undefined;

    const auth: LoginOut = {
      user: obj.user ?? obj.username ?? "",
      userId: obj.userId ?? obj.id ?? 0,
      username: obj.username ?? obj.user ?? "",
      firstName: obj.firstName ?? "",
      lastName: obj.lastName ?? "",
      fullName: obj.fullName ?? fullNameFromParts ?? obj.username ?? obj.user ?? "",
      bancoId: obj.bancoId ?? null,
      token: obj.token,
      techNumber: obj.techNumber,
      role: obj.role ?? (obj.username?.toLowerCase() === "admin" ? "admin" : "user"),
      allowedModules: Array.isArray(obj.allowedModules) ? obj.allowedModules : undefined,
    };

    return auth.username && auth.token ? auth : null;
  } catch {
    return null;
  }
}

export async function setSessionBank(bancoId: number): Promise<AuthPayload> {
  const { data } = await api.put<AuthPayload>("/auth/banco", { bancoId });
  localStorage.setItem("vi.auth", JSON.stringify(data));
  setSelectedBank(bancoId);
  return data;
}


export function logout() {
  localStorage.removeItem("vi.auth");
  localStorage.removeItem("vi_auth");
  clearSelectedBank();
}
