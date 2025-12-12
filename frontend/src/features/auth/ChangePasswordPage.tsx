import { useState } from "react";
import { useToast } from "../../components/Toast";
import { changeOwnPassword } from "../../api/auth";
import PasswordInput from "../../components/PasswordInput";

export default function ChangePasswordPage() {
  const { toast } = useToast();
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [busy, setBusy] = useState(false);

  const canSubmit = oldPwd.trim().length > 0 && newPwd.trim().length > 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    try {
      setBusy(true);
      await changeOwnPassword(oldPwd.trim(), newPwd.trim());
      toast({ kind: "success", message: "Contraseña actualizada" });
      setOldPwd("");
      setNewPwd("");
    } catch (err: any) {
      toast({
        kind: "error",
        title: "Error",
        message: err?.message ?? "No se pudo cambiar la contraseña",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="container py-4">
      <div className="row justify-content-center">
        <div className="col-md-6">
          <div className="card shadow-sm">
            <div className="card-header">
              <h5 className="mb-0">Cambiar mi contraseña</h5>
            </div>
            <form onSubmit={submit}>
              <div className="card-body">
                <div className="mb-3">
                  <PasswordInput
                    label="Contraseña actual"
                    inputId="oldPwd"
                    value={oldPwd}
                    onChange={(e) => setOldPwd(e.target.value)}
                    required
                    autoComplete="current-password"
                  />
                </div>
                <div className="mb-3">
                  <PasswordInput
                    label="Nueva contraseña"
                    inputId="newPwd"
                    value={newPwd}
                    onChange={(e) => setNewPwd(e.target.value)}
                    required
                    autoComplete="new-password"
                    helpText="Usa una contraseña segura y que recuerdes."
                  />
                </div>
              </div>
              <div className="card-footer d-flex justify-content-end gap-2">
                <button
                  type="button"
                  className="btn btn-outline-secondary"
                  onClick={() => {
                    setOldPwd("");
                    setNewPwd("");
                  }}
                  disabled={busy}
                >
                  Limpiar
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!canSubmit || busy}
                >
                  Guardar
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
