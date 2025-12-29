import { useQuery } from "@tanstack/react-query";
import { getCatalogs, type Catalogs } from "../../api/catalogs";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { OISchema, pressureFromPMA, type OIForm, type OIFormInput, type BancadaRowForm } from "./schema"
import { useMemo, useEffect, useState } from "react";
import { useToast } from "../../components/Toast";
import Spinner from "../../components/Spinner";
import { getAuth, normalizeRole } from "../../api/auth";
import { useLocation, useNavigate } from "react-router-dom";
import { clearOpenOiId, setOpenOiId } from "../../api/client";
import BancadaModal, { type BancadaForm } from "./BancadaModal";
import PasswordModal from "./PasswordModal";
import {
  createOI, updateOI, generateExcel,
  addBancada, updateBancada, deleteBancada,
  getOiFull, getOi, saveCurrentOI, loadCurrentOI, clearCurrentOI, lockOi, unlockOi,
  type BancadaRead,
  type BancadaRow,
  type BancadaCreate,
  type BancadaUpdatePayload
} from "../../api/oi";

const apiBlockToForm = (block?: BancadaRow["q3"]): BancadaRowForm["q3"] => {
  if (!block) return undefined;
  return {
    c1: block.c1 ?? null,
    c2: block.c2 ?? null,
    c3: block.c3 ?? null,
    c4: block.c4 ?? null,
    c5: block.c5 ?? null,
    c6: block.c6 ?? null,
    c7: block.c7 ?? "",
    c7_seconds: block.c7_seconds ?? null,
    caudal: block.caudal ?? null,
    error: block.error ?? null,
  };
};

const formBlockToApi = (block?: BancadaRowForm["q3"]): BancadaRow["q3"] => {
  if (!block) return undefined;
  return {
    c1: block.c1 ?? null,
    c2: block.c2 ?? null,
    c3: block.c3 ?? null,
    c4: block.c4 ?? null,
    c5: block.c5 ?? null,
    c6: block.c6 ?? null,
    c7: block.c7 ?? null,
    c7_seconds: block.c7_seconds ?? null,
    caudal: block.caudal ?? null,
    error: block.error ?? null,
  };
};

const apiRowToForm = (row: BancadaRow): BancadaRowForm => ({
  medidor: row.medidor ?? "",
  estado: row.estado ?? 0,
  q3: apiBlockToForm(row.q3),
  q2: apiBlockToForm(row.q2),
  q1: apiBlockToForm(row.q1),
});

const formRowToApi = (row: BancadaRowForm): BancadaRow => ({
  medidor: row.medidor ?? "",
  estado: row.estado ?? 0,
  q3: formBlockToApi(row.q3),
  q2: formBlockToApi(row.q2),
  q1: formBlockToApi(row.q1),
});

const resolveEditingRows = (row: BancadaRead): BancadaRow[] => {
  if (row.rows_data && row.rows_data.length > 0) {
    return row.rows_data;
  }
  return Array.from({ length: row.rows }).map((_, i) => ({
    medidor: i === 0 ? (row.medidor ?? "") : "",
    estado: row.estado,
    q3: i === 0 ? row.q3 ?? undefined : undefined,
    q2: i === 0 ? row.q2 ?? undefined : undefined,
    q1: i === 0 ? row.q1 ?? undefined : undefined,
  }));
};

const calcMedidoresFromBancadas = (items: BancadaRead[]) =>
  items.reduce((acc, item) => acc + (item.rows ?? 0), 0);

