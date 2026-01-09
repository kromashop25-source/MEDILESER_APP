export function getFileKey(file: File) {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

export function normalizeFileName(name: string) {
  return name
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase();
}

export function getFileNameKey(file: File) {
  return normalizeFileName(file.name);
}

function normalizeAccept(accept: string | undefined) {
  if (!accept) return null;
  const parts = accept
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return null;
  return parts;
}

export function filterFilesByAccept(files: File[], accept: string | undefined) {
  const accepted = normalizeAccept(accept);
  if (!accepted) return files;

  const exts = accepted.filter((p) => p.startsWith("."));
  if (exts.length === 0) return files;

  return files.filter((f) => exts.some((ext) => f.name.toLowerCase().endsWith(ext)));
}

export function mergeFiles(prev: File[], next: File[]) {
  if (next.length === 0) return prev;

  const seen = new Set(prev.map(getFileNameKey));
  const merged = [...prev];

  for (const file of next) {
    const key = getFileNameKey(file);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(file);
    }
  }

  return merged;
}

export type MergeFilesReport = {
  merged: File[];
  added: File[];
  duplicates: File[];
};

export function mergeFilesWithReport(prev: File[], next: File[]): MergeFilesReport {
  if (next.length === 0) return { merged: prev, added: [], duplicates: [] };

  const merged = [...prev];
  const added: File[] = [];
  const duplicates: File[] = [];

  const seen = new Set(prev.map(getFileNameKey));
  for (const file of next) {
    const key = getFileNameKey(file);
    if (seen.has(key)) {
      duplicates.push(file);
      continue;
    }
    seen.add(key);
    merged.push(file);
    added.push(file);
  }

  return { merged, added, duplicates };
}
