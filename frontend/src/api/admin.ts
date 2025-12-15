import { api } from "./client";

export type UserPermissions = {
  id: number;
  username: string;
  role: string;
  allowedModules: string[];
};

export async function listUserPermissions(): Promise<UserPermissions[]> {
  const { data } = await api.get<UserPermissions[]>("/admin/permisos");
  return data;
}

export async function updateUserPermissions(
  userId: number,
  allowedModules: string[]
): Promise<UserPermissions> {
  const { data } = await api.put<UserPermissions>(`/admin/permisos/${userId}`, { allowedModules });
  return data;
}

