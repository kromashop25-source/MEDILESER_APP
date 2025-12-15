import { useEffect, useRef } from "react";
import type { ChangeEvent } from "react";

type FileItem = {
  key: string;
  name: string;
};

type Props = {
  show: boolean;
  disabled?: boolean;
  files: FileItem[];
  onClose: () => void;
  onRemove: (key: string) => void;
  onRemoveAll: () => void;
  onAddFiles: (files: File[]) => void;
};

export default function OiFilesModal({
  show,
  disabled = false,
  files,
  onClose,
  onRemove,
  onRemoveAll,
  onAddFiles,
}: Props) {
  const addMoreRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show, onClose]);

  if (!show) return null;

  const handleAddMore = () => {
    if (disabled) return;
    addMoreRef.current?.click();
  };

  const handlePickMore = (e: ChangeEvent<HTMLInputElement>) => {
    const next = e.target.files ? Array.from(e.target.files) : [];
    if (next.length > 0) onAddFiles(next);
    e.currentTarget.value = "";
  };

  const handleRemoveAll = () => {
    if (disabled) return;
    if (addMoreRef.current) addMoreRef.current.value = "";
    onRemoveAll();
  };

  return (
    <div
      className="modal fade show"
      style={{ display: "block" }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="oiFilesModalTitle"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-dialog modal-lg">
        <div className="modal-content">
          <div className="modal-header">
            <h5 id="oiFilesModalTitle" className="modal-title">
              Archivos OI
            </h5>
            <button
              type="button"
              className="btn-close"
              aria-label="Cerrar"
              onClick={onClose}
            />
          </div>

          <div className="modal-body">
            <input
              ref={addMoreRef}
              className="d-none"
              type="file"
              accept=".xlsx,.xlsm"
              multiple
              onChange={handlePickMore}
              disabled={disabled}
            />

            <div className="d-flex align-items-center justify-content-between mB-10">
              <div className="text-muted">
                {files.length === 1 ? "1 archivo seleccionado" : `${files.length} archivos seleccionados`}
              </div>

              <div className="d-flex gap-10">
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary"
                  onClick={handleAddMore}
                  disabled={disabled}
                >
                  Agregar más
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-danger"
                  onClick={handleRemoveAll}
                  disabled={disabled || files.length === 0}
                >
                  Eliminar todos
                </button>
              </div>
            </div>

            {files.length === 0 ? (
              <div className="text-muted">No hay archivos seleccionados.</div>
            ) : (
              <div style={{ maxHeight: 380, overflow: "auto" }}>
                <ul className="list-group">
                  {files.map((f) => (
                    <li
                      key={f.key}
                      className="list-group-item d-flex align-items-center justify-content-between gap-10"
                    >
                      <div className="text-truncate" style={{ minWidth: 0 }}>
                        {f.name}
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-danger"
                        onClick={() => onRemove(f.key)}
                        disabled={disabled}
                      >
                        Eliminar
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-outline-secondary"
              onClick={onClose}
            >
              Cerrar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

