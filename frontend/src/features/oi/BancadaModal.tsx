import { useForm, useFieldArray, useWatch } from "react-hook-form";
import { useEffect, useState, useRef, useCallback } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { BancadaRowForm } from "./schema";
import type { NumerationType } from "../../api/oi";

type RowConstraintErrors = {
  medidor_dup?: string;
  medidor_format?: string;
  q3_li?: string;
  q3_lf?: string;
  q2_li?: string;
  q2_lf?: string;
  q1_li?: string;
  q1_lf?: string;
};

const MEDIDOR_SERIE_RE = /^[A-Za-z0-9]{10}$/;
const normalizeMedidorKey = (value?: string | null) =>
  (value ?? "").trim().toUpperCase();

// Función para ajustar dinámicamente el ancho del input según su contenido
const handleAutoResize = (e: React.FormEvent<HTMLInputElement>) => {
  const target = e.currentTarget;
  // Mínimo 1 caracter para evitar colapso total, ajusta según longitud
  target.size = Math.max(1, target.value.length);
};


export type BancadaForm = {
  estado?: number; // Opcional o legacy
  rows: number;
  version?: string | null;
  rowsData: BancadaRowForm[];
  draftCreatedAt?: string | null;
  draftId?: string | null;
};

// Orden lógico de las columnas del Grid para la navegación con Enter
const GRID_COLUMN_ORDER = [
  "medidor",
  "estado",
  // Q3
  "q3.c1", "q3.c2", "q3.c3", "q3.c4", "q3.c5", "q3.c6", "q3.c7",
  // Q2
  "q2.c1", "q2.c2", "q2.c3", "q2.c4", "q2.c5", "q2.c6", "q2.c7",
  // Q1
  "q1.c1", "q1.c2", "q1.c3", "q1.c4", "q1.c5", "q1.c6", "q1.c7",
];

// Helper para enfocar y seleccionar todo el contenido de la celda
const focusAndSelect = (el: HTMLElement | null) => {
  if (!el) return;
  el.focus();

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.select();
  }
};

// Helper que respeta la excepción de la columna "# Medidor (G)"
const focusCell = (fieldPath: string, el: HTMLElement | null) => {
  if (!el) return;

  // En la columna "medidor" solo movemos el foco, SIN seleccionar el texto
  if (fieldPath === "medidor") {
    el.focus();
    return;
  }

  // En el resto de columnas mantenemos el comportamiento de seleccionar todo
  focusAndSelect(el);
};

type Props = {
  show: boolean;
  title: string;
  initial?: BancadaForm;
  onClose: () => void;
  onSubmit: (v: BancadaForm) => void;
  onCancelWithDraft?: (draft: BancadaForm) => void;
  numerationType: NumerationType;
  readOnly?: boolean;
  duplicateMap?: Record<string, { message: string }>;
  onClearDuplicate?: (value?: string | null) => void;
};

// Normaliza los valores numéricos que el usuario escribe con punto (.) o coma (,)
// Siempre devuelve un number (o null) usando el punto como separador interno.
// Ejemplos de entrada: "12,5" -> 12.5 ; "12.5" -> 12.5
const parseDecimalInput = (value: unknown): number | null => {
  if (value === "" || value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).replace(",", ".");
  const num = Number(normalized);
  return Number.isNaN(num) ? null : num;
};


// Helper para incrementar medidor (ej: PA01 -> PA02)
function incrementMedidor(base: string, index: number): string {
  if (!base) return "";
  const match = base.match(/^(.*?)(\d+)$/);
  if (!match) return base; // Si no hay número, devuelve igual
  const prefix = match[1];
  const numStr = match[2];
  const nextVal = parseInt(numStr, 10) + index;
  return `${prefix}${nextVal.toString().padStart(numStr.length, "0")}`;
}

// Helper que decide cómo autocompletar el # Medidor según el tipo de numeración
function autoMedidor(base: string, index: number, numerationType: NumerationType): string {
  if (!base) return "";

  if (numerationType === "no correlativo") {
    // En modo NO CORRELATIVO solo replicamos los 4 primeros caracteres
    // para que el técnico complete manualmente el resto si lo necesita.
    return base.slice(0, 4);
  }

  // En modo CORRELATIVO mantenemos el comportamiento actual (+index)
  return incrementMedidor(base, index);
}


// --- Lógica de Cálculos en Tiempo Real --

// Parsea tiempo flexible (ej: "2,31,120") a SEGUNDOS TOTALES (ej: 151.120)
function parseTimeToSeconds(val?: number | string | null): number {
  if (!val) return 0;
  const s = String(val).trim();
  // Detectar formato "Min,Seg,Ms" (ej: 2,31,120)
  const parts = s.split(/[:,\.]/).map(p => parseFloat(p)).filter(n => !isNaN(n));
  
  let totalSeconds = 0;

  if (parts.length >= 3) {
    // Caso: "2,31,120" -> Min, Seg, Ms
    const min = parts[0] || 0;
    const sec = parts[1] || 0;
    const ms = parts[2] || 0; 
    // Convertimos ms a segundos (120ms -> 0.120s)
    totalSeconds = (min * 60) + sec + (ms / 1000);
  } else if (parts.length === 2) {
    // Caso: "2,31" -> Min, Seg
    totalSeconds = (parts[0] * 60) + (parts[1] || 0);
  } else if (parts.length === 1) {
    // Caso: "151.12" -> Asumir que ya son segundos
    totalSeconds = parts[0];
  } else {
    const num = parseFloat(s.replace(",", "."));
    if (!isNaN(num)) {
      const minutes = Math.floor(num);
      const seconds = (num - minutes) * 100;
      totalSeconds = (minutes * 60) + seconds;
    }
  }

  return totalSeconds;
}

function calcFlow(vol?: number | null, timeVal?: number | null): number | null {
  if (!vol || !timeVal) return null;
  // timeVal AHORA son segundos totales. Convertimos a horas.
  const hours = timeVal > 0 ? timeVal / 3600 : 0;
  if (hours === 0) return null;
  return vol / hours; // Caudal = Vol / Tiempo(h)
}

function calcError(li?: number | null, lf?: number | null, vol?: number | null): number | null {
  if (li === undefined || lf === undefined || !vol) return null;
  // ((LF - LI - Vol) / Vol) * 100
  return ((Number(lf) - Number(li) - Number(vol)) / Number(vol)) * 100;
}



// Evalúa conformidad replicando la lógica compleja de Excel (BC, BB, BK, BL)
function calcConformity(estado: number | undefined | null, errQ3: number|null, errQ2: number|null, errQ1: number|null): string {
  // 1. Estado Físico (Columna I) - Muerte Súbita
  // Si es 1 (Daño), 2 (Fuga), etc., es NO CONFORME directo.
  if (estado && estado >= 1) return "NO CONFORME";

  // Si faltan datos de error, no podemos calcular
  if (errQ3 == null || errQ2 == null || errQ1 == null) return "";

  const absU = Math.abs(errQ3);   // Q3
  const absAG = Math.abs(errQ2);  // Q2
  const absAS = Math.abs(errQ1);  // Q1

  // 2. Fórmula BC (Criterio Ancho - Max Permisible)
  // =SI(ABS(U)>2,05;"NO";SI(ABS(AG)>2,05;"NO";SI(ABS(AS)>5,05;"NO";"CONFORME")))
  const isBC_Conforme = !(absU > 2.05 || absAG > 2.05 || absAS > 5.05);

  // 3. Fórmula BB (Criterio Estrecho - Excelencia)
  // =SI(ABS(U)<1,05;"CONFORME";SI(ABS(AG)<1,05;"CONFORME";SI(ABS(AS)<2,55;"CONFORME";"NO")))
  // Si ALGUNO de los puntos es muy bueno, BB da conforme (según tu fórmula).
  const isBB_Conforme = (absU < 1.05 || absAG < 1.05 || absAS < 2.55);

  // 4. Signos (BK) - ¿Apuntan todos al mismo lado?
  const s1 = Math.sign(errQ3);
  const s2 = Math.sign(errQ2);
  const s3 = Math.sign(errQ1);
  
  // Si todos son positivos (>=0) O todos son negativos (<=0) -> SIGIGUALES
  const isSigIguales = (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);

  // 5. Fórmula BL (Combinada)
  // Regla: Debe pasar BC (Límites) Y ADEMÁS pasar BB (Excelencia)
  const isBL_Conforme = isBC_Conforme && isBB_Conforme;

  // 6. Decisión Final (Estado)
  // Si SIGNOS DIFERENTES -> Usamos Criterio BC (Más permisivo)
  // Si SIGNOS IGUALES     -> Usamos Criterio BL (Exige excelencia en al menos un punto)
  if (!isSigIguales) {
    return isBC_Conforme ? "CONFORME" : "NO CONFORME";
  } else {
    return isBL_Conforme ? "CONFORME" : "NO CONFORME";
  }
}
// CORRECCIÓN: Componente auxiliar movido FUERA del componente principal para evitar warnings y remounts
type RenderResultProps = {
  val: number | null | undefined;
  /**
   * isErr = true  -> celda de Error % (E%)
   * isErr = false -> celda de Q (caudal)
   */
  isErr?: boolean;
  /** Rango “aceptable” |valor| <= warnThreshold */
  warnThreshold?: number;
  /** A partir de este valor |valor| se considera error fuerte */
  failThreshold?: number;
};

