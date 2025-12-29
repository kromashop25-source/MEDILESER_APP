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

export async function cancelLog01Operation(operationId: string): Promise<void> {
  await api.post(`/logistica/log01/cancel/${encodeURIComponent(operationId)}`);
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
