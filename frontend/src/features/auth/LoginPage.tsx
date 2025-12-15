import { useState } from "react";
import { useForm } from "react-hook-form";
import { login } from "../../api/auth";
import PasswordInput from "../../components/PasswordInput";
import Spinner from "../../components/Spinner";
import { useToast } from "../../components/Toast";

type Form = { username: string; password: string };

export default function LoginPage() {
  const { register, handleSubmit } = useForm<Form>({
    defaultValues: { username: "", password: "" },
  });
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);

  const onSubmit = async (v: Form) => {
    try {
      setLoading(true);
      await login(v);
      window.location.replace("/home");
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

  return (
    <div className="vi-login">
      <Spinner show={loading} label="Validando credenciales..." />
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
                    disabled={loading}
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
    </div>
  );
}

