type SpinnerProps = {
  show?: boolean;
  label?: string;
};

export default function Spinner({
  show = true,
  label = "Cargando...",
}: SpinnerProps) {
  if (!show) return null;
  return (
    <div
      className="vi-spinner-overlay"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <img
        className="vi-spinner-logo"
        src="/medileser/Spinner-Logo-Medileser.gif"
        alt=""
        aria-hidden="true"
      />
      <span className="visually-hidden">{label}</span>
    </div>
  );
}
