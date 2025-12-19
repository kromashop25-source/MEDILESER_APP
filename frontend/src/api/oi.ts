import { api } from "./client";
export type NumerationType = "correlativo" | "no correlativo";

export type OICreate = {
  code: string;
  q3: number;
  alcance: number;
  pma: number;
  banco_id: number;
  tech_number: number;
  numeration_type: NumerationType;
};

export type OIRead = OICreate & { 
  id: number; 
  presion_bar: number;
  created_at: string;
  updated_at: string | null;
  creator_name: string;
  locked_by_user_id?: number | null;
  locked_by_full_name?: string | null;
  locked_at?: string | null;
  read_only_for_current_user?: boolean;
  medidores_usuario?: number | null;
  medidores_total_code?: number | null;
};

// ---- Listado paginado de OI (para Listado OI) ----
export type OIListQuery = {
  q?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
  responsableTechNumber?: number;
};

export type OIListResponse = {
  items: OIRead[];
  total: number;
  limit: number;
  offset: number;
  summary?: {
    medidores_resultado: number;
    oi_unicas: number;
    medidores_total_oi_unicas: number;
  };
};

// Payload mínimo para actualizar los valores técnicos de la OI
export type OIUpdatePayload = {
  q3: number;
  alcance: number;
  pma: number;
  numeration_type: NumerationType;
  updated_at: string;
};

export async function updateOI(id: number, payload: OIUpdatePayload): Promise<OIRead> {
  try {
    const { data } = await api.put<OIRead>(`/oi/${id}`, payload);
    return data;
  } catch (e: any) {
    const msg = e?.response?.data?.detail ?? e?.message ?? "No se pudo actualizar la OI";
    const err = new Error(msg) as Error & { status?: number };
    err.status = e?.response?.status;
    throw err;
  }
}

// Bloques Q3/Q2/Q1 (7 columnas por bloque, primera fila)
export type QBlock = {
  c1?: number | null;
  c2?: number | null;
  c3?: number | null;
  c4?: number | null;
  c5?: number | null;
  c6?: number | null;
  c7?: string | null;
  c7_seconds?: number | null;
  caudal?: number | null;
  error?: number | null;
};

// Nueva estructura para una fila individual de la bancada
export type BancadaRow = {
  medidor?: string | null;
  estado?: number | null; // Estado por fila
  q3?: QBlock | null;
  q2?: QBlock | null;
  q1?: QBlock | null;
};

export type BancadaCreate = {
  estado: number;
  rows: number;
  // Ahora enviamos la data completa de las filas
  rows_data?: BancadaRow[];
};
export type BancadaUpdatePayload = BancadaCreate & { updated_at: string };
export type BancadaRead = {
  id: number;
  item: number;
  // Mantenemos comptibilidad visual en lista, pero la data real está en rows_data
  medidor?: string | null;
  estado: number;
  rows: number;
  rows_data?: BancadaRow[];
  q3?: QBlock | null;
  q2?: QBlock | null;
  q1?: QBlock | null;
  created_at: string;
  updated_at: string | null;
};
;
export type OIWithBancadas = OIRead & { bancadas: BancadaRead[] };
export type CurrentOI = { id:number; code:string };

export async function createOI(payload: OICreate): Promise<OIRead> {
  try {
    const { data } = await api.post<OIRead>("/oi", payload);
    return data;
  } catch (e: any) {
    const msg = e?.response?.data?.detail ?? e?.message ?? "No se pudo crear el OI";
    throw new Error(msg);
  }
}

export async function listBancadas(oiId: number): Promise<BancadaRead[]> {
  // Si mantienes un endpoint de listado independiente
  const r = await api.get<BancadaRead[]>(`/oi/${oiId}/bancadas-list`, {validateStatus: s => s <500}).catch(() => null);
  return r?.data ?? [];
}

export async function addBancada(oiId: number, payload: BancadaCreate): Promise<BancadaRead> {
  try {
    const { data } = await api.post<BancadaRead>(`/oi/${oiId}/bancadas`, payload);
    return data;
  } catch (e: any) {
    const msg = e?.response?.data?.detail ?? e?.message ?? "No se puedo agregar la bancada";
    throw new Error(msg)
  }
}

export async function updateBancada(bancadaId: number, payload: BancadaUpdatePayload): Promise<BancadaRead> {
  try {
    const { data } = await api.put<BancadaRead>(`/oi/bancadas/${bancadaId}`, payload);
    return data;
  } catch (e: any) {
    const msg = e?.response?.data?.detail ?? e?.message ?? "No se pudo actualizar la bancada";
    const err = new Error(msg) as Error & { status?: number };
    err.status = e?.response?.status;
    throw err;
  }
}

