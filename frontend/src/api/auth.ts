import { api } from "./client";

export type LoginInput = { username: string; password: string; bancoId: number };

export type AuthPayload = {
  user?: string; // compatibilidad hacia atrás
  userId: number;
  username: string;
  firstName: string;
  lastName: string;
  fullName: string;
  bancoId: number;
  techNumber: number;
  token: string;
  role?: "admin" | "user";
};

export type LoginOut = AuthPayload;

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
      bancoId: obj.bancoId,
      token: obj.token,
      techNumber: obj.techNumber,
      role: obj.role ?? (obj.username?.toLowerCase() === "admin" ? "admin" : "user"),
    };

    return auth.username && auth.token ? auth : null;
  } catch {
    return null;
  }
}


export function logout() {
  localStorage.removeItem("vi.auth");
  localStorage.removeItem("vi_auth");
  // Fuerza reevaluar rutas protegidas y recargar topbar
  window.location.replace("/");
}
