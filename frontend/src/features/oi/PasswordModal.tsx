import { useEffect, useRef, useState } from "react";
import PasswordInput from "../../components/PasswordInput";

type Props = {
  show: boolean;
  title?: string;
  onClose: () => void;
  onConfirm: (password: string) => void;
  confirmLabel?: string;
  helpText?: string;
};

export default function PasswordModal({
  show,
  title = "Contraseña para proteger Excel",
  confirmLabel = "Generar Excel",
  helpText = "Se usará para proteger estructura y escritura del libro. No habrá contraseña de apertura.",
  onClose,
  onConfirm,
}: Props) {
  const [pwd, setPwd] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const canSubmit = pwd.trim().length > 0;

  useEffect(() => {
    if (show) {
      setPwd("");
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [show]);

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show, onClose]);

  if (!show) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onConfirm(pwd.trim());
  };

  return (
    <div
      className="modal fade show"
      style={{ display: "block" }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="pwdModalTitle"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-dialog">
        <form className="modal-content" onSubmit={submit}>
          <div className="modal-header">
            <h5 id="pwdModalTitle" className="modal-title">
              {title}
            </h5>
            <button
              type="button"
              className="btn-close"
              aria-label="Cerrar"
              onClick={onClose}
            />
          </div>
          <div className="modal-body">
            <div className="mb-3">
              <PasswordInput
                label="Contraseña"
                inputId="pwd"
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
                inputRef={inputRef}
                minLength={1}
                required
              />
              <div className="form-text">{helpText}</div>
            </div>
          </div>
          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-outline-auto"
              onClick={onClose}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!canSubmit}
            >
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

