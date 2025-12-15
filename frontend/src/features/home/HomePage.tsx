import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getCatalogs } from "../../api/catalogs";
import type { Catalogs } from "../../api/catalogs";
import { getAuth, getSelectedBank, isTechnicianRole, setSessionBank } from "../../api/auth";
import { useToast } from "../../components/Toast";

type ToastState =
  | {
      toast?: {
        kind?: "success" | "error" | "info" | "warning";
        title?: string;
        message: string;
      };
    }
  | undefined;

export default function HomePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { toast } = useToast();

  const auth = getAuth();
  const isTech = isTechnicianRole(auth?.role);
  const selectedBank = getSelectedBank();
  const needsBank = isTech && !(selectedBank && selectedBank > 0);

  const { data, isLoading, error } = useQuery<Catalogs>({
    queryKey: ["catalogs"],
    queryFn: getCatalogs,
    enabled: needsBank,
  });

  const bancos = data?.bancos ?? [];
  const [bankId, setBankId] = useState<number>(() => (selectedBank && selectedBank > 0 ? selectedBank : 0));
  const [savingBank, setSavingBank] = useState(false);

  const bankName = useMemo(() => {
    const b = bancos.find((x) => x.id === bankId);
    return b?.name ?? null;
  }, [bancos, bankId]);

  useEffect(() => {
    const state = location.state as ToastState;
    if (!state?.toast) return;
    toast({
      kind: state.toast.kind ?? "info",
      title: state.toast.title,
      message: state.toast.message,
    });
    navigate(location.pathname, { replace: true, state: {} });
  }, [location.pathname, location.state, navigate, toast]);

  useEffect(() => {
    if (!needsBank) return;
    if (bankId > 0) return;
    if (bancos.length > 0) setBankId(bancos[0].id);
  }, [bankId, bancos, needsBank]);

  const canConfirm = bankId > 0 && !savingBank;

  const confirmBank = async () => {
    if (!canConfirm) return;
    try {
      setSavingBank(true);
      await setSessionBank(bankId);
      toast({
        kind: "success",
        title: "Banco",
        message: bankName ? `Banco seleccionado: ${bankName}` : "Banco seleccionado.",
      });
    } catch (e: any) {
      const msg = e?.response?.data?.detail ?? e?.message ?? "No se pudo guardar el banco.";
      toast({ kind: "error", title: "Banco", message: String(msg) });
    } finally {
      setSavingBank(false);
    }
  };

  return (
    <div className="vi-home">
      <div
        className="vi-home__banner"
        style={{ backgroundImage: 'url("/medileser/banner.jpg")' }}
        role="img"
        aria-label="Medileser"
      />

      {needsBank && (
        <div className="modal fade show" style={{ display: "block" }} role="dialog" aria-modal="true">
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title">Seleccionar banco</h5>
              </div>

              <div className="modal-body">
                <p className="text-muted mb-3">Seleccione el banco de trabajo para continuar.</p>

                <label className="form-label" htmlFor="bankId">
                  Banco
                </label>
                <select
                  id="bankId"
                  className="form-select"
                  value={bankId || ""}
                  onChange={(e) => setBankId(Number(e.target.value))}
                  disabled={isLoading || savingBank}
                >
                  {bancos.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>

                {error ? (
                  <div className="alert alert-danger mt-3 mb-0" role="alert">
                    No se pudieron cargar los bancos.
                  </div>
                ) : null}
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-primary" disabled={!canConfirm} onClick={confirmBank}>
                  {savingBank ? "Guardando..." : "Continuar"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
