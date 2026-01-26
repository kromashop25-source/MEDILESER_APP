export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "medileser.theme";
const ADMINATOR_THEME_KEY = "adminator-theme";

type Listener = (theme: Theme) => void;

const listeners = new Set<Listener>();

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark";
}

export function getStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(stored)) return stored;
    const fallback = localStorage.getItem(ADMINATOR_THEME_KEY);
    return isTheme(fallback) ? fallback : null;
  } catch {
    return null;
  }
}

export function getEffectiveTheme(): Theme {
  return getStoredTheme() ?? "light";
}

export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.setAttribute("data-bs-theme", theme);
  root.style.colorScheme = theme;
}

export function initTheme(): Theme {
  const theme = getEffectiveTheme();
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // ignore storage failures
  }
  try {
    localStorage.setItem(ADMINATOR_THEME_KEY, theme);
  } catch {
    // ignore storage failures
  }
  applyTheme(theme);
  return theme;
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // ignore storage failures
  }
  try {
    localStorage.setItem(ADMINATOR_THEME_KEY, theme);
  } catch {
    // ignore storage failures
  }
  applyTheme(theme);
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent("adminator:themeChanged", { detail: { theme } }));
  }
  listeners.forEach((listener) => listener(theme));
}

export function toggleTheme(): Theme {
  const next = getEffectiveTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
