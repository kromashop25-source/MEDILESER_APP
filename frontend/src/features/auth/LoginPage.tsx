import { useQuery } from "@tanstack/react-query";
import { getCatalogs, type Catalogs } from "../../api/catalogs";
import { useForm } from "react-hook-form";
import { login } from "../../api/auth";
import { useEffect, useState } from "react";
import { useToast } from "../../components/Toast";
import Spinner from "../../components/Spinner";
import PasswordInput from "../../components/PasswordInput";

type Form = { username: string; password: string; bancoId: number };

export default function LoginPage() {
  const { data, isLoading, error } = useQuery<Catalogs>({
    queryKey: ["catalogs"],
    queryFn: getCatalogs,
    initialData: { q3: [], alcance: [], pma: [], bancos: [] },
  });
  const { register, handleSubmit, setValue } = useForm<Form>({
    defaultValues: { username: "", password: "", bancoId: undefined as any },
  });
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);

  // Fijar banco por defecto apenas lleguen los catálogos (sin obligar al usuario a abrir el select)
  useEffect(() => {
    if (data?.bancos?.length) {
      setValue("bancoId", data.bancos[0].id, { shouldValidate: true });
    }
  }, [data, setValue]);

  const onSubmit = async (v: Form) => {
    try {
      setLoading(true);
      // Validación extra por si el select quedó sin tocar
      if (v.bancoId === undefined || Number.isNaN(v.bancoId)) {
        throw new Error("Selecciona el N° de banco.");
      }
      await login({ ...v, bancoId: Number(v.bancoId) });
      // Redirección segura: evita tener que refrescar manualmente
      // (si prefieres SPA puro, deja navigate("/oi"); pero esto garantiza la carga del banner)
      window.location.replace("/");
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

  if (isLoading) return <div className="container p-4">Cargando catálogos...</div>;
  if (error) return <div className="container p-4 text-danger">No pude cargar catálogos</div>;

  return (
    <div className="vi-login">
      <Spinner show={loading} label="Validando credenciales..." />
      <div className="vi-login__split">
        {/* Panel izquierdo (branding / título) */}
        <section className="vi-login__left">
          <div className="text-center text-md-start">
            <h1 className="vi-title display-6 mb-0">
              ACCESO AL SISTEMA MEDILESER APP
            </h1>
          </div>
        </section>

        {/* Panel derecho (formulario) */}
        <section className="vi-login__right">
          <div className="card shadow-sm vi-login__card">
            <div className="card-body p-4 p-md-5">
              <h2 className="h4 text-center mb-4">Bienvenido</h2>

              <form onSubmit={handleSubmit(onSubmit)} className="row g-3">
                <div className="col-md-6">
                  <label htmlFor="username" className="form-label">Usuario</label>
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

                <div className="col-md-12">
                  <label htmlFor="bancoId" className="form-label">N° de banco</label>
                  <select
                    id="bancoId"
                    className="form-select"
                    {...register("bancoId", { valueAsNumber: true, required: true })}
                  >
                    {data?.bancos?.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </div>

                <div className="col-12 d-grid">
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={loading || !data?.bancos?.length}
                    aria-busy={loading ? "true" : "false"}
                  >
                    {loading ? (
                      <>
                        <span className="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true" />
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