const RenderResult = ({
  val,
  isErr,
  warnThreshold,
  failThreshold,
}: RenderResultProps) => {
  const formatOneDecimal = (value: number) => {
    const rounded = Number(value.toFixed(1));
    if (Object.is(rounded, -0)) return "0.0";
    return rounded.toFixed(1);
  };

  // Q (caudal)
  if (!isErr) {
    return (
      <td className="bg-light">
        {val == null || isNaN(val) ? (
          <span className="text-muted">-</span>
        ) : (
          <span className={`vi-qe-value text-primary fw-semibold`}>
            {val.toFixed(2)}
          </span>
        )}
      </td>
    );
  }

  const absVal = Math.abs(val ?? 0);
  const warn = warnThreshold ?? failThreshold ?? 0;
  const fail = failThreshold ?? warnThreshold ?? 0;

  let cls = "vi-e-ok"; // dentro de tolerancia
  if (val == null || isNaN(val)) {
    cls = "";
  } else if (fail > 0 && absVal > fail) {
    cls = "vi-e-error"; // error fuerte
  } else if (warn > 0 && absVal > warn) {
    cls = "vi-e-warn"; // advertencia (fuera de rango pero aún no error fuerte)
  }

  return (
    <td className="bg-light">
      {val == null || isNaN(val) ? (
        <span className="text-muted">-</span>
      ) : (
        <span className={`vi-qe-value fw-bold ${cls}`}>
          {formatOneDecimal(val)}
        </span>
      )}
    </td>
  );
};

export default function BancadaModal({
  show,
  title,
  initial,
  onClose,
  onSubmit,
  onCancelWithDraft,
  numerationType,   // ?? NUEVO
  duplicateMap,
  onClearDuplicate,
  readOnly,
}: Props) {
  const defaultValues: BancadaForm = {
    estado: initial?.estado ?? 0,
    rows: initial?.rows ?? 15,
    version: initial?.version ?? null,
    draftCreatedAt: initial?.draftCreatedAt ?? null,
    draftId: initial?.draftId ?? null,
    rowsData:
    initial?.rowsData ??
    Array.from({ length: 15 }).map<BancadaRowForm>(() => ({
      medidor: "",
      estado: 0,
      q3: {},
      q2: {},
      q1: {},
    })),
  };
  const isReadOnly = readOnly === true;
  const { register, control, handleSubmit, reset, setValue, getValues } = useForm<BancadaForm>({
    defaultValues,
  });
  const rowsRegister = register("rows", { valueAsNumber: true });
  const { fields, replace, append, remove } = useFieldArray({
    control,
    name: "rowsData",
  });
  const [activeRow, setActiveRow] = useState(0);
  const lastActiveRowRef = useRef(0);
  const rowsInputRef = useRef<HTMLInputElement | null>(null);
  // Toggle de tamano de fuente del grid
  const [fontStep, setFontStep] = useState(0); // 0..5

const FONT_MIN = 0;
const FONT_MAX = 5;

const handleIncreaseFont = () => {
  if (fontStep >= FONT_MAX) {
    alert("Ya estas en el tamano maximo de fuente permitido para las filas (+5).");
    return;
  }
  setFontStep((prev) => Math.min(prev + 1, FONT_MAX));
};

const handleDecreaseFont = () => {
  if (fontStep <= FONT_MIN) {
    alert("Ya estas en el tamano minimo de fuente permitido para las filas.");
    return;
  }
  setFontStep((prev) => Math.max(prev - 1, FONT_MIN));
};

  const saveButtonRef = useRef<HTMLButtonElement | null>(null);
  const [rowConstraintErrors, setRowConstraintErrors] = useState<RowConstraintErrors[]>([]);
  const isEditingExisting = Boolean(initial?.version);
  const lastFocusRef = useRef<"rows" | "grid">("rows");
  const lastFocusFieldRef = useRef<string | null>(null);

  // PUNTOS A y C: seguimiento de filas con medidor editado manualmente
  const medidorManualMap = useRef<Map<string, boolean>>(new Map());
  const blockKeys = ["c1", "c2", "c3", "c4", "c5", "c6", "c7"] as const;

  // Marca como "manual" los medidores que ya vienen prellenados desde backend para no sobreescribirlos
  // si cambia el tipo de numeración al editar la OI. El usuario podrá habilitar el autofill limpiando/ajustando el valor.
  useEffect(() => {
    if (!initial?.rowsData?.length) return;
    fields.forEach((field, idx) => {
      if (idx === 0) return; // la fila base no se autocompleta
      const existing = initial.rowsData[idx]?.medidor;
      if (existing) {
        medidorManualMap.current.set(field.id, true);
      }
    });
  }, [initial, fields]);

  // PUNTO A: helper para enfocar la primera celda editable de la fila indicada
  // NOTA: rowIndex ya viene validado en los helpers (add/remove/clear),
  // así evitamos depender de fields.length "viejo" justo después de replace().
  const focusMedidorInput = useCallback((rowIndex: number) => {
    const safeIndex = rowIndex < 0 ? 0 : rowIndex;
    setActiveRow(safeIndex);

    // Esperamos al siguiente frame para que el DOM de la nueva fila ya exista
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>(
        `input.vi-medidor-input[data-row="${safeIndex}"]`
      );
      if (input) {
        input.focus();
        input.select();
      }
    });
  }, []);

  // Siempre usar la misma cantidad de filas que maneja useFieldArray (fields)
  const currentRows = (): BancadaRowForm[] => {
    const all = (getValues("rowsData") ?? []) as BancadaRowForm[];
    return all.slice(0, fields.length);
  };

  useEffect(() => {
    lastActiveRowRef.current = activeRow;
  }, [activeRow]);

