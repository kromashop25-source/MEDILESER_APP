import type { AxiosResponse } from "axios";
import { api } from "./client";
import { getAuth } from "./auth";

export type VimaToListaSummary = {
  ok: boolean;
  would_copy: number;
  start_write_row: number;
  last_oi_in_lista: string | null;
  first_oi_to_copy: string | null;
  last_oi_to_copy: string | null;
  replicate_merges: boolean;
};

export type ProgressEvent = {
  type: "status" | "progress" | "complete" | "error" | "hello";
  stage?: string;
  message?: string;
  progress?: number; // a veces llega como "progress"
  percent?: number;  // a veces llega como "percent"
  cursor?: number;
  result?: unknown;
  status?: number;
  detail?: string;
  code?: "PASSWORD_REQUIRED" | "WRONG_PASSWORD" | string;
};

function buildUrl(path: string) {
  const base = api.defaults.baseURL ?? window.location.origin;
  return `${String(base).replace(/\/$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
}

export async function vimaToListaDryRunUpload(
  form: FormData,
  signal?: AbortSignal
): Promise<AxiosResponse<VimaToListaSummary>> {
  return api.post("/integrations/vima-to-lista/dry-run-upload", form, { signal });
}

export async function vimaToListaUpload(
  form: FormData,
  signal?: AbortSignal
): Promise<AxiosResponse<Blob>> {
  return api.post("/integrations/vima-to-lista/upload", form, { responseType: "blob", signal });
}

/**
 * Lee NDJSON desde /integrations/vima-to-lista/progress/{operation_id}
 */
export async function subscribeVimaToListaProgress(
  operationId: string,
  onEvent: (ev: ProgressEvent) => void,
  signal?: AbortSignal
) {
  const url = buildUrl(`/integrations/vima-to-lista/progress/${operationId}`);

  const token = getAuth()?.token;
  const res = await fetch(url, {
    method: "GET",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`No se pudo abrir el stream de progreso (${res.status})`);
  }

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
        // si llega una línea incompleta, simplemente la ignoramos
      }
    }
  }
}
