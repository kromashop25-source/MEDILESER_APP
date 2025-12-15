import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { filterFilesByAccept, getFileKey } from "./filePickerUtils";

type Props = {
  show: boolean;
  disabled?: boolean;
  title: string;
  accept?: string;
  files: File[];
  onClose: () => void;
  onAddFiles: (files: File[]) => void;
  onRemoveFile: (key: string) => void;
  onRemoveAll: () => void;
};

export default function FilePickerModal({
  show,
  disabled = false,
  title,
  accept,
  files,
  onClose,
  onAddFiles,
  onRemoveFile,
  onRemoveAll,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const [dupWarning, setDupWarning] = useState<string>("");

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show, onClose]);

  useEffect(() => {
    if (!show) setIsDragOver(false);
  }, [show]);

  useEffect(() => {
    if (show) setDupWarning("");
  }, [show]);

  if (!show) return null;

  const addIncomingFiles = (incoming: File[]) => {
    const filtered = filterFilesByAccept(incoming, accept);
    if (filtered.length === 0) return;

    const existing = new Set(files.map(getFileKey));
    const seen = new Set(existing);
    const toAdd: File[] = [];
    const duplicates: File[] = [];

    for (const file of filtered) {
      const key = getFileKey(file);
      if (seen.has(key)) {
        duplicates.push(file);
        continue;
      }
      seen.add(key);
      toAdd.push(file);
    }

    if (duplicates.length > 0) {
      const names = Array.from(new Set(duplicates.map((d) => d.name)));
      setDupWarning(
        names.length === 1
          ? `El archivo "${names[0]}" ya se encuentra cargado.`
          : `Los archivos ya se encuentran cargados: ${names.join(", ")}.`
      );
    }

    if (toAdd.length > 0) onAddFiles(toAdd);
  };

  const pickMore = () => {
    if (disabled) return;
    inputRef.current?.click();
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const next = e.target.files ? Array.from(e.target.files) : [];
    addIncomingFiles(next);
    e.currentTarget.value = "";
  };

  const removeAll = () => {
    if (disabled) return;
    if (inputRef.current) inputRef.current.value = "";
    onRemoveAll();
  };

  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    dragDepthRef.current += 1;
    setIsDragOver(true);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    if (disabled) return;

    const dropped = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
    addIncomingFiles(dropped);
  };

  return (
    <div
      className="modal fade show"
      style={{ display: "block" }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="filePickerModalTitle"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-dialog modal-lg modal-dialog-centered">
        <div className="modal-content">
          <div className="modal-header">
            <h5 id="filePickerModalTitle" className="modal-title">
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
            <input
              ref={inputRef}
              className="d-none"
              type="file"
              accept={accept}
              multiple
              onChange={onPick}
              disabled={disabled}
            />

            {dupWarning ? (
              <div className="alert alert-warning d-flex align-items-center justify-content-between" role="alert">
                <div>{dupWarning}</div>
                <button
                  type="button"
                  className="btn-close"
                  aria-label="Cerrar"
                  onClick={() => setDupWarning("")}
                />
              </div>
            ) : null}

            <div
              className={`vi-dropzone${isDragOver ? " is-dragover" : ""}`}
              onDragEnter={onDragEnter}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              aria-disabled={disabled ? "true" : "false"}
            >
              <div className="text-muted">
                Arrastra y suelta archivos aquí, o{" "}
                <button
                  type="button"
                  className="btn btn-link p-0 align-baseline"
                  onClick={pickMore}
                  disabled={disabled}
                >
                  selecciona desde tu equipo
                </button>
                .
              </div>
              {accept ? <div className="form-text">Tipos permitidos: {accept}</div> : null}
            </div>

            <div className="d-flex align-items-center justify-content-between mT-15 mB-10">
              <div className="text-muted">
                {files.length === 0
                  ? "No se han seleccionado archivos."
                  : files.length === 1
                    ? "1 archivo seleccionado"
                    : `${files.length} archivos seleccionados`}
              </div>

              <div className="d-flex gap-10">
                <button
                  type="button"
                  className="btn btn-sm btn-outline-primary"
                  onClick={pickMore}
                  disabled={disabled}
                >
                  Agregar más
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={removeAll}
                  disabled={disabled || files.length === 0}
                >
                  Eliminar todos
                </button>
              </div>
            </div>

            {files.length === 0 ? null : (
              <div style={{ maxHeight: 320, overflow: "auto" }}>
                <ul className="list-group">
                  {files.map((f) => {
                    const key = getFileKey(f);
                    return (
                      <li
                        key={key}
                        className="list-group-item d-flex align-items-center justify-content-between gap-10"
                      >
                        <div className="text-truncate" style={{ minWidth: 0 }}>
                          {f.name}
                        </div>
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-danger"
                          onClick={() => onRemoveFile(key)}
                          disabled={disabled}
                        >
                          Eliminar
                        </button>
                      </li>
                    );
                  })}
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
