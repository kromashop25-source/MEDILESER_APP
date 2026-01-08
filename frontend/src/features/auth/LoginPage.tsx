import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { getCatalogs } from "../../api/catalogs";
import type { Catalogs } from "../../api/catalogs";
import { isTechnicianRole, login, logout, setSessionBank } from "../../api/auth";
import { getSessionUserId, popPendingToast } from "../../api/client";
import PasswordInput from "../../components/PasswordInput";
import Spinner from "../../components/Spinner";
import { useToast } from "../../components/Toast";

type Form = { username: string; password: string };

export default function LoginPage() {
  const { register, handleSubmit } = useForm<Form>({
    defaultValues: { username: "", password: "" },
  });
  const { toast } = useToast();
  const params = new URLSearchParams(window.location.search);
  const returnToRaw = params.get("returnTo") ?? "";
  const returnTo = returnToRaw.startsWith("/") ? returnToRaw : "/home";
  const [loading, setLoading] = useState(false);
  const postLoginTargetRef = useRef(returnTo);
  const [showBankModal, setShowBankModal] = useState(false);
  const [bankId, setBankId] = useState<number>(0);
  const [savingBank, setSavingBank] = useState(false);

  const { data, isLoading, error, refetch } = useQuery<Catalogs>({
    queryKey: ["catalogs"],
    queryFn: getCatalogs,
    enabled: showBankModal,
  });

  const bancos = data?.bancos ?? [];

  useEffect(() => {
    const msg = popPendingToast();
    if (!msg) return;
    toast({ kind: "error", message: msg });
  }, [toast]);

  useEffect(() => {
    if (!showBankModal) return;
    if (bankId > 0) return;
    if (bancos.length > 0) setBankId(bancos[0].id);
  }, [bankId, bancos, showBankModal]);

  const onSubmit = async (v: Form) => {
    try {
      setLoading(true);
      const prevUserId = getSessionUserId();
      const auth = await login(v);
      const switchedUser = prevUserId != null && auth.userId && prevUserId !== auth.userId;
      postLoginTargetRef.current = switchedUser ? "/home" : returnTo;
      if (isTechnicianRole(auth.role)) {
        setShowBankModal(true);
        toast({ kind: "info", title: "Banco", message: "Seleccione el banco para continuar." });
        return;
      }
      window.location.replace(postLoginTargetRef.current);
    } catch (e: any) {
      const msg =
        e?.message ??
        e?.response?.data?.detail ??
        (typeof e === "string" ? e : "Error de autenticación");
      toast({ kind: "error", title: "Login", message: String(msg) });
    } finally {
      setLoading(false);
    }
  };

  const canConfirmBank = bankId > 0 && !savingBank && !isLoading;

  const confirmBank = async () => {
    if (!canConfirmBank) return;
    try {
      setSavingBank(true);
      await setSessionBank(bankId);
      window.location.replace(postLoginTargetRef.current);
    } catch (e: any) {
      const msg = e?.response?.data?.detail ?? e?.message ?? "No se pudo guardar el banco.";
      toast({ kind: "error", title: "Banco", message: String(msg) });
    } finally {
      setSavingBank(false);
    }
  };

  const cancelBank = () => {
    logout();
    setShowBankModal(false);
    setBankId(0);
  };

  return (
    <div className="vi-login">
      <Spinner show={loading || savingBank} label={savingBank ? "Guardando banco..." : "Validando credenciales..."} />
      <div className="vi-login__split">
        <section className="vi-login__left">
          <div className="text-center text-md-start">
            <h1 className="vi-title display-6 mb-0">ACCESO AL SISTEMA MEDILESER APP</h1>
          </div>
        </section>

        <section className="vi-login__right">
          <div className="card shadow-sm vi-login__card">
            <div className="card-body p-4 p-md-5">
              <h2 className="h4 text-center mb-4">Bienvenido</h2>

              <form onSubmit={handleSubmit(onSubmit)} className="row g-3">
                <div className="col-md-6">
                  <label htmlFor="username" className="form-label">
                    Usuario
                  </label>
                  <input
                    id="username"
                    className="form-control"
                    autoFocus
                    autoComplete="username"
                    {...register("username", { required: true })}
                  />
                </div>

                <div className="col-md-6">
                  <PasswordInput
                    label="Contraseña"
                    inputId="password"
                    autoComplete="current-password"
                    {...register("password", { required: true })}
                  />
                </div>

                <div className="col-12 d-grid">
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={loading || showBankModal}
                    aria-busy={loading ? "true" : "false"}
                  >
                    {loading ? (
                      <>
                        <span
                          className="spinner-border spinner-border-sm me-2"
                          role="status"
                          aria-hidden="true"
                        />
                        Ingresando...
                      </>
                    ) : (
                      "Ingresar"
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </section>
      </div>

      {showBankModal && (
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
                    <button type="button" className="btn btn-sm btn-outline-danger ms-2" onClick={() => refetch()}>
                      Reintentar
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-outline-secondary" onClick={cancelBank} disabled={savingBank}>
                  Cancelar
                </button>
                <button type="button" className="btn btn-primary" disabled={!canConfirmBank} onClick={confirmBank}>
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