const handleGridKeyDown = (
  e: ReactKeyboardEvent<HTMLTableSectionElement>
) => {
  const target = e.target as HTMLElement | null;
  if (!target) return;

  const tag = target.tagName;
  if (tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") {
    return;
  }

  const key = e.key;

  // ---------- ESC ? cerrar modal (Cancelar) ----------
  if (key === "Escape") {
    e.preventDefault();
    handleClose(); // usa el mismo handler del botón Cancelar
    return;
  }

  // ---------- Flechas y Enter dentro del Grid ----------
  if (
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "ArrowLeft" ||
    key === "ArrowRight" ||
    key === "Enter"
  ) {
    const inputEl = target as HTMLInputElement;
    const name = inputEl.name;
    if (!name || !name.startsWith("rowsData.")) return;

    const match = name.match(/^rowsData\.(\d+)\.(.+)$/);
    if (!match) return;

    const rowIndex = parseInt(match[1], 10);
    const fieldPath = match[2]; // p.ej. "q2.c4" o "medidor"
    const tbody = e.currentTarget as HTMLElement;
    const lastRowIndex = fields.length - 1;
    const findNextEnabledInColumn = (start: number, delta: number) => {
      let i = start + delta;
      while (i >= 0 && i <= lastRowIndex) {
        const selector = `[name="rowsData.${i}.${fieldPath}"]`;
        const next = tbody.querySelector<HTMLElement>(selector);
        if (next && !(next as HTMLInputElement).disabled) {
          return { index: i, el: next };
        }
        i += delta;
      }
      return null;
    };

    // ---------- ? / ? ? misma columna, fila anterior/siguiente ----------
    if (key === "ArrowUp" || key === "ArrowDown") {
      e.preventDefault();

      const delta = key === "ArrowUp" ? -1 : 1;
      const found = findNextEnabledInColumn(rowIndex, delta);
      if (found) {
        focusCell(fieldPath, found.el);
      }
      return;
    }

    // ---------- ? / ? ? misma fila, columna anterior/siguiente ----------
    if (key === "ArrowLeft" || key === "ArrowRight") {
      e.preventDefault();

      const colIndex = GRID_COLUMN_ORDER.indexOf(fieldPath);
      if (colIndex === -1) {
        return;
      }

      const delta = key === "ArrowRight" ? 1 : -1;
      const newColIndex = colIndex + delta;

      if (newColIndex < 0 || newColIndex >= GRID_COLUMN_ORDER.length) {
        return;
      }

      const nextFieldPath = GRID_COLUMN_ORDER[newColIndex];
      const selector = `[name="rowsData.${rowIndex}.${nextFieldPath}"]`;
      const next = tbody.querySelector<HTMLElement>(selector);
      if (next && !(next as HTMLInputElement).disabled) {
        focusAndSelect(next);
      }
      return;
    }

    // ---------- Enter ? bajar en la misma columna; última fila ? 1ª fila siguiente columna ----------
    if (key === "Enter") {
      e.preventDefault();

      const colIndex = GRID_COLUMN_ORDER.indexOf(fieldPath);
      if (colIndex === -1) {
        return;
      }

      // 1) Intentar bajar en la misma columna
      const downFound = findNextEnabledInColumn(rowIndex, 1);
      if (downFound) {
        focusCell(fieldPath, downFound.el);
        return;
      }

      // 2) Última fila ? ir a la 1ª fila de la siguiente columna
      const nextColIndex = colIndex + 1;
      if (nextColIndex < GRID_COLUMN_ORDER.length) {
        const nextFieldPath = GRID_COLUMN_ORDER[nextColIndex];
        // buscar la primera fila habilitada en la siguiente columna
        for (let i = 0; i <= lastRowIndex; i++) {
          const selector = `[name="rowsData.${i}.${nextFieldPath}"]`;
          const next = tbody.querySelector<HTMLElement>(selector);
          if (next && !(next as HTMLInputElement).disabled) {
            focusAndSelect(next);
            return;
          }
        }
      }

      // 3) Última columna + última fila ? botón Guardar Bancada
      if (saveButtonRef.current) {
        saveButtonRef.current.focus();
      }
      return;
    }
  }

  // ---------- TAB ? comportamiento lineal (como antes) ----------
  if (key !== "Tab") {
    return;
  }

  const tbody = e.currentTarget as HTMLElement;

  // Inputs/selects ordenados tal como el DOM (igual que el Tab normal)
  const focusables = Array.from(
    tbody.querySelectorAll<HTMLElement>("input, select, textarea")
  ).filter((el) => !el.hasAttribute("disabled"));

  const currentIndex = focusables.indexOf(target as HTMLElement);
  if (currentIndex === -1) return;

  const isShiftTab = key === "Tab" && e.shiftKey;

  // Shift+Tab: retroceder dentro del grid
  if (isShiftTab) {
    if (currentIndex > 0) {
      e.preventDefault();
      focusables[currentIndex - 1].focus();
    }
    // Si estamos en la primera celda, dejamos que el navegador
    // haga el Shift+Tab normal (sale del grid).
    return;
  }

  // Tab normal ? avanzar
  const nextIndex = currentIndex + 1;

  // Si aún hay más celdas dentro del grid
  if (nextIndex < focusables.length) {
    e.preventDefault();
    focusables[nextIndex].focus();
    return;
  }

  // Última celda del grid ? saltar a "Guardar Bancada"
  if (saveButtonRef.current) {
    e.preventDefault();
    saveButtonRef.current.focus();
  }
};

  // Helper centralizado para mantener sincronizados useFieldArray, "rows" y la fila activa
  const syncRows = (nextRows: BancadaRowForm[], nextActiveIndex?: number) => {
    replace(nextRows);
    setValue("rows", nextRows.length);
    setActiveRow(prev => {
      if (nextRows.length === 0) return 0;
      if (typeof nextActiveIndex === "number") {
        return Math.max(0, Math.min(nextActiveIndex, nextRows.length - 1));
      }
      return Math.min(prev, nextRows.length - 1);
    });
  };

  const makeEmptyRow = (): BancadaRowForm => ({
    medidor: "",
    estado: 0, // Inicializamos estado en 0 (Conforme)
    q3: {
      c1: null, c2: null, c3: null, c4: null, c5: null, c6: null,
      c7: "",   // campo de tiempo como texto
      c7_seconds: null,
    },
    q2: {
      c1: null, c2: null, c3: null, c4: null, c5: null, c6: null,
      c7: "",
      c7_seconds: null,
    },
    q1: {
      c1: null, c2: null, c3: null, c4: null, c5: null, c6: null,
      c7: "",
      c7_seconds: null,
    },
  });

  // HELPER INVERSO: Al cargar del backend, convertir "12,5" -> "12.5"
  // Esto es necesario porque <input type="number"> rechaza las comas y se muestra vacío.
  const normalizeFromBackend = (val: any): any => {
    if (val === null || val === undefined) return "";
    if (typeof val === "number") return val;
    if (typeof val === "string") {
      // Si viene con coma decimal, la pasamos a punto para que el input la acepte
      return val.replace(",", ".");
    }
    return val;
  };

  const processBlockFromBackend = (block: any) => {
    if (!block) return {};
    const newBlock = { ...block };
    // Normalizamos todos los campos c1..c7
    ["c1", "c2", "c3", "c4", "c5", "c6"].forEach((k) => {
      newBlock[k] = normalizeFromBackend(newBlock[k]);
    });
    // c7 se mantiene igual (texto de tiempo: "m,ss,ms")
    return newBlock;
  };

  // Construye los valores del formulario a partir de `initial`
  const buildInitialFormValues = (): BancadaForm => {
    const totalRows =
      initial?.rowsData?.length ??
      initial?.rows ??
      15;

    const normalizedRows =
      (initial?.rowsData && initial.rowsData.length > 0
        ? initial.rowsData
        : Array.from({ length: totalRows }).map(() => ({ medidor: "", estado: 0, q3: {}, q2: {}, q1: {} })))
        .map(row => ({
          medidor: row.medidor ?? "",
          estado: row.estado ?? 0, // Aseguramos que exista
          q3: processBlockFromBackend(row.q3),
          q2: processBlockFromBackend(row.q2),
          q1: processBlockFromBackend(row.q1),
        }));

    return {
      rows: normalizedRows.length,
      rowsData: normalizedRows,
      version: initial?.version ?? null,
      estado: initial?.estado ?? 0,
      draftCreatedAt: initial?.draftCreatedAt ?? null,
      draftId: initial?.draftId ?? null,
    };
  };

  // Helpers de validación
  const isEmptyValue = (val: any): boolean =>
    val === undefined ||
    val === null ||
    val === "" ||
    (typeof val === "number" && Number.isNaN(val));

  const rowHasAnyValue = (row: BancadaRowForm): boolean => {
    if (!row) return false;
    const estadoFisico = Number(row.estado ?? 0);
    // NUEVO: si el estado físico es distinto de 0,
    // consideramos que la fila "tiene datos" aunque no haya lecturas.
    if (estadoFisico !== 0) {
      return true;
    }

    // Fila con medidor también cuenta como "con datos"
    if (row.medidor && row.medidor.toString().trim() !== "") return true;

    return hasAnyBlockData(row);
  };

  const hasAnyBlockData = (row: BancadaRowForm): boolean => {
    const blocks = [row.q3, row.q2, row.q1];
    for (const block of blocks) {
      if (!block) continue;
      for (const key of blockKeys) {
        if (!isEmptyValue((block as any)[key])) return true;
      }
    }
    return false;
  };

  // Deja Temp, P.Ent, P.Sal, Vol, Tpo, etc. tal como están
  // y solo limpia las lecturas L.I (c4) y L.F (c5)
  const stripManualLecturas = (block?: any) => {
    if (!block) {
      return { c4: null, c5: null };
    }

    return {
      ...block,
      c4: null,
      c5: null,
    };
  };

    // Normaliza L.I (c4) y L.F (c5): si están vacíos, se fuerzan a null
  const normalizeLecturasBlock = (block?: any) => {
    if (!block) return block;
    const cloned = { ...block };
    if (isEmptyValue(cloned.c4)) cloned.c4 = null;
    if (isEmptyValue(cloned.c5)) cloned.c5 = null;
    return cloned;
  };



  const validateRows = (rows: BancadaRowForm[]): string | null => {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const estadoFisico = Number(row.estado ?? 0);
      const permiteIncompletos = estadoFisico !== 0; // NUEVO
      const hasAny = rowHasAnyValue(row);
      if (!hasAny) {
        // Fila completamente vacía: la permitimos, luego la filtramos antes de enviar
        continue;
      }

      // # Medidor obligatorio si hay datos
      if (!row.medidor || row.medidor.toString().trim() === "") {
        return `La fila ${i + 1} tiene datos pero el campo "# Medidor (G)" está vacío. Completa el valor o elimina la fila.`;
      }

      const blocks = [
        { name: "Q3 (Nominal)", block: row.q3 },
        { name: "Q2 (Transición)", block: row.q2 },
        { name: "Q1 (Mínimo)", block: row.q1 },
      ];

      // Si el estado es 0, debe haber al menos algún dato en Q3/Q2/Q1
      const hasBlockData = blocks.some(({ block }) =>
        block && blockKeys.some(k => !isEmptyValue((block as any)[k]))
      );
      if (estadoFisico === 0 && !hasBlockData) {
        return `La fila ${i + 1} no tiene lecturas. Ingresa datos en Q3/Q2/Q1 o elimina la fila.`;
      }

      // Si el estado físico es distinto de 0, permitimos que los bloques estén incompletos
      if (permiteIncompletos) {
        continue;
      }

      for (const { name, block } of blocks) {
        if (!block) continue;

        const blockHasAny = blockKeys.some(k => !isEmptyValue((block as any)[k]));
        if (!blockHasAny) {
          // Bloque sin datos: lo dejamos pasar (caso en que esa etapa no se use)
          continue;
        }

        // NUEVO:
        // Si el estado de la fila es distinto de 0 (1-5),
        // se permite que el bloque tenga datos incompletos.
        // El técnico puede registrar solo parte de la información
        // o dejar el bloque casi en blanco.
        const blockHasEmpty = blockKeys.some(k => isEmptyValue((block as any)[k]));
        if (blockHasEmpty) {
          return `La fila ${i + 1} tiene datos incompletos en el bloque ${name}. Completa todos los campos o elimina la fila.`;
        }
      }
    }
    return null;
  };

