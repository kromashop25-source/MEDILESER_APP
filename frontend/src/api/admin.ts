import { api } from "./client";

export type UserPermissions = {
  id: number;
  username: string;
  role: string;
  allowedModules: string[];
};

export type UserPermissionsPaged = {
  items: UserPermissions[];
  total: number;
  limit: number;
  offset: number;
};


export async function listUserPermissions(): Promise<UserPermissions[]> {
  const { data } = await api.get<UserPermissions[]>("/admin/permisos");
  return data;
}

export async function listUserPermissionsPaged(params: {
  q?: string;
  role?: string;
  limit: number;
  offset: number;
}): Promise<UserPermissionsPaged> {
  const res = await api.get<UserPermissionsPaged>("/admin/permisos/paged", {
    params: {
      q: params.q || undefined,
      role: params.role || undefined,
      limit: params.limit,
      offset: params.offset,
    },
  });
  return res.data;
}

export async function updateUserPermissions(
  userId: number,
  allowedModules: string[]
): Promise<UserPermissions> {
  const { data } = await api.put<UserPermissions>(`/admin/permisos/${userId}`, { allowedModules });
  return data;
}

