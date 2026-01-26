import { useState } from "react";
import type { InputHTMLAttributes, Ref } from "react";

type Props = {
  label?: string;
  inputId?: string;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
  helpText?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "id" | "className">;

export default function PasswordInput({
  label,
  inputId,
  className = "",
  inputRef,
  helpText,
  ...inputProps
}: Props) {
  const [visible, setVisible] = useState(false);
  const id = inputId || inputProps.name || undefined;
  // Preserva el ref que entrega react-hook-form u otros consumidores
  const { ref: rhfRef, ...rest } = inputProps as typeof inputProps & {
    ref?: Ref<HTMLInputElement>;
  };
  const resolvedRef = inputRef ?? rhfRef;

  return (
    <div className={className}>
      {label && (
        <label className="form-label" htmlFor={id}>
          {label}
        </label>
      )}
      <div className="input-group">
        <input
          {...rest}
          id={id}
          type={visible ? "text" : "password"}
          className="form-control"
          ref={resolvedRef}
        />
        <button
          type="button"
          className="btn btn-outline-auto"
          onClick={() => setVisible((v) => !v)}
          tabIndex={-1}
          aria-label={visible ? "Ocultar contraseña" : "Mostrar contraseña"}
        >
          <i className={`ti ${visible ? "ti-eye-off" : "ti-eye"}`} />
        </button>
      </div>
      {helpText && <div className="form-text">{helpText}</div>}
    </div>
  );
}

