const TYPE_MAP: Record<string, string> = {
  status: "estado",
  progress: "progreso",
  complete: "completado",
  error: "error",
  file_retry: "reintentando",
};

const STAGE_MAP: Record<string, string> = {
  file: "archivo",
  file_done: "archivo procesado",
  file_error: "archivo con error",
  render: "generando",
  failed: "fallido",
  received: "recibido",
  loading: "cargando",
  upload: "subida",
  analysis: "análisis",
  init: "iniciando",
  processing: "procesamiento",
  opening: "abriendo",
  reading: "leyendo",
  writing: "escribiendo",
  saving: "guardando",
  cancelled: "cancelado",
  canceled: "cancelado",
  copied: "copiado",
  skipped: "omitido",
  skipped_incremental: "omitido (incremental)",
  stopped_blank: "detenido (en blanco)",
  complete: "completado",
  done: "finalizado",
  error: "error",
};

const WORD_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\\bcomplete(d)?\\b/gi, "completado"],
  [/\\bstopped_blank\\b/gi, "detenido (en blanco)"],
  [/\\bskipped_incremental\\b/gi, "omitido (incremental)"],
  [/\\bskipped\\b/gi, "omitido"],
  [/\\bprocessing\\b/gi, "procesando"],
  [/\\bopening\\b/gi, "abriendo"],
  [/\\breading\\b/gi, "leyendo"],
  [/\\bwriting\\b/gi, "escribiendo"],
  [/\\bsaving\\b/gi, "guardando"],
  [/\\breceived\\b/gi, "recibido"],
  [/\\bloading\\b/gi, "cargando"],
  [/\\bupload(ing)?\\b/gi, "subiendo"],
  [/\\bdownload(ing)?\\b/gi, "descargando"],
  [/\\bmerge(s|d|ing)?\\b/gi, "consolidando"],
];

function capitalize(s: string) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function translateProgressType(type?: string) {
  if (!type) return "";
  const key = type.toLowerCase();
  return capitalize(TYPE_MAP[key] ?? type);
}

export function translateProgressStage(stage?: string) {
  if (!stage) return "";
  const key = stage
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const fallback = stage.trim().replace(/[_-]+/g, " ");
  return capitalize(STAGE_MAP[key] ?? translateProgressMessage(fallback));
}

export function translateProgressMessage(message?: string) {
  if (!message) return "";
  let out = message;
  for (const [re, rep] of WORD_REPLACEMENTS) out = out.replace(re, rep);
  return out;
}