export async function deleteBancada(bancadaId: number): Promise<void> {
  try {
    await api.delete(`/oi/bancadas/${bancadaId}`);
  } catch (e:any) {
    const msg = e?.response?.data?.detail ?? e?.message ?? "No se pudo eliminar la bancada";
    throw new Error(msg)
  }
}

export async function generateExcel(oiId: number, password: string): Promise<void> {
  let res: any;
  try {
    res = await api.post(`/oi/${oiId}/excel`, { password }, { responseType: "blob" });
  } catch (e: any) {
    let msg = e?.message ?? "No se pudo generar el Excel";

    const data = e?.response?.data;
    if (data instanceof Blob) {
      try {
        const text = await data.text();
        try {
          const parsed = JSON.parse(text) as any;
          const detail = parsed?.detail;
          if (typeof detail === "string") msg = detail;
          else if (Array.isArray(detail) && detail.length > 0) {
            msg = detail
              .map((d: any) => String(d?.msg ?? ""))
              .filter(Boolean)
              .join(", ");
          } else if (text) {
            msg = text;
          }
        } catch {
          if (text) msg = text;
        }
      } catch {
        // ignore
      }
    } else {
      msg = e?.response?.data?.detail ?? msg;
    }

    throw new Error(msg);
  }

  const blob = res.data as Blob;
  // nombre desde Content-Disposition
  const cd = res.headers["content-disposition"] as string | undefined;
  const match = cd?.match(/filename="(.+?)"/i);
  const filename = match?.[1] ?? `OI-${oiId}.xlsx`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(url);
  a.remove();
}

export async function deleteOI(oiId: number): Promise<void> {
  await api.delete(`/oi/${oiId}`);
}

export async function lockOi(oiId: number): Promise<OIRead> {
  try {
    const { data } = await api.post<OIRead>(`/oi/${oiId}/lock`);
    return data;
  } catch (e: any) {
    const msg = e?.response?.data?.detail ?? e?.message ?? "No se pudo bloquear la OI";
    const err = new Error(msg) as Error & { status?: number };
    err.status = e?.response?.status;
    throw err;
  }
}

export async function unlockOi(oiId: number): Promise<{ ok: boolean }> {
  try {
    const { data } = await api.delete<{ ok: boolean }>(`/oi/${oiId}/lock`);
    return data;
  } catch (e: any) {
    const msg = e?.response?.data?.detail ?? e?.message ?? "No se pudo liberar la OI";
    const err = new Error(msg) as Error & { status?: number };
    err.status = e?.response?.status;
    throw err;
  }
}

// ---------- Nuevo: cargar OI completo (con bancadas) ----------
export async function getOiFull(oiId: number): Promise<OIWithBancadas> {
  try {
    const { data } = await api.get<OIWithBancadas>(`/oi/${oiId}/full`);
  return data;
  } catch (e: any) {
    const msg = e?.response?.data?.detail ?? e?.message ?? "No se puedo cargar el OI";
    throw new Error(msg);
  }
}

// ---------- Listado / detalle OI (para la lista) ----------
export async function listOI(params: OIListQuery): Promise<OIListResponse> {
  try {
    const { data } = await api.get<OIListResponse>("/oi", {
      params: {
        q: params.q || undefined,
        date_from: params.dateFrom || undefined,
        date_to: params.dateTo || undefined,
        limit: params.limit,
        offset: params.offset,
        responsable_tech_number: params.responsableTechNumber || undefined,
      },
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Expires: "0",
      },
    });
    return data;
  } catch (e: any) {
    const msg =
      e?.response?.data?.detail ??
      e?.message ??
      "No se pudo obtener el listado de OI";
    throw new Error(msg);
  }
}

export type ResponsableOption = {
  tech_number: number;
  full_name: string;
};

export async function listResponsables(): Promise<ResponsableOption[]> {
  try {
    const { data } = await api.get<ResponsableOption[]>("/oi/responsables");
    return data;
  } catch (e: any) {
    const msg = e?.response?.data?.detail ?? e?.message ?? "No se pudo obtener responsables";
    throw new Error(msg);
  }
}


export async function getOi(oiId:number): Promise<OIRead> {
  try{
    const {data } = await api.get<OIRead>(`/oi/${oiId}`);
    return data;
  } catch (e: any) {
    const msg = e?.response?.data?.detail ?? e?.message ?? "No se pudo obtener el OI";
    throw new Error(msg)
  }
}

// ---------- Helpers de sesión (persistir OI activo) ----------
const KEY = "vi.currentOI";
export function saveCurrentOI(v: CurrentOI ) {
  sessionStorage.setItem(KEY, JSON.stringify(v));
}
export function loadCurrentOI(): CurrentOI | null {
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as CurrentOI; } catch { return null; }
}
export function clearCurrentOI() {
  sessionStorage.removeItem(KEY);
}