// HELPER: Normaliza puntos a comas para el Excel final
  const formatForExcel = (val: any): any => {
    if (val === null || val === undefined || val === "") return null;
    // Convertimos a string y reemplazamos TODOS los puntos por comas
    return String(val).replace(/\./g, ",");
  };

  // HELPER: Procesa un bloque completo (Q3, Q2, Q1)
  const processBlockForExcel = (block: any) => {
    if (!block) return {};
    const newBlock = { ...block };
    // Campos c1..c7 (incluyendo tiempos y lecturas)
    ["c1", "c2", "c3", "c4", "c5", "c6", "c7"].forEach((k) => {
      newBlock[k] = formatForExcel(newBlock[k]);
    });
    return newBlock;
  };

  // --- Validaciones L.F / L.I y cruces entre bloques ---
  const computeConstraintErrors = (rows: BancadaRowForm[]) => {
    const result: RowConstraintErrors[] = [];
    let firstMessage: string | null = null;

    const setErr = (rowIndex: number, field: keyof RowConstraintErrors, msg: string) => {
      if (!result[rowIndex]) result[rowIndex] = {};
      (result[rowIndex] as any)[field] = msg;
      if (!firstMessage) {
        firstMessage = `Fila ${rowIndex + 1}: ${msg}`;
      }
    };

    const medidorCounts: Record<string, number> = {};
    rows.forEach((row) => {
      const key = (row.medidor ?? "").trim();
      if (!key) return;
      medidorCounts[key] = (medidorCounts[key] ?? 0) + 1;
    });

    rows.forEach((row, i) => {
      const q3 = row.q3 || {};
      const q2 = row.q2 || {};
      const q1 = row.q1 || {};

      const q3_li = q3.c4 as number | null | undefined;
      const q3_lf = q3.c5 as number | null | undefined;
      const q2_li = q2.c4 as number | null | undefined;
      const q2_lf = q2.c5 as number | null | undefined;
      const q1_li = q1.c4 as number | null | undefined;
      const q1_lf = q1.c5 as number | null | undefined;

      // Dentro de cada bloque: LF >= LI
      if (q3_li != null && q3_lf != null && !Number.isNaN(q3_li) && !Number.isNaN(q3_lf)) {
        if (q3_lf < q3_li) {
          setErr(i, "q3_lf", "En Q3 L.F debe ser mayor o igual que L.I.");
        }
      }
      if (q2_li != null && q2_lf != null && !Number.isNaN(q2_li) && !Number.isNaN(q2_lf)) {
        if (q2_lf < q2_li) {
          setErr(i, "q2_lf", "En Q2 L.F debe ser mayor o igual que L.I.");
        }
      }
      if (q1_li != null && q1_lf != null && !Number.isNaN(q1_li) && !Number.isNaN(q1_lf)) {
        if (q1_lf < q1_li) {
          setErr(i, "q1_lf", "En Q1 L.F debe ser mayor o igual que L.I.");
        }
      }

      // Cruces entre bloques
      if (
        q3_lf != null &&
        q2_li != null &&
        !Number.isNaN(q3_lf) &&
        !Number.isNaN(q2_li) &&
        q2_li < q3_lf
      ) {
        setErr(i, "q2_li", "L.I de Q2 debe ser mayor o igual que L.F de Q3.");
      }

      if (
        q2_lf != null &&
        q1_li != null &&
        !Number.isNaN(q2_lf) &&
        !Number.isNaN(q1_li) &&
        q1_li < q2_lf
      ) {
        setErr(i, "q1_li", "L.I de Q1 debe ser mayor o igual que L.F de Q2.");
      }

      const medidorKey = (row.medidor ?? "").trim();
      if (medidorKey && medidorCounts[medidorKey] > 1) {
        setErr(i, "medidor_dup", "Serie de medidor repetida.");
      }
      if (medidorKey && !MEDIDOR_SERIE_RE.test(medidorKey)) {
        setErr(i, "medidor_format", "La serie del medidor debe tener 10 caracteres alfanuméricos.");
      }
    });

    return { rowErrors: result, firstMessage };
  };


  const handleValidSubmit = (data: BancadaForm) => {
    if (isReadOnly) {
      return;
    }
    // 1) Validaciones de filas vacías / medidor / bloques incompletos
    const visibleRows = (data.rowsData ?? []).slice(0, fields.length);
    const basicError = validateRows(visibleRows);
    if (basicError) {
      alert(basicError);
      return;
    }

    // 2) Validaciones de restricciones L.F/L.I y cruces
    const { rowErrors, firstMessage } = computeConstraintErrors(visibleRows as BancadaRowForm[]);
    setRowConstraintErrors(rowErrors);
    if (firstMessage) {
      alert(firstMessage);
      return;
    }

    // 3) Si todo está OK, limpiar filas vacías y formatear para Excel
    const cleanedRows = visibleRows.filter(rowHasAnyValue);
    const finalRows = cleanedRows.map((row) => {
      const estadoFisico = Number(row.estado ?? 0);
      const isLockedEstado = estadoFisico >= 1 && estadoFisico <= 4;
      const isParalizadoSinLecturas = estadoFisico === 5 && !hasAnyBlockData(row);
      const shouldSendEmpty = isLockedEstado || isParalizadoSinLecturas;

      // Normalizamos lecturas vacías antes de decidir qué mandar
      const q3Norm = normalizeLecturasBlock(row.q3);
      const q2Norm = normalizeLecturasBlock(row.q2);
      const q1Norm = normalizeLecturasBlock(row.q1);

      const formatBlock = (block: any) => {
        if (shouldSendEmpty) {
          const preserved = stripManualLecturas(block);
          return processBlockForExcel(preserved);
        }
        return processBlockForExcel(block);
      };

      return {
        ...row,
        q3: formatBlock(q3Norm),
        q2: formatBlock(q2Norm),
        q1: formatBlock(q1Norm),
      };
    });

    
    const payload: BancadaForm = {
      ...data,
      rows: finalRows.length,
      rowsData: finalRows,
      version: data.version ?? initial?.version ?? null,
    };
    onSubmit(payload);
  };



  // Observar la fila 1 para replicar
  // Observar la fila 1 para replicar
const firstRow = useWatch({ control, name: "rowsData.0" });
const allRows = useWatch({ control, name: "rowsData" });

// Tiempo en texto de la fila base (Q3, Q2, Q1)
const q3TimeText = useWatch({ control, name: "rowsData.0.q3.c7" });
const q2TimeText = useWatch({ control, name: "rowsData.0.q2.c7" });
const q1TimeText = useWatch({ control, name: "rowsData.0.q1.c7" });

// Calcula los segundos totales a partir del texto "m,ss,ms"
useEffect(() => {
  // Si aún no existe la fila base, no hacemos nada
  if (!fields[0]) return;

  setValue("rowsData.0.q3.c7_seconds", parseTimeToSeconds(q3TimeText as any));
  setValue("rowsData.0.q2.c7_seconds", parseTimeToSeconds(q2TimeText as any));
  setValue("rowsData.0.q1.c7_seconds", parseTimeToSeconds(q1TimeText as any));
}, [q3TimeText, q2TimeText, q1TimeText, setValue, fields]);

// Recalcular restricciones cada vez que cambian las filas
useEffect(() => {
  const rows = (allRows as BancadaRowForm[]) ?? [];
  const { rowErrors } = computeConstraintErrors(rows);
  setRowConstraintErrors(rowErrors);
}, [allRows]);

