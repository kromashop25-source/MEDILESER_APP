import { useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { filterFilesByAccept } from "./filePickerUtils";

type Props = {
  label: string;
  accept?: string;
  disabled?: boolean;
  file: File | null;
  onChange: (file: File | null) => void;
};

export default function SingleFilePicker({
  label,
  accept,
  disabled = false,
  file,
  onChange,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);
  const [isDragOver, setIsDragOver] = useState(false);

  const pick = () => {
    if (disabled) return;
    inputRef.current?.click();
  };

  const clear = () => {
    if (disabled) return;
    if (inputRef.current) inputRef.current.value = "";
    onChange(null);
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.files?.[0] ?? null);
    e.currentTarget.value = "";
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
    const filtered = filterFilesByAccept(dropped, accept);
    const next = filtered[0] ?? null;
    if (!next) return;
    if (inputRef.current) inputRef.current.value = "";
    onChange(next);
  };

  return (
    <div>
      <label className="form-label">{label}</label>

      <input
        ref={inputRef}
        className="d-none"
        type="file"
        accept={accept}
        onChange={onPick}
        disabled={disabled}
      />

      <div
        className={`vi-file-drop-target${isDragOver ? " is-dragover" : ""}`}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        aria-disabled={disabled ? "true" : "false"}
      >
        <div className="input-group">
        <button
          type="button"
          className="btn btn-outline-secondary"
          onClick={pick}
          disabled={disabled}
        >
          Examinar
        </button>
        <button
          type="button"
          className="btn btn-outline-danger"
          onClick={clear}
          disabled={disabled || !file}
        >
          Eliminar
        </button>
        <input
          className="form-control"
          type="text"
          readOnly
          value={file ? file.name : "No se ha seleccionado ningún archivo."}
        />
        </div>
      </div>
    </div>
  );
}
