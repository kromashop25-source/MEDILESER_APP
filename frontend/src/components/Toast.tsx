import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type ToastKind = "success" | "error" | "info" | "warning";
type Toast = { id: number; kind: ToastKind; message: string; title?: string; duration?: number };
type ToastCtx = { push: (t: Omit<Toast, "id">) => void };

const Ctx = createContext<ToastCtx | null>(null);

function kindToBs(kind: ToastKind) {
  return kind === "success" ? "success"
       : kind === "error"   ? "danger"
       : kind === "warning" ? "warning"
       : "secondary";
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);

  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    // Evita propiedades duplicadas: aplica defaults y luego el resto
    const { kind = "info", duration = 3500, ...rest } = t;
    const toast: Toast = { id, kind, duration, ...rest };
    setList((prev) => [...prev, toast]);
    window.setTimeout(() => {
      setList((prev) => prev.filter((x) => x.id !== id));
    }, duration);
  }, []);
  const close = (id: number) => setList((prev) => prev.filter((x) => x.id !== id));

  return (
    <Ctx.Provider value={{ push }}>
      {children}

      <div className="vi-toast-container position-fixed top-0 end-0 p-3">
        {list.map((t) => (
          <div key={t.id} className={`toast show align-items-center text-bg-${kindToBs(t.kind)} border-0 mb-2`} role="alert">
            <div className="d-flex">
              <div className="toast-body">
                {t.title && <strong className="me-2">{t.title}</strong>}
                {t.message}
              </div>
              <button className="btn-close btn-close-white me-2 m-auto" aria-label="Close" onClick={() => close(t.id)} />
            </div>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return { toast: ctx.push };
}