// Lógica de replicación y autocompletado (PUNTO C)
useEffect(() => {
  if (!firstRow || fields.length <= 1) return;

  const rowsSnapshot = (allRows as BancadaRowForm[]) ?? [];

  fields.forEach((field, i) => {
    if (i === 0) return; // Saltar fila base

    const rowId = field.id;
    const isManual = medidorManualMap.current.get(rowId) ?? false;

    // 1. Autocompletar Medidor solo si no fue editado manualmente.
    if (!isManual) {
      setValue(
        `rowsData.${i}.medidor`,
        autoMedidor(firstRow.medidor || "", i, numerationType)
      );
    }

    // 2. Replicar Estado solo si la fila no trae valor propio
    const estadoActual = rowsSnapshot[i]?.estado;
    const shouldCopyEstado =
      estadoActual === undefined ||
      estadoActual === null ||
      Number.isNaN(estadoActual as number);
    if (shouldCopyEstado) {
      setValue(`rowsData.${i}.estado`, firstRow.estado);
    }

    // 3. Replicar Q3/Q2/Q1 (sin lecturas c4/c5), SIEMPRE, aunque el estado sea != 0

    // Q3
    setValue(`rowsData.${i}.q3.c1`, firstRow.q3?.c1 ?? null);
    setValue(`rowsData.${i}.q3.c2`, firstRow.q3?.c2 ?? null);
    setValue(`rowsData.${i}.q3.c3`, firstRow.q3?.c3 ?? null);
    setValue(`rowsData.${i}.q3.c6`, firstRow.q3?.c6 ?? null);
    setValue(`rowsData.${i}.q3.c7`, firstRow.q3?.c7 ?? "");
    setValue(`rowsData.${i}.q3.c7_seconds`, firstRow.q3?.c7_seconds ?? null);

    // Q2
    setValue(`rowsData.${i}.q2.c1`, firstRow.q2?.c1 ?? null);
    setValue(`rowsData.${i}.q2.c2`, firstRow.q2?.c2 ?? null);
    setValue(`rowsData.${i}.q2.c3`, firstRow.q2?.c3 ?? null);
    setValue(`rowsData.${i}.q2.c6`, firstRow.q2?.c6 ?? null);
    setValue(`rowsData.${i}.q2.c7`, firstRow.q2?.c7 ?? "");
    setValue(`rowsData.${i}.q2.c7_seconds`, firstRow.q2?.c7_seconds ?? null);

    // Q1
    setValue(`rowsData.${i}.q1.c1`, firstRow.q1?.c1 ?? null);
    setValue(`rowsData.${i}.q1.c2`, firstRow.q1?.c2 ?? null);
    setValue(`rowsData.${i}.q1.c3`, firstRow.q1?.c3 ?? null);
    setValue(`rowsData.${i}.q1.c6`, firstRow.q1?.c6 ?? null);
    setValue(`rowsData.${i}.q1.c7`, firstRow.q1?.c7 ?? "");
    setValue(`rowsData.${i}.q1.c7_seconds`, firstRow.q1?.c7_seconds ?? null);
  });
}, [firstRow, allRows, fields, setValue, numerationType]);



  

  useEffect(() => {
    setActiveRow(prev => {
      const maxIndex = Math.max(fields.length - 1, 0);
      return prev > maxIndex ? maxIndex : prev;
    });
  }, [fields.length]);
   
  const handleAddRow = () => {
    if (fields.length >= 50) {
      setValue("rows", 50);
      focusMedidorInput(0);
      const confirmSet = confirm("El maximo de filas es 50. ¿Quieres fijar la lista en 50 filas?");
      if (!confirmSet) {
        if (rowsInputRef.current) {
          rowsInputRef.current.focus();
          rowsInputRef.current.select();
        }
        return;
      }
      return;
    }
    append(makeEmptyRow());
    setValue("rows", fields.length + 1);
    focusMedidorInput(fields.length);
  };

  const removeRowAt = (index: number) => {
    if (fields.length <= 1) return;
    const target = Math.max(0, Math.min(index, fields.length - 1));
    remove(target);
    setValue("rows", Math.max(fields.length - 1, 1));
    focusMedidorInput(Math.max(0, target - (target === fields.length - 1 ? 1 : 0)));
  };

  const handleRemoveLastRow = () => {
    if (fields.length <= 1) return;
    remove(fields.length - 1);
    setValue("rows", Math.max(fields.length - 1, 1));
    focusMedidorInput(Math.max(0, fields.length - 2));
  };

    // Función para limpiar toda la tabla manteniendo la cantidad actual de filas
  const handleClearAll = () => {
    if (!confirm("¿Estás seguro de limpiar todos los datos de la bancada?")) return;

    const rows = currentRows();
    if (!rows.length) return;

    // Genera la misma cantidad de filas, pero vacías
    const cleanRows = rows.map(() => makeEmptyRow());

    // Usamos el helper centralizado para mantener: rowsData + rows + activeRow sincronizados
    syncRows(cleanRows, 0);
    focusMedidorInput(0);
  };

  const handleRowsBlur = () => {
    let target = Number(getValues("rows"));
    if (!Number.isFinite(target) || target < 1) {
      target = 1;
    }
    if (target > 50) {
      const rows = currentRows();
      const confirmSet = confirm("El maximo de filas es 50. ¿Quieres usar 50 filas?");
      if (!confirmSet) {
        setValue("rows", rows.length);
        if (rowsInputRef.current) {
          rowsInputRef.current.focus();
          rowsInputRef.current.select();
        }
        return;
      }
      target = 50;
    }

    const rows = currentRows();
    if (target !== rows.length) {
      const confirmSet = confirm(`La lista tendrá ${target} filas. ¿Quieres continuar?`);
      if (!confirmSet) {
        setValue("rows", rows.length);
        if (rowsInputRef.current) {
          rowsInputRef.current.focus();
          rowsInputRef.current.select();
        }
        return;
      }
    }

    if (target === rows.length) {
      setValue("rows", target);
      return;
    }

    if (target > rows.length) {
      const extraCount = Math.min(target, 50) - rows.length;
      if (extraCount > 0) {
        const extra = Array.from({ length: extraCount }, () => makeEmptyRow());
        const nextRows = [...rows, ...extra];
        syncRows(nextRows, activeRow);
        focusMedidorInput(rows.length);
      } else {
        setValue("rows", rows.length);
      }
      return;
    }

    // target < rows.length
    const nextRows = rows.slice(0, target);
    syncRows(nextRows, Math.min(activeRow, target - 1));
  };

  const handleRowsKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleRowsBlur();
      focusMedidorInput(0);
    }
  };
  // Cerrar modal descartando cambios (vuelve a `initial`)
  const handleClose = () => {
    const currentValues = getValues();
    const activeEl = document.activeElement;
    if (rowsInputRef.current && activeEl === rowsInputRef.current) {
      lastFocusRef.current = "rows";
      lastFocusFieldRef.current = "rows";
    } else if (activeEl && activeEl instanceof HTMLElement) {
      const nameAttr = activeEl.getAttribute("name");
      if (nameAttr && nameAttr.startsWith("rowsData.")) {
        lastFocusRef.current = "grid";
        lastFocusFieldRef.current = nameAttr;
      } else {
        lastFocusRef.current = "grid";
        lastFocusFieldRef.current = null;
      }
    } else {
      lastFocusRef.current = "grid";
      lastFocusFieldRef.current = null;
    }
    if (onCancelWithDraft) {
      onCancelWithDraft(currentValues);
    }
    onClose();
  };

   // PUNTO B: Atajos globales (Esc / Ctrl+ / Ctrl-)
  useEffect(() => {
    if (!show) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose();
        return;
      }
      if ((event.key === "+" || event.key === "=") && event.ctrlKey) {
        event.preventDefault();
        handleAddRow();
        return;
      }
      if ((event.key === "-" || event.key === "_") && event.ctrlKey) {
        event.preventDefault();
        handleRemoveLastRow();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [show, handleAddRow, handleRemoveLastRow, handleClose]);

  useEffect(() => {
    const formValues = buildInitialFormValues();
    reset(formValues);
    syncRows(formValues.rowsData, 0);
    medidorManualMap.current.clear();
    requestAnimationFrame(() => {
      if (isEditingExisting) {
        focusMedidorInput(0);
      } else if (lastFocusFieldRef.current) {
        const el = document.querySelector<HTMLInputElement | HTMLSelectElement>(
          `[name="${lastFocusFieldRef.current}"]`
        );
        if (el) {
          el.focus();
          if ("select" in el) {
            (el as HTMLInputElement).select?.();
          }
          return;
        }
        focusMedidorInput(lastActiveRowRef.current || 0);
      } else if (rowsInputRef.current) {
        rowsInputRef.current.focus();
        rowsInputRef.current.select();
      }
    });
  }, [initial, reset, replace, focusMedidorInput, isEditingExisting]);

  useEffect(() => {
    if (!show) return;
    requestAnimationFrame(() => {
      if (isEditingExisting) {
        focusMedidorInput(0);
      } else if (lastFocusFieldRef.current) {
        const el = document.querySelector<HTMLInputElement | HTMLSelectElement>(
          `[name="${lastFocusFieldRef.current}"]`
        );
        if (el) {
          el.focus();
          if ("select" in el) {
            (el as HTMLInputElement).select?.();
          }
          return;
        }
        focusMedidorInput(lastActiveRowRef.current || 0);
      } else if (rowsInputRef.current) {
        rowsInputRef.current.focus();
        rowsInputRef.current.select();
      }
    });
  }, [show, focusMedidorInput, isEditingExisting]);

  const hasConstraintErrors = rowConstraintErrors.some(
    (r) => r && Object.values(r).some(Boolean)
  );


  if (!show) return null;

  return (
  <>
    <div
      className="modal d-block"
      tabIndex={-1}
      role="dialog"
      onClick={(e) => {
        // cierra al hacer click fuera del diálogo
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      {/* ESTILO: Ocultar flechas de inputs numéricos para limpiar la vista */}
                  <style>{`        /* Ocultar flechas de inputs numéricos para limpiar la vista */
        input[type=number]::-webkit-inner-spin-button,
        input[type=number]::-webkit-outer-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }
        input[type=number] {
          -moz-appearance: textfield;
        }

        /* Ancho minimo para columnas compactas (Temp, P.Ent, etc.) */
        .vi-min-width {
          min-width: 70px;
        }

        /* Estilo spreadsheet tipo Excel (modo claro) */
        .vi-spreadsheet {
          background-color: #ffffff;
          color: #212529;
          font-size: 0.75rem;
          table-layout: auto;
          width: max-content;
        }

        .vi-spreadsheet th,
        .vi-spreadsheet td {
          white-space: nowrap;
        }

        .vi-spreadsheet thead th {
          background-color: #e6f3ff;
          color: #0c2b4d;
          vertical-align: middle;
          padding: 0.25rem 0.35rem;
        }

        .vi-spreadsheet thead th.vi-header-at,
        .vi-spreadsheet thead th.vi-header-quitar,
        .vi-spreadsheet td.vi-at-valor {
          color: #212529 !important;
        }

                .vi-spreadsheet td.vi-row-index,
        .vi-spreadsheet th.vi-row-index {
          color: #0c2b4d;
        }

        /* Columna índice (#) fija al hacer scroll horizontal */
        .vi-spreadsheet th.vi-row-index {
          position: sticky;
          left: 0;
          z-index: 3;
          background-color: #e6f3ff; /* mismo fondo que otros headers */
        }

        .vi-spreadsheet td.vi-row-index {
          position: sticky;
          left: 0;
          z-index: 2;
          background-color: inherit;
        }

        /* Columna # Medidor (G) fija, justo después del índice de fila */
        .vi-spreadsheet th.vi-sticky-medidor,
        .vi-spreadsheet td.vi-sticky-medidor {
          position: sticky;
          left: 30px; /* coincide con width:"30px" de la columna # */
        }

        .vi-spreadsheet thead th.vi-sticky-medidor {
          z-index: 3;
          background-color: #e6f3ff;
        }

        .vi-spreadsheet tbody td.vi-sticky-medidor {
          z-index: 2;
          background-color: inherit;
        }


        .vi-spreadsheet tr.vi-base-row td.vi-row-index {
          background-color: #d6e9ff !important;
          color: #0c2b4d !important;
          font-weight: 600;
        }

        .vi-spreadsheet td.vi-at-valor {
          transition: color 0.15s ease-in-out;
        }

        .vi-spreadsheet td.vi-at-valor:hover {
          color: #0a58ca !important;
        }

        .vi-spreadsheet tr.table-active td.vi-at-valor {
          color: #0c2b4d !important;
        }

        .vi-spreadsheet tbody td {
          padding: 0.15rem 0.25rem;
        }

        .vi-spreadsheet tr.table-active > td {
          background-color: #d9ecff !important;
          color: #0c2b4d !important;
        }

        .vi-spreadsheet tr.table-active input.form-control {
          background-color: #ffffff;
          color: #0c2b4d;
          border-color: #b6d4fe;
        }

        .vi-spreadsheet tr.vi-base-row.table-active > td {
          background-color: #d9ecff !important;
          color: #0c2b4d !important;
        }

        .vi-spreadsheet.table-hover tbody tr:not(.table-active):hover > td {
          background-color: inherit;
          color: inherit;
        }

        .vi-spreadsheet input.form-control {
          background-color: #ffffff;
          border-color: #ced4da;
          color: #212529;
          font-size: 0.75rem;
          padding: 0.05rem 0.25rem;
          height: 1.7rem;
        }

        .vi-spreadsheet input.form-control:disabled,
        .vi-spreadsheet input.form-control[readonly] {
          background-color: #e9ecef;
          color: #6c757d;
          opacity: 1;
        }

        /* Resaltado de fila BASE solo en columna índice */
        .vi-spreadsheet tr.vi-base-row > td {
          background-color: transparent;
        }

        /* PUNTO E - colores de la columna de conformidad */
        .vi-spreadsheet td.vi-at-valor.vi-at-valor--fail {
          color: #b02a37 !important;
          background-color: #f8d7da;
        }
        .vi-spreadsheet td.vi-at-valor.vi-at-valor--ok {
          color: #0f9d58 !important;
        }

        /* Colores para celdas de Error % (E%) según rangos */
        .vi-spreadsheet .vi-e-ok {
          color: #198754; /* verde: dentro de tolerancia */
        }
        .vi-spreadsheet .vi-e-warn {
          color: #fd7e14; /* naranja intenso: advertencia */
        }
        .vi-spreadsheet .vi-e-error {
          color: #b02a37; /* rojo oscuro: error fuerte */
        }

        /* Resaltado suave de la celda enfocada (no agresivo) */
        .vi-spreadsheet input.form-control:focus,
        .vi-spreadsheet select.form-select:focus,
        .vi-spreadsheet .table-active input.form-control:focus,
        .vi-spreadsheet .table-active select.form-select:focus {
          background-color: #d6e7ff !important; /* azul más visible al enfocar */
          box-shadow: 0 0 0 0.18rem rgba(13, 110, 253, 0.3) !important;
        }

        /* FIX: mantener visible el resaltado rojo de celdas con error */
        .vi-spreadsheet input.vi-error-cell {
          border-color: #dc3545 !important;
          background-color: #f8d7da !important;
          box-shadow: 0 0 0 0.15rem rgba(220, 53, 69, 0.25) !important;
        }

        /* -----------------------------
           Tamaño de fuente del grid (filas) y ancho adaptable
           ----------------------------- */

        /* Variables base de fuente y ancho maximo de celda */
        .vi-spreadsheet {
          --vi-grid-font-size: 0.75rem;          /* tamano base de filas */
          --vi-grid-cell-max-width: 110px;       /* aprox. ancho actual maximo por columna */
          font-size: var(--vi-grid-font-size);
          table-layout: auto;
        }

        /* Escalones de tamano de fuente para las FILAS (no afecta titulos ni botones) */
        .vi-spreadsheet.vi-grid-font-0 { --vi-grid-font-size: 0.75rem; }
        .vi-spreadsheet.vi-grid-font-1 { --vi-grid-font-size: 0.8rem; }
        .vi-spreadsheet.vi-grid-font-2 { --vi-grid-font-size: 0.85rem; }
        .vi-spreadsheet.vi-grid-font-3 { --vi-grid-font-size: 0.9rem; }
        .vi-spreadsheet.vi-grid-font-4 { --vi-grid-font-size: 0.95rem; }
        .vi-spreadsheet.vi-grid-font-5 { --vi-grid-font-size: 1.0rem; }

        /* Encabezados y celdas (excepto índice y medidor fijo):
           minimo igual al título, pero pueden crecer hasta el ancho maximo actual */
        .vi-spreadsheet th:not(.vi-row-index):not(.vi-sticky-medidor),
        .vi-spreadsheet td:not(.vi-row-index):not(.vi-sticky-medidor) {
          white-space: nowrap;
          min-width: 64px;
          max-width: var(--vi-grid-cell-max-width);
        }

        /* Inputs y selects del grid: usan la fuente variable y se adaptan en alto.
           El ancho lo gobierna la celda (th/td), así pueden crecer con el contenido
           hasta el maximo definido arriba. */
        .vi-spreadsheet input.form-control {
          font-size: var(--vi-grid-font-size);
          height: calc(var(--vi-grid-font-size) * 2.3);
          width: 100%;
        }

        .vi-spreadsheet select.form-select {
          font-size: var(--vi-grid-font-size);
          width: 100%;
        }

        /* Valores de Q y E% siempre +2px respecto al resto de la fila */
        .vi-spreadsheet .vi-qe-value {
          font-size: calc(1em + 2px);
        }
        `}</style>



      <div className="modal-dialog modal-fluid" style={{maxWidth: "98vw", margin: "1vw"}}>
        <div className="modal-content">
          <form onSubmit={handleSubmit(handleValidSubmit)}>
            <div className="modal-header">
              <h5 className="modal-title">{title}</h5>
              <button type="button" className="btn-close" onClick={handleClose} aria-label="Close"></button>
            </div>
            <fieldset disabled={isReadOnly}>
            <div className="modal-body p-2">
              
              {/* Controles Superiores */}
              <div className="row g-2 mb-2 align-items-end">
                {/* Filas */}
                <div className="col-auto" style={{ maxWidth: "130px" }}>
                  <label className="form-label mb-1">Filas</label>
                  <input
                    type="number"
                    className="form-control form-control-sm text-end"
                    min={1}
                    max={50}
                    style={{ maxWidth: "90px" }}
                    {...rowsRegister}
                    ref={(el) => {
                      rowsInputRef.current = el;
                      rowsRegister.ref(el);
                    }}
                    onBlur={handleRowsBlur}
                    onKeyDown={handleRowsKeyDown}
                  />
                </div>

                {/* Botones de filas */}
                <div className="col-md-4 d-flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={handleAddRow}
                  >
                    + Agregar Fila
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline-danger btn-sm"
                  onClick={handleRemoveLastRow}
                >
                    - Quitar última fila
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline-secondary btn-sm"
                    onClick={handleClearAll}
                  >
                    Limpiar Todo
                  </button>
                </div>

                {/* Controles de tamano de fuente (alineados a la derecha) */}
                <div className="col-md-4 d-flex justify-content-end gap-2">
                  <button
                    type="button"
                    className="btn btn-outline-secondary btn-sm"
                    onClick={handleIncreaseFont}
                  >
                    Aumentar tamaño
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline-secondary btn-sm"
                    onClick={handleDecreaseFont}
                  >
                    Reducir tamaño
                  </button>
                </div>

                {/* Fila activa */}
                <div className="col-md-2 text-end text-muted small">
                  Fila activa: #{activeRow + 1}. Desplaza el cursor o enfoca la fila para seleccionarla (Fila 1 se replica al resto).
                </div>
              </div>
              {/* TABLA TIPO EXCEL */}
                            <div
                              className="table-responsive border rounded"
                              style={{ maxHeight: "70vh", overflowY: "auto", overflowX: "auto" }}
                            >
                              <table
                className={`table table-bordered table-sm mb-0 align-middle text-center vi-spreadsheet vi-grid-font-${fontStep}`}
              >

                  <thead className="table-light sticky-top z-1">
                    <tr>
                      <th className="vi-row-index" style={{width:"30px"}}>#</th>
                      <th className="vi-sticky-medidor" style={{width:"120px"}}># Medidor</th>
                      {/* NUEVO: Cabecera Estado por Fila */}
                      <th style={{width:"90px"}}>Estado</th>
                      {/* Q3 Expanded: J..P + T, U */}
                      <th className="table-primary border-start border-dark" colSpan={9}>Q3</th>
                      {/* Q2 Expanded: V..AB + AF, AG */}
                      <th className="table-primary border-start border-dark" colSpan={9}>Q2</th>
                      {/* Q1 Expanded: AH..AN + AR, AS */}
                      <th className="table-primary border-start border-dark" colSpan={9}>Q1</th>
                      <th className="bg-warning text-dark border-start border-dark vi-header-at" style={{width:"100px"}}>Conformidad</th>
                      {/* CAMBIO: Nueva columna para botón de eliminar */}
                      <th className="bg-light text-dark vi-header-quitar" style={{width:"40px"}}>Quitar</th>
                    </tr>
                    <tr style={{fontSize:"0.75rem"}}>
                      <th className="vi-row-index"></th>
                      <th className="vi-sticky-medidor"></th>
                      {/* Header vacío para estado */}
                      <th></th>
                      {/* Q3 - Ajuste visual de ancho */}
                      <th className="vi-min-width" title="J">Temp</th><th className="vi-min-width" title="K">P.Ent</th><th className="vi-min-width" title="L">P.Sal</th>
                      <th className="vi-min-width text-primary fw-bold" title="M">L.I.</th>
                      <th className="vi-min-width text-primary fw-bold" title="N">L.F.</th>
                      <th className="vi-min-width" title="O">Vol</th><th className="vi-min-width" title="P">Tpo</th>
                      <th title="T (Caudal)"  className="bg-light border-start text-primary fw-bold vi-min-width">Q3</th>
                      <th title="U (Error %)" className="bg-light text-danger  fw-bold vi-min-width">E%</th>
                      {/* Q2 - Ajuste visual de ancho */}
                      <th className="vi-min-width border-start border-dark" title="V">Temp</th><th className="vi-min-width" title="W">P.Ent</th><th className="vi-min-width" title="X">P.Sal</th>
                      <th className="vi-min-width text-primary fw-bold" title="Y">L.I.</th>
                      <th className="vi-min-width text-primary fw-bold" title="Z">L.F.</th>
                      <th className="vi-min-width" title="AA">Vol</th><th className="vi-min-width" title="AB">Tpo</th>
                      <th title="AF (Caudal)" className="bg-light border-start text-primary fw-bold vi-min-width">Q2</th>
                      <th title="AG (Error %)" className="bg-light text-danger  fw-bold vi-min-width">E%</th>
                      {/* Q1 - Ajuste visual de ancho */}
                      <th className="vi-min-width border-start border-dark" title="AH">Temp</th><th className="vi-min-width" title="AI">P.Ent</th><th className="vi-min-width" title="AJ">P.Sal</th>
                      {/* L.I. mismo color que L.F. en Q1 */}
                      <th className="vi-min-width text-primary fw-bold" title="AK">L.I.</th>
                      <th className="vi-min-width text-primary fw-bold" title="AL">L.F.</th>
                      <th className="vi-min-width" title="AM">Vol</th><th className="vi-min-width" title="AN">Tpo</th>
                      <th title="AR (Caudal)" className="bg-light border-start text-primary fw-bold vi-min-width">Q1</th>
                      <th title="AS (Error %)" className="bg-light text-danger  fw-bold vi-min-width">E%</th>
                      {/* AT con texto negro y Quitar en negro */}
                      <th title="AT (Conformidad)" className="bg-warning text-dark vi-header-at">Estado</th>
                      <th className="vi-header-quitar"></th>{/* Celda vacía para columna "Quitar" */}
                    </tr>
                  </thead>
                  <tbody onKeyDown={handleGridKeyDown}>
                    {fields.map((field, index) => {
                      const isBase = index === 0;
                      // Obtenemos valores para cálculo en vivo (usando watch interno o getValues si no es costoso,
                      // pero para renderizado fluido en tabla grande, mejor usar los values controlados).
                      // Nota: useWatch es mejor, pero aquí accederemos directo a los inputs registrados.
                      // Para simplificar la demo visual, calcularemos con los valores actuales del form state si es posible,
                      // o dejaremos que el usuario "guarde" para ver.
                      // MEJORA: Calcular con variables locales extraídas del `allRows` si se usa useWatch global.
                      const rowData = allRows?.[index] || {};
                      const rowErr = rowConstraintErrors[index] || {};
                      const rowEstado = Number(rowData.estado ?? 0);
                      const isRowLocked = rowEstado >= 1 && rowEstado <= 4;
                      
                      // Cálculos Q3
                      const q3_vol = rowData.q3?.c6; // O
                      const q3_time_seconds = rowData.q3?.c7_seconds; // P (calculado)
                      const q3_li = rowData.q3?.c4; // M
                      const q3_lf = rowData.q3?.c5; // N
                      const q3_flow = calcFlow(q3_vol, q3_time_seconds);
                      const q3_err = calcError(q3_li, q3_lf, q3_vol);

                      // Cálculos Q2
                      const q2_vol = rowData.q2?.c6; // AA
                      const q2_time_seconds = rowData.q2?.c7_seconds; // AB (calculado)
                      const q2_li = rowData.q2?.c4; // Y
                      const q2_lf = rowData.q2?.c5; // Z
                      const q2_flow = calcFlow(q2_vol, q2_time_seconds);
                      const q2_err = calcError(q2_li, q2_lf, q2_vol);

                      // Cálculos Q1
                      const q1_vol = rowData.q1?.c6; // AM
                      const q1_time_seconds = rowData.q1?.c7_seconds; // AN (calculado)
                      const q1_li = rowData.q1?.c4; // AK
                      const q1_lf = rowData.q1?.c5; // AL
                      const q1_flow = calcFlow(q1_vol, q1_time_seconds);
                      const q1_err = calcError(q1_li, q1_lf, q1_vol);

                      // CAMBIO: Usamos el estado PROPIO de la fila (rowData.estado)
                      const conformidad = calcConformity(rowData.estado, q3_err, q2_err, q1_err);
                      const rowClasses = [
                        isBase ? "vi-base-row" : "",
                        activeRow === index ? "table-active" : ""
                      ].filter(Boolean).join(" ");
                      const medidorField = register(`rowsData.${index}.medidor`);
                      const medidorKey = normalizeMedidorKey(rowData.medidor ?? "");
                      const backendDupMessage = medidorKey ? duplicateMap?.[medidorKey]?.message : "";
                      const medidorErrorMessage =
                        rowErr.medidor_format || rowErr.medidor_dup || backendDupMessage || "";
                      const hasMedidorError = Boolean(medidorErrorMessage);
                      const conformidadUpper = (conformidad || "").toUpperCase();
                      const verdictClass =
                        conformidadUpper === "NO CONFORME"
                          ? "vi-at-valor--fail"
                          : conformidadUpper === "CONFORME"
                            ? "vi-at-valor--ok"
                            : "";


                      return (
                        <tr
                          key={field.id}
                          className={rowClasses}
                          onMouseEnter={() => setActiveRow(index)}
                              onClick={() => setActiveRow(index)}
                          onFocusCapture={() => setActiveRow(index)}
                        >
                          <td className="small vi-row-index">{index + 1}</td>
                          <td className="vi-sticky-medidor">
                          <input
                            data-row={index}
                            data-row-id={field.id}
                            {...medidorField}
                            size={1}
                            style={{ minWidth: "100%" }}
                            disabled={isRowLocked}
                            onInput={handleAutoResize}
                              className={
                                [
                                  "form-control form-control-sm p-1 text-center vi-medidor-input",
                                  hasMedidorError ? "vi-error-cell" : "",
                                ].filter(Boolean).join(" ")
                              }
                              title={medidorErrorMessage || ""}
                              onChange={(event) => {
                                const prevValue = getValues(`rowsData.${index}.medidor`);
                                medidorField.onChange(event);
                                onClearDuplicate?.(prevValue);
                                if (index === 0) return;

                              const value = event.currentTarget.value.trim();
                              if (!value) {
                                medidorManualMap.current.delete(field.id);
                                return;
                              }

                              const autoValue = autoMedidor(firstRow?.medidor ?? "", index, numerationType);

                              // Si el valor coincide con el autocompletado esperado, NO se marca como manual
                              if (autoValue && autoValue === value) {
                                medidorManualMap.current.delete(field.id);
                              } else {
                                // Cualquier otra cosa se considera edición manual
                                medidorManualMap.current.set(field.id, true);
                              }
                            }}
                          />
                          </td>

                          {/* NUEVO: Selector de Estado POR FILA */}
                          <td>
                            <select
                              className="form-select form-select-sm p-0 px-1"
                              style={{fontSize: "0.75rem", height: "24px"}}
                              {...register(`rowsData.${index}.estado`, { valueAsNumber: true })}
                            >
                              <option value={0}>0</option>
                              <option value={1}>1</option>
                              <option value={2}>2</option>
                              <option value={3}>3</option>
                              <option value={4}>4</option>
                              <option value={5}>5</option>
                            </select>
                          </td>

                         {/* Q3 */}
                        <td className="border-start border-dark"><input type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*" className="form-control form-control-sm px-1 text-center" size={1} style={{ minWidth: "100%" }} onInput={handleAutoResize} disabled={!isBase || isRowLocked} {...register(`rowsData.${index}.q3.c1`, { setValueAs: parseDecimalInput })} /></td>
                        <td><input type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*" className="form-control form-control-sm px-1 text-center" size={1} style={{ minWidth: "100%" }} onInput={handleAutoResize} disabled={!isBase || isRowLocked} {...register(`rowsData.${index}.q3.c2`, { setValueAs: parseDecimalInput })} /></td>
                        <td><input type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*" className="form-control form-control-sm px-1 text-center" size={1} style={{ minWidth: "100%" }} onInput={handleAutoResize} disabled={!isBase || isRowLocked} {...register(`rowsData.${index}.q3.c3`, { setValueAs: parseDecimalInput })} /></td>
                        <td className="bg-white">
                          <input
                            type="text"
                            inputMode="decimal"
                            pattern="[0-9]*[.,]?[0-9]*"
                            size={1}
                            style={{ minWidth: "100%" }}
                            disabled={isRowLocked}
                            onInput={handleAutoResize}
                            className={
                              "form-control form-control-sm px-1 text-center fw-bold text-primary" +
                              (rowErr.q3_li ? " vi-error-cell" : "")
                            }
                            title={rowErr.q3_li || ""}
                            {...register(`rowsData.${index}.q3.c4`, { setValueAs: parseDecimalInput })}
                          />
                        </td>
                        <td className="bg-white">
                          <input
                            type="text"
                            inputMode="decimal"
                            pattern="[0-9]*[.,]?[0-9]*"
                            size={1}
                            style={{ minWidth: "100%" }}
                            disabled={isRowLocked}
                            onInput={handleAutoResize}
                            className={
                              "form-control form-control-sm px-1 text-center fw-bold text-primary" +
                              (rowErr.q3_lf ? " vi-error-cell" : "")
                            }
                            title={rowErr.q3_lf || ""}
                            {...register(`rowsData.${index}.q3.c5`, { setValueAs: parseDecimalInput })}
                          />
                        </td>
                        <td><input type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*" className="form-control form-control-sm px-1 text-center" size={1} style={{ minWidth: "100%" }} onInput={handleAutoResize} disabled={!isBase || isRowLocked} {...register(`rowsData.${index}.q3.c6`, { setValueAs: parseDecimalInput })} /></td>
                        <td><input type="text" className="form-control form-control-sm px-1 text-center" size={1} style={{ minWidth: "100%" }} onInput={handleAutoResize} disabled={!isBase || isRowLocked} {...register(`rowsData.${index}.q3.c7`)} placeholder="m,ss,ms" /></td>
                        <RenderResult val={q3_flow} />
                        <RenderResult val={q3_err} isErr warnThreshold={2} failThreshold={5} />

                          {/* Q2 */}
                          <td className="border-start border-dark"><input type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*" className="form-control form-control-sm px-1 text-center" size={1} style={{ minWidth: "100%" }} onInput={handleAutoResize} disabled={!isBase || isRowLocked} {...register(`rowsData.${index}.q2.c1`, { setValueAs: parseDecimalInput })} /></td>
                          <td><input type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*" className="form-control form-control-sm px-1 text-center" size={1} style={{ minWidth: "100%" }} onInput={handleAutoResize} disabled={!isBase || isRowLocked} {...register(`rowsData.${index}.q2.c2`, { setValueAs: parseDecimalInput })} /></td>
                          <td><input type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*" className="form-control form-control-sm px-1 text-center" size={1} style={{ minWidth: "100%" }} onInput={handleAutoResize} disabled={!isBase || isRowLocked} {...register(`rowsData.${index}.q2.c3`, { setValueAs: parseDecimalInput })} /></td>
                          <td className="bg-white">
                            <input
                              type="text"
                              inputMode="decimal"
                              pattern="[0-9]*[.,]?[0-9]*"
                              size={1}
                              style={{ minWidth: "100%" }}
                              disabled={isRowLocked}
                              onInput={handleAutoResize}
                              className={
                                "form-control form-control-sm px-1 text-center fw-bold text-primary" +
                                (rowErr.q2_li ? " vi-error-cell" : "")
                              }
                              title={rowErr.q2_li || ""}
                              {...register(`rowsData.${index}.q2.c4`, { setValueAs: parseDecimalInput })}
                            />
                          </td>
                          <td className="bg-white">
                            <input
                              type="text"
                              inputMode="decimal"
                              pattern="[0-9]*[.,]?[0-9]*"
                              size={1}
                              style={{ minWidth: "100%" }}
                              disabled={isRowLocked}
                              onInput={handleAutoResize}
                              className={
                                "form-control form-control-sm px-1 text-center fw-bold text-primary" +
                                (rowErr.q2_lf ? " vi-error-cell" : "")
                              }
                              title={rowErr.q2_lf || ""}
                              {...register(`rowsData.${index}.q2.c5`, { setValueAs: parseDecimalInput })}
                            />
                          </td>
                          <td><input type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*" className="form-control form-control-sm px-1 text-center" size={1} style={{ minWidth: "100%" }} onInput={handleAutoResize} disabled={!isBase || isRowLocked} {...register(`rowsData.${index}.q2.c6`, { setValueAs: parseDecimalInput })} /></td>
                          <td><input type="text" className="form-control form-control-sm px-1 text-center" size={1} style={{ minWidth: "100%" }} onInput={handleAutoResize} disabled={!isBase || isRowLocked} {...register(`rowsData.${index}.q2.c7`)} placeholder="m,ss,ms" /></td>
                          <RenderResult val={q2_flow} />
                          <RenderResult val={q2_err} isErr warnThreshold={2} failThreshold={5} />

                          {/* Q1 */}
                          <td className="border-start border-dark"><input type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*" className="form-control form-control-sm px-1 text-center" size={1} style={{ minWidth: "100%" }} onInput={handleAutoResize} disabled={!isBase || isRowLocked} {...register(`rowsData.${index}.q1.c1`, { setValueAs: parseDecimalInput })} /></td>
                          <td><input type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*" className="form-control form-control-sm px-1 text-center" size={1} style={{ minWidth: "100%" }} onInput={handleAutoResize} disabled={!isBase || isRowLocked} {...register(`rowsData.${index}.q1.c2`, { setValueAs: parseDecimalInput })} /></td>
                          <td><input type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*" className="form-control form-control-sm px-1 text-center" size={1} style={{ minWidth: "100%" }} onInput={handleAutoResize} disabled={!isBase || isRowLocked} {...register(`rowsData.${index}.q1.c3`, { setValueAs: parseDecimalInput })} /></td>
                          <td className="bg-white">
                            <input
                              type="text"
                              inputMode="decimal"
                              size={1}
                              style={{ minWidth: "100%" }}
                              disabled={isRowLocked}
                              onInput={handleAutoResize}
                              className={
                                "form-control form-control-sm px-1 text-center fw-bold text-primary" +
                                (rowErr.q1_li ? " vi-error-cell" : "")
                              }
                              title={rowErr.q1_li || ""}
                              {...register(`rowsData.${index}.q1.c4`, { setValueAs: parseDecimalInput })}
                            />
                          </td>
                          <td className="bg-white">
                            <input
                              type="text"
                              inputMode="decimal"
                              pattern="[0-9]*[.,]?[0-9]*"
                              size={1}
                              style={{ minWidth: "100%" }}
                              disabled={isRowLocked}
                              onInput={handleAutoResize}
                              className={
                                "form-control form-control-sm px-1 text-center fw-bold text-primary" +
                                (rowErr.q1_lf ? " vi-error-cell" : "")
                              }
                              title={rowErr.q1_lf || ""}
                              {...register(`rowsData.${index}.q1.c5`, { setValueAs: parseDecimalInput })}
                            />
                          </td>
                          <td><input type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*" className="form-control form-control-sm px-1 text-center" size={1} style={{ minWidth: "100%" }} onInput={handleAutoResize} disabled={!isBase || isRowLocked} {...register(`rowsData.${index}.q1.c6`, { setValueAs: parseDecimalInput })} /></td>
                          <td><input type="text" className="form-control form-control-sm px-1 text-center" size={1} style={{ minWidth: "100%" }} onInput={handleAutoResize} disabled={!isBase || isRowLocked} {...register(`rowsData.${index}.q1.c7`)} placeholder="m,ss,ms" /></td>
                          <RenderResult val={q1_flow} />
                          <RenderResult val={q1_err} isErr warnThreshold={5} failThreshold={5} />
                          
                          <td className={`bg-light border-start fw-bold small text-center vi-at-valor ${verdictClass}`}>
                            {conformidad}
                          </td>
                          {/* CAMBIO: Botón de eliminar específico para esta fila */}
                          <td className="text-center align-middle bg-light">
                            <button
                              type="button"
                              className="btn btn-danger btn-sm p-0"
                              style={{ width: "20px", height: "20px", lineHeight: "1" }}
                              onClick={(e) => {
                                e.stopPropagation();
                                removeRowAt(index);
                              }}
                              disabled={fields.length <= 1}
                              title="Eliminar esta fila"
                            >
                              &times;
                            </button>
                          </td>
                         </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              </div>
            </fieldset>
            <div className="modal-footer py-1">
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      onClick={handleClose}
    >
      Cancelar
    </button>
   <button
     type="submit"
     className="btn btn-primary btn-sm"
     ref={saveButtonRef}
      disabled={hasConstraintErrors || isReadOnly}
   >
     Guardar Bancada
   </button>
  </div>
          </form>
        </div>
      </div>
    </div>
    {/* Backdrop de Bootstrap (sin inline styles) */}
    <div className="modal-backdrop show vi-backdrop"></div>
  </>
  );
}
  


