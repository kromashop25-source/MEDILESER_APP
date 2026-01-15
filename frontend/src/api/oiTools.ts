import type { AxiosResponse } from "axios";
import { api } from "./client";
import { getAuth } from "./auth";
import type { ProgressEvent } from "./integrations";

const isDev = import.meta.env.DEV;
const logDev = (...args: unknown[]) => {
  if (isDev) console.info(...args);
};

export type MergeUploadLimits = {
  max_file_mb: number;
  max_tech_files: number;
};

export type UploadedFileInfo = {
  saved: boolean;
  relative_path: string;
  filename: string;
  size_bytes: number;
  hint_next?: string;
};

export type ExcelEditItem = {
  sheet: string;
  cell: string;
  value: unknown;
};

export type ExcelInspectRequest = {
  file_path: string;
  open_password?: string | null;
};

export type ExcelUpdateRequest = {
  file_path: string;
  edits: ExcelEditItem[];
  open_password?: string | null;
  save_mode?: "same_password" | "no_password" | "new_password";
  new_password?: string | null;
};

export type ExcelChangePasswordRequest = {
  file_path: string;
  open_password: string;
  mode: "no_password" | "new_password";
  new_password?: string | null;
};

export type ExcelValidateRequest = {
  file_path: string;
  sheet?: string | null;
  header_row?: number;
  required_columns?: string[];
  type_rules?: Record<string, "int" | "float" | "str" | "date">;
  open_password?: string | null;
};

