import { useEffect, useId, useState } from "react";
import { getEffectiveTheme, setTheme, subscribe } from "../utils/theme";

type Props = {
  className?: string;
};

export default function ThemeToggle({ className }: Props) {
  const inputId = useId();
  const [theme, setCurrentTheme] = useState(() => getEffectiveTheme());

  useEffect(() => subscribe(setCurrentTheme), []);

  const isDark = theme === "dark";

  return (
    <div className={`theme-toggle d-flex ai-c ${className ?? ""}`.trim()}>
      <div className="form-check form-switch d-flex ai-c" style={{ margin: 0, padding: 0 }}>
        <label
          className="form-check-label me-2 text-nowrap c-grey-700"
          htmlFor={inputId}
          style={{ fontSize: "12px", marginRight: "8px" }}
        >
          <i className="ti-sun" style={{ marginRight: "4px" }} />
          <span className="theme-label">Claro</span>
        </label>
        <input
          className="form-check-input"
          type="checkbox"
          id={inputId}
          checked={isDark}
          onChange={(e) => setTheme(e.target.checked ? "dark" : "light")}
          aria-label="Cambiar tema"
          style={{ margin: 0 }}
        />
        <label
          className="form-check-label ms-2 text-nowrap c-grey-700"
          htmlFor={inputId}
          style={{ fontSize: "12px", marginLeft: "8px" }}
        >
          <span className="theme-label">Oscuro</span>
          <i className="ti-moon" style={{ marginLeft: "4px" }} />
        </label>
      </div>
    </div>
  );
}
