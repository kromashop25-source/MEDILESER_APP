# Guía de Estilos (UI) – FORMATO A y C

Este paquete añade **tokens CSS** (`app/static/css/tokens.css`) y un **refactor incremental** en `app/static/css/vima.css`
para mejorar contraste, coherencia visual y accesibilidad **sin cambiar la lógica** del back-end.

## Archivos incluidos
- `app/static/css/tokens.css`: variables CSS (colores semánticos, tipografía, espaciado) y utilitarias mínimas.
- `app/static/css/vima.css`: `@import "./tokens.css";` + componentes (botones, badges, tablas, toasts).
- `docs/styleguide.html`: página estática para revisar componentes y paleta.

## Cómo aplicar
1. Asegúrate de que tu plantilla HTML cargue `vima.css` (que ya importará `tokens.css`).
2. (Opcional) Cambia clases a `.btn .btn-primary`, `.table`, `.badge-*`, etc.
3. Revisa `docs/styleguide.html` en un navegador.

## Contraste
La paleta está pensada para **WCAG AA** en texto normal.