function buildUrl(path: string) {
  const base = api.defaults.baseURL ?? window.location.origin;
  return `${String(base).replace(/\/$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
}

async function readNdjsonStream(
  res: Response,
  onEvent: (ev: ProgressEvent) => void
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        // ignore malformed lines
      }
    }
  }
}

function asErrorWithCode(message: string, status?: number, code?: string) {
  const err = new Error(message) as Error & { status?: number; code?: string };
  if (status != null) err.status = status;
  if (code) err.code = code;
  return err;
}

/**
 * Stream NDJSON desde el endpoint ya existente:
 * /integrations/vima-to-lista/progress/{operation_id}
 *
 * Nota: el backend usa un ProgressManager compartido para varias operaciones.
 */
export async function subscribeOiToolsProgress(
  operationId: string,
  onEvent: (ev: ProgressEvent) => void,
  signal?: AbortSignal
) {
  const url = buildUrl(`/integrations/vima-to-lista/progress/${operationId}`);
  const token = getAuth()?.token;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: "application/x-ndjson",
      "Cache-Control": "no-cache",
    },
    signal,
  });

  if (!res.ok) {
    const code = res.headers.get("X-Code") ?? undefined;
    throw asErrorWithCode(`No se pudo abrir el stream (${res.status})`, res.status, code);
  }

  await readNdjsonStream(res, onEvent);
}

export async function subscribeLog01Progress(
  operationId: string,
  onEvent: (ev: ProgressEvent) => void,
  signal?: AbortSignal
) {
  const url = buildUrl(`/logistica/log01/progress/${operationId}`);
  const token = getAuth()?.token;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: "application/x-ndjson",
      "Cache-Control": "no-cache",
    },
    signal,
  });

  if (!res.ok) {
    const code = res.headers.get("X-Code") ?? undefined;
    throw asErrorWithCode(`No se pudo abrir el stream (${res.status})`, res.status, code);
  }

  const contentType = res.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/x-ndjson")) {
    throw asErrorWithCode("Stream no es NDJSON", res.status);
  }
  if (!res.body) {
    throw asErrorWithCode("Stream sin body", res.status);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let sawFirstByte = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!sawFirstByte && value && value.length) {
      logDev("[LOG01] progress first byte");
      sawFirstByte = true;
    }

    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as ProgressEvent;
        logDev("[LOG01] progress event =", ev);
        onEvent(ev);
      } catch {
        // ignore malformed lines
      }
    }
  }
}


export async function actualizacionBaseDryRunUpload(
  form: FormData,
  onEvent: (ev: ProgressEvent) => void,
  signal?: AbortSignal
) {
  const url = buildUrl("/bases/actualizar/dry-run-upload");
  const token = getAuth()?.token;

  const res = await fetch(url, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
    signal,
  });

  if (!res.ok) {
    const code = res.headers.get("X-Code") ?? undefined;
    let detail = `Error (${res.status})`;
    try {
      const data = (await res.json()) as any;
      if (data?.detail) detail = String(data.detail);
    } catch {}
    throw asErrorWithCode(detail, res.status, code);
  }

  await readNdjsonStream(res, onEvent);
}

export async function actualizacionBaseUpload(
  form: FormData,
  signal?: AbortSignal
): Promise<AxiosResponse<Blob>> {
  return api.post("/bases/actualizar/upload", form, { responseType: "blob", signal });
}

export async function log01Upload(
  form: FormData,
  signal?: AbortSignal
): Promise<AxiosResponse<Blob>> {
  return api.post("/logistica/log01/upload", form, { responseType: "blob", signal });
}

export type Log01StartResponse = {
  operation_id: string;
  status: "started";
};

export type Log01PollResponse = {
  cursor_next: number;
  events: ProgressEvent[];
  done: boolean;
  summary?: unknown;
};

export async function log01Start(
  form: FormData,
  signal?: AbortSignal
): Promise<AxiosResponse<Log01StartResponse>> {
  return api.post("/logistica/log01/start", form, { signal });
}

export async function pollLog01Progress(
  operationId: string,
  cursor: number,
  signal?: AbortSignal
): Promise<Log01PollResponse> {
  const url = buildUrl(`/logistica/log01/poll/${operationId}?cursor=${encodeURIComponent(cursor)}`);
  const token = getAuth()?.token;
  const res = await fetch(url, {
    method: "GET",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal,
  });

  if (!res.ok) {
    const code = res.headers.get("X-Code") ?? undefined;
    throw asErrorWithCode(`No se pudo hacer poll (${res.status})`, res.status, code);
  }

  return (await res.json()) as Log01PollResponse;
}

export async function log01Result(
  operationId: string,
  signal?: AbortSignal
): Promise<AxiosResponse<Blob>> {
  return api.get(`/logistica/log01/result/${encodeURIComponent(operationId)}`, {
    responseType: "blob",
    signal,
    validateStatus: (status) => status === 200,
  });
}

export async function log01NoConformeFinal(
  operationId: string,
  signal?: AbortSignal
): Promise<AxiosResponse<Blob>> {
  return api.get(`/logistica/log01/result/${encodeURIComponent(operationId)}/no-conforme`, {
    responseType: "blob",
    signal,
    validateStatus: (status) => status === 200,
  });
}

export async function log01Manifest(
  operationId: string,
  signal?: AbortSignal
): Promise<AxiosResponse<Blob>> {
  return api.get(`/logistica/log01/result/${encodeURIComponent(operationId)}/manifest`, {
    responseType: "blob",
    signal,
    validateStatus: (status) => status === 200,
  });
}

export async function cancelLog01Operation(operationId: string): Promise<void> {
  await api.post(`/logistica/log01/cancel/${encodeURIComponent(operationId)}`);
}

// ================================
// LOG-01 - Historial (PB-LOG-026)
// ================================

export type Log01HistoryItem = {
  id: number;
  operation_id: string;
  source: string;
  status: string;
  output_name?: string | null;
  created_at: string;
  completed_at?: string | null;
  created_by_username: string;
  created_by_full_name?: string | null;
  created_by_banco_id?: number | null;
  summary_json?: any;
  deleted_at?: string | null;
};



export type Log01HistoryListParams = {
  limit?: number;
  offset?: number;
  include_deleted?: boolean;
  q?: string;
  dateFrom?: string;
  dateTo?: string;
  source?: string;
  status?: string;
};

export type Log01HistoryListItem = {
  id: number;
  operation_id: string;
  source: string;
  status: string;
  output_name?: string | null;
  created_at: string;
  completed_at?: string | null;
  created_by_username: string;
  created_by_full_name?: string | null;
  created_by_banco_id?: number | null;
  summary_json?: unknown;
  deleted_at?: string | null;
};

export type Log01HistoryListResponse = {
  items: Log01HistoryListItem[];
  total: number;
  limit: number;
  offset: number;
};

export type Log01HistoryArtifact = {
  id: number;
  kind: string;
  filename: string;
  content_type: string;
  size_bytes?: number | null;
  created_at: string;
};

export type Log01HistoryDetail = {
  id: number;
  operation_id: string;
  source: string;
  status: string;
  output_name?: string | null;
  created_at: string;
  completed_at?: string | null;
  created_by_user_id?: number | null;
  created_by_username: string;
  created_by_full_name?: string | null;
  created_by_banco_id?: number | null;
  summary_json?: unknown;
  artifacts: Log01HistoryArtifact[];
  deleted_at?: string | null;
  deleted_by_username?: string | null;
  delete_reason?: string | null;
};

export async function log01HistoryList(
  params: Log01HistoryListParams = {}
): Promise<Log01HistoryListResponse>  {
  const {
    limit = 20,
    offset = 0,
    include_deleted = false,
    q,
    dateFrom,
    dateTo,
    source,
    status,
  } = params;
  const query: Record<string, unknown> = { limit, offset, include_deleted };
  if (q && q.trim()) query.q = q.trim();
  if (dateFrom && dateFrom.trim()) query.dateFrom = dateFrom.trim();
  if (dateTo && dateTo.trim()) query.dateTo = dateTo.trim();
  if (source && source.trim()) query.source = source.trim();
  if (status && status.trim()) query.status = status.trim();
  const { data } = await api.get<Log01HistoryListResponse>("/logistica/log01/history", {
    params: query,
  });
  return data;
}

export async function log01HistoryDetail(runId: number): Promise<Log01HistoryDetail> {
  const { data } = await api.get<Log01HistoryDetail>(
    `/logistica/log01/history/${encodeURIComponent(String(runId))}`
  );
  return data;
}

export const Log01HistoryDetail = log01HistoryDetail;

export async function log01HistoryDownloadArtifact(
  runId: number,
  kind: "excel" | "no-conforme" | "manifiesto",
  signal?: AbortSignal
): Promise<AxiosResponse<Blob>>  {
  return api.get(
    `/logistica/log01/history/${encodeURIComponent(String(runId))}/artifact/${encodeURIComponent(kind)}`,
    {
      responseType: "blob",
      signal,
      validateStatus: (status) => status === 200,
    }
  );
}

export async function log01HistoryDelete(runId: number, reason?: string): Promise<void> {
  await api.delete(`/logistica/log01/history/${encodeURIComponent(String(runId))}`, {
    data: reason ? { reason } : undefined,
  });
}

// =========================================
// LOG-02 (Logística) - Validación rutas UNC
// =========================================
export type Log02RutasCheck = {
  ruta: String;
  existe: boolean;
  es_directorio: boolean;
  lectura: boolean;
  escritura?: boolean | null;
  detalle?: string | null;
};

export type Log02ValidarRutasUncRequest = {
  rutas_origen: string[];
  ruta_destino: string;
};

export type Log02ValidarRutasUncResponse = {
  ok: boolean;
  origenes: Log02RutasCheck[];
  destino: Log02RutasCheck;
};

export async function log02ValidarRutasUnc(
  payload: Log02ValidarRutasUncRequest
): Promise<Log02ValidarRutasUncResponse> {
  const res = await api.post<Log02ValidarRutasUncResponse>(
    "/logistica/log02/validar-rutas-unc",
    payload
  );
  return res.data;
}


// ================================
// Formato A-C - Historial
// ================================

export type FormatoAcHistoryListItem = {
  id: number;
  operation_id: string;
  origin: string;
  status: string;
  output_name?: string | null;
  created_at: string;
  completed_at?: string | null;
  created_by_username: string;
  created_by_full_name?: string | null;
  created_by_banco_id?: number | null;
};

export type FormatoAcHistoryListResponse = {
  items: FormatoAcHistoryListItem[];
  total: number;
  limit: number;
  offset: number;
};

export type FormatoAcHistoryListParams = {
  limit?: number;
  offset?: number;
  q?: string;
  dateFrom?: string;
  dateTo?: string;
  origin?: string;
};

export async function formatoAcHistoryList(
  params: FormatoAcHistoryListParams = {}
): Promise<FormatoAcHistoryListResponse> {
  const { limit = 20, offset = 0, q, dateFrom, dateTo, origin } = params;
  const query: Record<string, unknown> = { limit, offset };
  if (q && q.trim()) query.q = q.trim();
  if (dateFrom && dateFrom.trim()) query.dateFrom = dateFrom.trim();
  if (dateTo && dateTo.trim()) query.dateTo = dateTo.trim();
  if (origin && origin.trim()) query.origin = origin.trim();
  const { data } = await api.get<FormatoAcHistoryListResponse>("/oi/tools/formato-ac/history", {
    params: query,
  });
  return data;
}

export async function formatoAcHistoryDownload(
  runId: number,
  signal?: AbortSignal
): Promise<AxiosResponse<Blob>> {
  return api.get(`/oi/tools/formato-ac/history/${encodeURIComponent(String(runId))}/artifact`, {
    responseType: "blob",
    signal,
    validateStatus: (status) => status === 200,
  });
}



export async function getMergeUploadLimits(): Promise<MergeUploadLimits> {
  const { data } = await api.get<MergeUploadLimits>("/merge/config/upload-limits");
  return data;
}

export async function mergeOisUpload(
  form: FormData,
  mode: "correlativo" | "no-correlativo",
  signal?: AbortSignal
): Promise<AxiosResponse<Blob>> {
  return api.post(`/merge/?mode=${encodeURIComponent(mode)}`, form, { responseType: "blob", signal });
}

export async function cancelMergeOperation(operationId: string): Promise<void> {
  await api.post(`/merge/cancel/${encodeURIComponent(operationId)}`);
}

export async function uploadOiToolFile(form: FormData): Promise<UploadedFileInfo> {
  const { data } = await api.post<UploadedFileInfo>("/tools/files/upload", form);
  return data;
}

export async function excelInspect(payload: ExcelInspectRequest): Promise<unknown> {
  const { data } = await api.post("/tools/excel/inspect", payload);
  return data as unknown;
}

export async function excelUpdate(payload: ExcelUpdateRequest): Promise<unknown> {
  const { data } = await api.post("/tools/excel/update", payload);
  return data as unknown;
}

export async function excelChangePassword(payload: ExcelChangePasswordRequest): Promise<unknown> {
  const { data } = await api.post("/tools/excel/change-password", payload);
  return data as unknown;
}

export async function excelValidate(payload: ExcelValidateRequest): Promise<unknown> {
  const { data } = await api.post("/tools/excel/validate", payload);
  return data as unknown;
}
