import { useMemo, useRef, useState } from "react";
import type { Dispatch, DragEvent, SetStateAction } from "react";
import FilePickerModal from "./FilePickerModal";
import { filterFilesByAccept, getFileKey, mergeFilesWithReport } from "./filePickerUtils";

type Props = {
  label: string;
  title: string;
  accept?: string;
  disabled?: boolean;
  files: File[];
  setFiles: Dispatch<SetStateAction<File[]>>;
};

function buildDupWarningMessage(duplicates: File[]) {
  if (duplicates.length === 0) return "";
  const names = Array.from(new Set(duplicates.map((d) => d.name)));
  return names.length === 1
    ? `El archivo "${names[0]}" ya se encuentra cargado.`
    : `Los archivos ya se encuentran cargados: ${names.join(", ")}.`;
}

export default function MultiFilePicker({
  label,
  title,
  accept,
  disabled = false,
  files,
  setFiles,
}: Props) {
  const [showModal, setShowModal] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [dupWarning, setDupWarning] = useState("");
  const dragDepthRef = useRef(0);

  const countLabel = useMemo(() => {
    if (files.length === 0) return "No se han seleccionado archivos.";
    if (files.length === 1) return "1 archivo seleccionado";
    return `${files.length} archivos seleccionados`;
  }, [files.length]);

  const buttonLabel = files.length === 0 ? "Agregar archivos" : "Modificar/agregar archivos";

  const addFiles = (incoming: File[]) => {
    const filtered = filterFilesByAccept(incoming, accept);
    if (filtered.length === 0) return;

    setFiles((prev) => {
      const { merged, duplicates } = mergeFilesWithReport(prev, filtered);
      if (duplicates.length > 0) setDupWarning(buildDupWarningMessage(duplicates));
      return merged;
    });
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
    addFiles(dropped);
  };

  return (
    <div>
      <label className="form-label">{label}</label>

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
            className="btn btn-outline-primary"
            onClick={() => setShowModal(true)}
            disabled={disabled}
          >
            {buttonLabel}
          </button>
          <input className="form-control" type="text" readOnly value={countLabel} />
        </div>
      </div>

      {dupWarning ? (
        <div className="alert alert-warning d-flex align-items-center justify-content-between mT-10" role="alert">
          <div>{dupWarning}</div>
          <button
            type="button"
            className="btn-close"
            aria-label="Cerrar"
            onClick={() => setDupWarning("")}
          />
        </div>
      ) : null}

      <FilePickerModal
        show={showModal}
        disabled={disabled}
        title={title}
        accept={accept}
        files={files}
        onClose={() => setShowModal(false)}
        onAddFiles={addFiles}
        onRemoveFile={(key) => setFiles((prev) => prev.filter((f) => getFileKey(f) !== key))}
        onRemoveAll={() => setFiles([])}
      />
    </div>
  );
}