export default function OiPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { data } = useQuery<Catalogs>({ queryKey: ["catalogs"], queryFn: getCatalogs });
  const { register, handleSubmit, watch, formState:{errors}, reset, getValues } = useForm<OIFormInput, unknown, OIForm>({
    resolver: zodResolver(OISchema),
    defaultValues: {
      oi: `OI-0001-${new Date().getFullYear()}`,
      numeration_type: "correlativo",
      pma: 16,
      q3: 2.5,
      alcance: 80,
    },
  });
  const auth = useMemo(() => getAuth(), []);
  const authUserId = auth?.userId ?? null;
  const isAdmin = normalizeRole(auth?.role, auth?.username) !== "technician";
  const [busy, setBusy] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [lockedByName, setLockedByName] = useState<string | null>(null);
  const [lockedByUserId, setLockedByUserId] = useState<number | null>(null);
  const [hasLock, setHasLock] = useState(false);
  
  const [isEditingOI, setIsEditingOI] = useState(false);
  const [originalOI, setOriginalOI] = useState<OIForm | null>(null);

  // Id del OI creado y lista local de bancadas
  const [oiId, setOiId] = useState<number | null>(null);
  // Marca de tiempo de la última versión conocida de la OI (para control optimista)
  const [oiVersion, setOiVersion] = useState<string | null>(null);
  const [bancadas, setBancadas] = useState<BancadaRead[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<BancadaRead | null>(null);
  const [showPwd, setShowPwd] = useState(false);
  const [medidoresUsuarioApi, setMedidoresUsuarioApi] = useState<number | null>(null);
  const [medidoresTotalCode, setMedidoresTotalCode] = useState(0);

  // Borradores temporales de bancadas (por id o "new")
  const [bancadaDrafts, setBancadaDrafts] = useState<Record<string, BancadaForm>>({});

  const getDraftKey = (row: BancadaRead | null) =>
  row ? `bancada-${row.id}` : "new";


  // Set defaults de selects al cargar catálogos
  useEffect(() => {
    if (data) {
      reset(v => ({ ...v, q3: data.q3[0], alcance: data.alcance[0], pma: 16 }));
    }
  }, [data, reset]);

  // Al montar: si hay un OI activo en sesión, cargarlo (incluye bancadas)
  useEffect(() => {
    const current = loadCurrentOI();
    if (!current) return;
    (async () => {
      try {
        const full = await getOiFull(current.id);
        setOiId(full.id);
        setBancadas(full.bancadas ?? []);
        setMedidoresUsuarioApi(full.medidores_usuario ?? null);
        setMedidoresTotalCode(full.medidores_total_code ?? 0);
        // Guardamos la versión (updated_at o, en su defecto, created_at)
        setOiVersion(full.updated_at ?? full.created_at);
        const initial: OIForm = {
          oi: full.code,
          q3: full.q3,
          alcance: full.alcance,
          pma: full.pma,
          numeration_type: full.numeration_type ?? "correlativo",
        };
        reset(initial);
        setIsEditingOI(false);
        setReadOnly(full.read_only_for_current_user ?? false);
        setLockedByName(full.locked_by_full_name ?? null);
        setLockedByUserId(full.locked_by_user_id ?? null);
        setHasLock((full.locked_by_user_id ?? null) === authUserId);
        setOriginalOI(initial);
      } catch {
        clearCurrentOI();
       }
    })();
  }, [reset, authUserId]);

  // Lock de OI para técnicos: intenta tomar o refrescar lock al abrir la pantalla
  useEffect(() => {
    if (!oiId || !authUserId) return;
    let cancelled = false;
    (async () => {
      const applyLockInfo = (res: any) => {
        setReadOnly(res?.read_only_for_current_user ?? false);
        setLockedByName(res?.locked_by_full_name ?? null);
        setLockedByUserId(res?.locked_by_user_id ?? null);
        setHasLock((res?.locked_by_user_id ?? null) === authUserId);
      };
      try {
        const res = await lockOi(oiId);
        if (cancelled) return;
        applyLockInfo(res);
      } catch (e: any) {
        if (cancelled) return;
        const status = e?.status ?? e?.response?.status;
        let lockedName: string | null = null;
        try {
          const full = await getOiFull(oiId);
          if (cancelled) return;
          lockedName = full.locked_by_full_name ?? null;
          applyLockInfo({
            read_only_for_current_user: true,
            locked_by_full_name: lockedName,
            locked_by_user_id: full.locked_by_user_id ?? null,
          });
        } catch {
          setReadOnly(true);
          setHasLock(false);
        }
        const message =
          lockedName
            ? `La OI está siendo editada por ${lockedName}. Se abre en modo lectura.`
            : e?.message ?? "La OI está siendo editada por otro usuario. Inténtelo más tarde.";
        toast({
          kind: status === 423 || status === 409 ? "warning" : "error",
          title: status === 423 || status === 409 ? "OI bloqueada" : "Error",
          message,
        });
        setReadOnly(true);
        setHasLock(false);
      }
    })();
    return () => { cancelled = true; };
  }, [oiId, authUserId, isAdmin]);

  // Libera lock al desmontar si lo posee el usuario actual
  useEffect(() => {
    return () => {
      if (oiId && hasLock) {
        unlockOi(oiId).catch(() => undefined);
      }
    };
  }, [oiId, hasLock]);

  // Marca el OI con lock activo para cierre automático en logout (best-effort)
  useEffect(() => {
    if (!oiId) return;
    if (!hasLock || readOnly) return;
    setOpenOiId(oiId);
  }, [hasLock, oiId, readOnly]);

  const pma = watch("pma");
  const presion = useMemo(() => pressureFromPMA(Number(pma)), [pma]);
  const numerationType = watch("numeration_type") ?? "correlativo";


  const onSubmitCreate = async (v: OIForm) => {
    try {
      setBusy(true);
      const auth = getAuth();
      if (!auth) throw new Error("Sesión no válida");
      const bancoId = auth.bancoId;
      if (bancoId == null) throw new Error("Debe seleccionar un banco para crear una OI.");
      const payload = {
        code: v.oi,
        q3: Number(v.q3),
        alcance: Number(v.alcance),
        pma: Number(v.pma),
        banco_id: bancoId,
        tech_number: auth.techNumber,
        numeration_type: v.numeration_type ?? "correlativo",
      };
      const created = await createOI(payload);
      setOiId(created.id);
      setOiVersion(created.updated_at ?? created.created_at);
      setMedidoresUsuarioApi(created.medidores_usuario ?? 0);
      setMedidoresTotalCode(created.medidores_total_code ?? 0);
      saveCurrentOI({ id: created.id, code: created.code });
      setOriginalOI(v);
      
      toast({ kind: "success", title: "OI creada", message: `${created.code} (#${created.id})` });
    } catch (e: any) {
      toast({ kind:"error", title:"Error", message: e?.message ?? "Error creando OI" });
    }
     finally { setBusy(false); }
  };

  const onSubmitUpdate = async (v: OIForm) => {
    if (!oiId) return;
    if (readOnly) {
      toast({ kind: "warning", title: "Solo lectura", message: "La OI está bloqueada por otro usuario." });
      return;
    }
    try {
      setBusy(true);
      if (!oiId) {
        throw new Error("No hay OI seleccionada para actualizar.");
      }
      if (!oiVersion) {
        throw new Error("No se pudo determinar la versión actual de la OI. Recargue la página e inténtelo de nuevo.");
      }

      const updated = await updateOI(oiId, {
        q3: Number(v.q3),
        alcance: Number(v.alcance),
        pma: Number(v.pma),
        numeration_type: v.numeration_type ?? "correlativo",
        updated_at: oiVersion,
      });
      setOriginalOI(v);
      // Actualizamos la versión local con lo que devuelve el backend
      setOiVersion(updated.updated_at ?? updated.created_at)
      setLockedByUserId(updated.locked_by_user_id ?? null);
      setLockedByName(updated.locked_by_full_name ?? null);
      setReadOnly(updated.read_only_for_current_user ?? false);
      setHasLock((updated.locked_by_user_id ?? null) === authUserId);
      setIsEditingOI(false);
      toast({ kind: "success", title: "OI actualizada", message: v.oi});
    } catch (e: any) {
      const status = e?.status ?? e?.response?.status;
      if (status === 409) {
        toast({
          kind: "error",
          title: "Conflicto",
          message: "La OI fue modificada por otro usuario. Recargue la página y vuelva a intentar.",
        });
      } else {
        toast({ kind:"error", title:"Error", message: e?.message ?? "Error actualizando OI" });
      }
    } finally {
      setBusy(false);
    }
  };

  const isEditingExisting = !!oiId && isEditingOI && !readOnly;
  

  const openNew = () => {
    if (readOnly) {
      toast({ kind: "warning", title: "Solo lectura", message: "No puede agregar bancadas mientras la OI está bloqueada." });
      return;
    }
    setEditing(null);
    setShowModal(true);
  };
  const openEdit = (row: BancadaRead) => {
    if (readOnly) {
      toast({ kind: "warning", title: "Solo lectura", message: "No puede editar bancadas mientras la OI está bloqueada." });
      return;
    }
    setEditing(row);
    setShowModal(true);
  };

    const editingInitial = useMemo(() => {
    const key = getDraftKey(editing);
    const draft = bancadaDrafts[key];

    // Si hay borrador en memoria (nueva o existente), lo usamos primero
    if (draft) {
      const version = draft.version ?? editing?.updated_at ?? editing?.created_at ?? null;
      return { ...draft, version };
    }

    // Nueva bancada sin borrador: que la modal use sus defaults internos
    if (!editing) return undefined;

    // Bancada existente sin borrador: construir a partir de lo que viene del backend
    const resolvedRows = resolveEditingRows(editing);
    const rowsData = resolvedRows.map(apiRowToForm);
    return {
      estado: editing.estado,
      rows: rowsData.length || editing.rows,
      rowsData,
      version: editing.updated_at ?? editing.created_at ?? null,
    };
  }, [editing, bancadaDrafts]);


  const handleSaveBancada = async (form: BancadaForm) => {
    if (!oiId) return;
    if (readOnly) {
      toast({ kind: "warning", title: "Solo lectura", message: "No puede guardar bancadas mientras la OI está bloqueada." });
      return;
    }
    try {
      setBusy(true);

      // Normalizamos las filas antes de enviarlas a la API
      const payload: BancadaCreate = {
        estado: Number(form.estado ?? 0),
        rows: Number(form.rowsData.length),
        rows_data: form.rowsData.map(formRowToApi),
      };

      if (editing) {
        const expectedVersion = form.version ?? editing.updated_at ?? editing.created_at ?? null;
        if (!expectedVersion) {
          throw new Error("No se pudo determinar la versión actual de la bancada. Recargue y vuelva a intentar.");
        }
        const updPayload: BancadaUpdatePayload = { ...payload, updated_at: expectedVersion };
        const upd = await updateBancada(editing.id, updPayload);
        setBancadas(prev => prev.map(x => (x.id === upd.id ? upd : x)));
        setOiVersion(upd.updated_at ?? upd.created_at ?? oiVersion);
        setMedidoresUsuarioApi(null);
        // Limpiar borrador de esta bancada editada
        setBancadaDrafts(prev => {
          const key = `bancada-${editing.id}`;
          const { [key]: _, ...rest } = prev;
          return rest;
        });
        toast({ kind: "success", message: "Bancada actualizada" });
      } else {
        const created = await addBancada(oiId, payload);
        setBancadas(prev => [...prev, created]);
        setOiVersion(created.updated_at ?? created.created_at ?? oiVersion);
        setMedidoresUsuarioApi(null);
        // Limpiar borrador de "nueva bancada"
        setBancadaDrafts(prev => {
          const { new: _, ...rest } = prev;
          return rest;
        });
        toast({ kind: "success", message: "Bancada agregada" });
      }

      try {
        const refreshed = await getOi(oiId);
        setMedidoresUsuarioApi(refreshed.medidores_usuario ?? null);
        setMedidoresTotalCode(refreshed.medidores_total_code ?? medidoresTotalCode);
      } catch {
        // ignore
      }

      // ✅ Cerrar la modal tras guardar correctamente
      setLockedByUserId(auth?.userId ?? lockedByUserId);
      setLockedByName(auth?.fullName ?? lockedByName);
      setHasLock(authUserId !== null);
      setReadOnly(false);

      setShowModal(false);
      setEditing(null);

    } catch (e: any) {
      const status = e?.status ?? e?.response?.status;
      if (status === 409) {
        toast({
          kind: "error",
          title: "Conflicto",
          message: "La bancada fue modificada por otro usuario. Recargue la página y vuelva a intentar.",
        });
      } else {
        toast({
          kind: "error",
          title: "Error",
          message: e?.message ?? "Error guardando bancada",
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (row: BancadaRead) => {
    if (!confirm(`Eliminar bancada #${row.item}?`)) return;
    if (readOnly) {
      toast({ kind: "warning", title: "Solo lectura", message: "No puede eliminar bancadas mientras la OI está bloqueada." });
      return;
    }
    try {
      setBusy(true);
      if (!oiId) {
        throw new Error("No hay OI cargada.");
      }
      await deleteBancada(row.id);
      setBancadas(prev => prev.filter(x => x.id !== row.id));
      setMedidoresUsuarioApi(null);
      setBancadaDrafts(prev => {
        const key = `bancada-${row.id}`;
        const { [key]: _, ...rest } = prev;
        return rest;
      });
      const refreshed = await getOi(oiId);
      setOiVersion(refreshed.updated_at ?? refreshed.created_at ?? null);
      setLockedByUserId(refreshed.locked_by_user_id ?? null);
      setLockedByName(refreshed.locked_by_full_name ?? null);
      setReadOnly(refreshed.read_only_for_current_user ?? false);
      setHasLock((refreshed.locked_by_user_id ?? null) === authUserId);
      setMedidoresUsuarioApi(refreshed.medidores_usuario ?? null);
      setMedidoresTotalCode(refreshed.medidores_total_code ?? medidoresTotalCode);

      toast({ kind:"success", message:`Bancada #${row.item} eliminada` });
    } catch (e: any) {
      toast({ kind:"error", title:"Error", message: e?.message ?? "Error eliminando bancada" });
    }
    finally { setBusy(false); }
  };

  const handleExcelClick = () => {
    if (!oiId) {
      toast({ kind: "warning", message: "Primero guarda el OI." });
      return;
    }
    setShowPwd(true);
  };

  const handleExcelConfirmed = async (password: string) => {
    if (!oiId) return;
    try {
      setBusy(true);
      await generateExcel(oiId, password);
      toast({ kind: "success", message: "Excel generado" });
    } catch (e: any) {
      // 422 (listas E4/O4 no coinciden) vendrá como mensaje en e.message
      toast({ kind: "error", title: "Error", message: e?.message ?? "Error generando Excel" });
    } finally {
      setBusy(false);
    }
  };

  const handleBancadaCancel = (draft: BancadaForm) => {
  const key = getDraftKey(editing);
  setBancadaDrafts(prev => ({ ...prev, [key]: draft }));
  setShowModal(false);
};

  const handleStartEditOI = () => {
    if (readOnly) {
      toast({ kind: "warning", title: "Solo lectura", message: "La OI está bloqueada por otro usuario." });
      return;
    }
    const current = getValues();
    // Normalizamos `numeration_type` para que nunca sea undefined
    setOriginalOI({ 
      ...current, 
      numeration_type: current.numeration_type ?? "correlativo",
    });
    setIsEditingOI(true);
  };

  const handleCancelEditOI = () => {
    if (originalOI) {
      reset(originalOI);
    }
    setIsEditingOI(false);
  };


  const handleCloseOI = () => {
    if (oiId && hasLock) {
      unlockOi(oiId).catch(() => undefined);
    }
    clearCurrentOI();
    clearOpenOiId();
    setOiId(null);
    setBancadas([]);
    setBancadaDrafts({});
    setIsEditingOI(false);
    setOriginalOI(null);
    setOiVersion(null);
    setReadOnly(false);
    setLockedByName(null);
    setLockedByUserId(null);
    setHasLock(false);
    setMedidoresUsuarioApi(null);
    setMedidoresTotalCode(0);
    // opcional: resetear a defaults
    reset({
      oi: `OI-0001-${new Date().getFullYear()}`,
      q3: data?.q3[0] ?? 2.5,
      alcance: data?.alcance[0] ?? 80,
      pma: 16,
      numeration_type: "correlativo",
    });
    toast({ kind:"info", message:"OI cerrada"});

    const target = location.search ? `/oi/list${location.search}` : "/oi/list";
    navigate(target);
  };

  const medidoresUsuarioLocal = useMemo(
    () => calcMedidoresFromBancadas(bancadas),
    [bancadas]
  );
  const medidoresUsuarioDisplay = medidoresUsuarioApi ?? medidoresUsuarioLocal;

    const formatDateTime = (iso?: string | null) => {
      if (!iso) return "-";
      // Fechas vienen en UTC sin zona; normalizamos a UTC y mostramos en hora de Peru.
      const hasTz = /([zZ]|[+-]\d{2}:?\d{2})$/.test(iso);
      const normalized = hasTz ? iso : `${iso}Z`;
      const d = new Date(normalized);
      if (Number.isNaN(d.getTime())) return iso;
      return new Intl.DateTimeFormat("es-PE", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
        timeZone: "America/Lima",
      }).format(d);
    };

  return (
    <div className="oi-page vi-oi-light">
       <Spinner show={busy} />
      <h1 className="h3">Formulario OI</h1>
      {readOnly && (
        <div className="alert alert-warning mt-2">
          {lockedByName
            ? `Esta OI está siendo editada por ${lockedByName}. Se abre en modo lectura.`
            : "Esta OI está en modo lectura. No se pueden realizar cambios."}
        </div>
      )}

      <form
        onSubmit={handleSubmit(isEditingExisting ? onSubmitUpdate : onSubmitCreate)}
        className={`row g-3 mt-1 ${isEditingExisting ? "vi-form-editing" : "vi-form-readonly"}`}
      >
        <div className="col-md-4">
          <label htmlFor="oi" className="form-label">OI (OI-####-YYYY)</label>
          <input
            id="oi"
            className={`form-control ${oiId ? "vi-locked" : ""}`}
            {...register("oi")}
            disabled={!!oiId}
          />
          {errors.oi && <div className="text-danger small">{errors.oi.message}</div>}
        </div>

        <div className="col-md-4">
          <label htmlFor="q3" className="form-label">Q3 (m³/h)</label>
          <select id="q3" className="form-select" {...register("q3",{valueAsNumber:true})} disabled={(!!oiId && !isEditingOI) || readOnly}>
            {data?.q3.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>

        <div className="col-md-4">
          <label htmlFor="alcance" className="form-label">Alcance Q3/Q1</label>
          <select id="alcance" className="form-select" {...register("alcance",{valueAsNumber:true})} disabled={(!!oiId && !isEditingOI) || readOnly}>
            {data?.alcance.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>

        <div className="col-md-4">
          <label htmlFor="pma" className="form-label">PMA (bar)</label>
          <select id="pma" className="form-select" {...register("pma",{valueAsNumber:true})} disabled={(!!oiId && !isEditingOI) || readOnly}>
            {data?.pma.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
          <div className="form-text">Solo en formulario; calcula Presión (bar).</div>
        </div>

        <div className="col-md-4">
          <label htmlFor="presion" className="form-label">Presión (bar)</label>
          <input id="presion" className="form-control" value={isNaN(presion) ? "" : presion} disabled />
        </div>

        <div className="col-md-4">
          <label htmlFor="numeration_type" className="form-label">
            Tipo de numeración (# Medidor)
          </label>
          <select
            id="numeration_type"
            className="form-select"
            {...register("numeration_type")}
            disabled={(!!oiId && !isEditingOI) || readOnly}
          >
            <option value="correlativo">Correlativo</option>
            <option value="no correlativo">No Correlativo</option>
          </select>
          <div className="form-text">
            Define cómo se completa la columna # Medidor en el Grid.
          </div>
        </div>


        <div className="col-12 d-flex align-items-center gap-2">
          <button
            className="btn btn-primary"
            disabled={busy || (!!oiId && (!isEditingOI || readOnly))}
          >
            {!oiId
              ? "Guardar OI"
              : isEditingExisting
                ? "Guardar cambios"
                : "OI guardada"}
          </button>

          {oiId && !isEditingOI && (
            <button
              type="button"
              className="btn btn-outline-warning"
              onClick={handleStartEditOI}
              disabled={busy || readOnly}
            >
              Editar OI
            </button>
          )}
          {oiId && isEditingOI && (
            <button type="button" className="btn btn-outline-warning" onClick={handleCancelEditOI} disabled={busy}>
              Cancelar edicion
            </button>
          )}

          <button type="button" className="btn btn-outline-success" onClick={handleExcelClick} disabled={!oiId || busy || isEditingOI}>
            Generar Excel
          </button>
          <button type="button" className="btn btn-outline-danger" onClick={handleCloseOI} disabled={!oiId || isEditingOI || busy}>
            Cerrar OI
          </button>
        </div>
      </form>

      <hr className="my-4" />

      {/* ---- Tabla de Bancadas con estilo Adminator ---- */}
      <div className="card vi-card-table mt-3">
        <div className="card-header d-flex align-items-center justify-content-between">
          <div>
            <h2 className="h6 mb-0">Bancadas</h2>
            <small className="text-muted">
              Medidores (mi registro): {medidoresUsuarioDisplay} | Total OI: {medidoresTotalCode}
            </small>
          </div>
          <button className="btn btn-primary" onClick={openNew} disabled={!oiId || busy || isEditingOI || readOnly}>Agregar Bancada</button>
        </div>
        <div className="card-body p-0">
          <div className="table-responsive">
            <table className="table table-hover table-striped table-sm align-middle mb-0">
              <thead>
                <tr>
                  <th className="vi-col-60">Item</th>
                  <th># Medidor</th>
                  <th>Medidores</th>
                  <th className="vi-col-160">Fecha creación</th>
                  <th className="vi-col-160">Fecha guardado</th>
                  <th className="vi-col-160">Última fecha mod.</th>
                  <th className="vi-col-160 text-end">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {bancadas.length === 0 && (
                  <tr>
                    <td colSpan={7} className="text-muted text-center py-3">
                      Sin bancadas. Agrega la primera.
                    </td>
                  </tr>
                )}

                {bancadas.map(b => {
                  // Si tenemos la data completa, mostramos rango de medidores
                  const firstM = b.rows_data?.[0]?.medidor || b.medidor || "";
                  const lastM = b.rows_data?.[(b.rows_data?.length || 0) - 1]?.medidor || "";
                  const displayMed = (firstM && lastM && firstM !== lastM) ? `${firstM} ... ${lastM}` : firstM;

                  // AHORA HACEMOS EL RETURN DEL JSX
                  return (
                  <tr key={b.id}>
                    <td>{b.item}</td>
                    <td>{displayMed}</td>
                    <td>{b.rows}</td>
                    <td>{formatDateTime(b.created_at)}</td>
                    <td>{formatDateTime(b.saved_at)}</td>
                    <td>{formatDateTime(b.updated_at ?? b.created_at)}</td>
                    <td className="text-end">
                      {/* botones Editar / Eliminar */}
                        <button
                          className="btn btn-sm btn-outline-primary me-2"
                          onClick={() => openEdit(b)}
                          disabled={busy || isEditingOI || readOnly}
                          aria-label={`Editar bancada #${b.item}`}
                          title="Editar"
                        >
                          ✏️
                        </button>
                        <button
                          className="btn btn-sm btn-outline-danger"
                          onClick={() => handleDelete(b)}
                          disabled={busy || isEditingOI || readOnly}
                          aria-label={`Eliminar bancada #${b.item}`}
                          title="Eliminar"
                        > 
                          🗑️
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      {showModal && (
      <BancadaModal
        show={showModal}
        title={editing ? `Editar bancada #${editing.item}` : "Nueva bancada"}
        initial={editingInitial}
        onClose={() => setShowModal(false)}
        onSubmit={handleSaveBancada}
        onCancelWithDraft={handleBancadaCancel}
        numerationType={numerationType}
        readOnly={readOnly}
      />
       )}

      <PasswordModal
        show={showPwd}
        title="Contraseña para proteger Excel"
        onClose={() => setShowPwd(false)}
        onConfirm={(pwd) => { setShowPwd(false); handleExcelConfirmed(pwd); }}
      />
    </div>
  );
}

