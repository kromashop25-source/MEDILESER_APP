# FORMATO VI – Interfaz de Registro OI

Aplicación web para reemplazar el llenado manual en Excel del **Formato VI** usado por el Organismo de Inspección (OI).

Incluye:

- Frontend React + TypeScript (Vite) con plantilla **Adminator/Bootstrap**.
- Backend **FastAPI** + **SQLModel** + **SQLite**.
- Generación de Excel basada en la plantilla oficial `PLANTILLA_VI.xlsx` (hoja `ERROR FINAL`).
- Gestión de OI, bancadas (Grid tipo Excel) y exportación consolidada a un solo archivo por OI.

---

## 1. Estructura del proyecto

```text
vi-app/
  frontend/                 # React + TypeScript (Vite)
    public/adminator/       # Assets del template Adminator (CSS/JS/img)
    src/
      app/                  # App shell, rutas
      layouts/              # Layouts principales (AdminatorLayout, etc.)
      features/
        auth/               # Login, gestión de usuarios
        oi/                 # OI: listado, formulario, Excel
        bancadas/           # Modal / Grid de bancadas
      components/           # Componentes compartidos
      types/                # Tipos globales TS
  backend/                  # FastAPI
    app/
      main.py               # Punto de entrada FastAPI
      api/
        auth.py             # /auth (login, usuarios)
        catalogs.py         # /catalogs (Q3, Alcance, PMA, bancos)
        oi.py               # /oi, /oi/{id}/bancadas, /oi/{id}/excel
      core/                 # Configuración, seguridad, settings
      models.py             # Modelos SQLModel (User, OI, Bancada)
      schemas.py            # Esquemas Pydantic (requests/responses)
      services/
        excel_service.py    # Lógica de generación del Excel
        rules_service.py    # Reglas de negocio (PMA→Presión, etc.)
      repositories/         # (si aplica) acceso a datos
      data/
        PLANTILLA_VI.xlsx   # Plantilla oficial Formato VI
  docs/
    Diccionario_Form-Excel.md       # Mapeo UI ↔ JSON ↔ Excel
    Acuerdos_de_Afinamiento_VI.md   # Hoja ERROR FINAL, protección, 422
    API_Contracts.md                # Contratos de API
    Manual_Usuario_Formato_VI.md    # Manual de usuario
  scripts/
    dev.sh / dev.ps1        # Scripts de ayuda para entorno local
```

---

## 2. Requisitos

### 2.1 Backend

- Python **3.11+**
- pip
- (Opcional) `virtualenv` o `venv`

### 2.2 Frontend

- Node.js **20+**
- npm (incluido con Node)

---

## 3. Configuración del backend

### 3.1 Crear y activar entorno virtual

```bash
cd backend
python -m venv .venv
# Windows
.venv\Scripts\activate
# Unix/Mac
source .venv/bin/activate
```

### 3.2 Instalar dependencias

```bash
pip install -U pip
pip install fastapi "uvicorn[standard]" sqlmodel pydantic-settings \
            python-multipart openpyxl
```

Si se agregan más dependencias en el futuro, mantener un `requirements.txt` actualizado.

### 3.3 Variables de entorno (.env)

En `backend/` crear un archivo `.env` (idealmente a partir de `.env.example`):

```env
APP_NAME="Formato VI"
CORS_ORIGINS="http://localhost:5173"
DATABASE_URL="sqlite:///./app/data/vi.db"

TEMPLATE_PATH="app/data/PLANTILLA_VI.xlsx"
CELLS_PROTECTION_PASSWORD="interno_seguro"
```

- `CORS_ORIGINS`: URL del frontend (por defecto Vite: `http://localhost:5173`).
- `DATABASE_URL`: ruta de la base SQLite (ya apuntando a `vi.db` dentro de `app/data`).
- `TEMPLATE_PATH`: ruta relativa a la plantilla **PLANTILLA_VI.xlsx**.
- `CELLS_PROTECTION_PASSWORD`: contraseña interna para proteger estructura de libro y hoja `ERROR FINAL`.  
  > Esta contraseña no se expone al usuario; se utiliza solo en el backend.

### 3.4 Inicializar base de datos

Si el proyecto incluye un script de migraciones/seed, ejecutarlo.  
Si no, normalmente la base se crea automáticamente al levantar FastAPI con SQLModel (primer uso).

---

## 4. Ejecución del backend (desarrollo)

Desde `vi-app/backend` con el entorno virtual activo:

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

- API disponible en: `http://localhost:8000`
- Documentación interactiva:
  - Swagger UI: `http://localhost:8000/docs`
  - Redoc: `http://localhost:8000/redoc`

---

## 5. Configuración del frontend

### 5.1 Instalar dependencias

```bash
cd ../frontend
npm install
# o, si no está inicializado:
# npm create vite@latest . -- --template react-ts
# npm install
```

Dependencias usadas (referencia):

- `axios`
- `@tanstack/react-query`
- `react-hook-form`
- `zod`
- `react-router-dom`
- `bootstrap`

### 5.2 Integrar Adminator

Los assets de Adminator deben estar en:

```text
frontend/public/adminator/
  css/
  js/
  img/
  ...
```

En `main.tsx` / `index.tsx` se incluyen:

- CSS de Bootstrap.
- CSS específico del template Adminator.

El layout principal (`AdminatorLayout`) define:

- **Sidebar** con los menús de navegación (Login, OI, etc.).
- **Topbar** con información del usuario y botón de Logout.
- `<Outlet />` para renderizar las páginas internas.

---

## 6. Ejecución del frontend (desarrollo)

Desde `vi-app/frontend`:

```bash
npm run dev
```

Por defecto Vite levanta en:

- `http://localhost:5173`

El frontend se comunica con el backend usando esta URL base (configurada en el cliente `axios`), por ejemplo:

```ts
const api = axios.create({
  baseURL: "http://localhost:8000",
});
```

---

## 7. Flujo básico de uso

1. Abrir el frontend: `http://localhost:5173`.
2. **Login** con usuario, contraseña y N° de banco.
3. Crear una **OI**:
   - Código `OI-####-YYYY`.
   - Seleccionar Q3, Alcance, PMA.
   - Elegir tipo de numeración de medidor.
4. Gestionar **bancadas**:
   - Agregar/editar bancadas.
   - Completar Grid Q3/Q2/Q1 y Estados por fila.
5. **Generar Excel** para la OI:
   - Opcional: ingresar contraseña de “reserva” (mensaje de solo lectura).
   - Descargar archivo `OI-####-YYYY-NOMBRE APELLIDO-YYYY-MM-DD.xlsx`.
6. Trabajar sobre la hoja `ERROR FINAL` del Excel, respetando las celdas desbloqueadas (celdas de datos).

Para más detalle de uso, ver:  
`docs/Manual_Usuario_Formato_VI.md`.

---

## 8. Build y despliegue

### 8.1 Build frontend

```bash
cd frontend
npm run build
```

El resultado queda en `frontend/dist/`.  
En un despliegue más avanzado, este contenido puede servirse:

- Con un servidor web (Nginx/Apache).
- Integrado al backend (montando `dist` como `StaticFiles` en FastAPI).

### 8.2 Backend en producción

Pasos generales:

1. Configurar `.env` con rutas y contraseñas definitivas.
2. Usar un servidor de aplicaciones (ej. `gunicorn` + `uvicorn workers` o `uvicorn` detrás de Nginx).
3. Asegurar la ruta a `PLANTILLA_VI.xlsx` (`TEMPLATE_PATH`) y permisos de escritura/lectura sobre la carpeta de data.

---

## 9. Pruebas

Se recomienda:

- **Pruebas manuales**:
  - Crear OI con 1–N bancadas.
  - Variar cantidad de filas (5–200).
  - Verificar que el Excel generado mantiene fórmulas y bordes A..BL por bancada.
- **Pruebas E2E**:
  - Scripts automatizados (Playwright / Cypress) para validar:
    - Login.
    - CRUD de OI y bancadas.
    - Generación y descarga de Excel.

Ver `docs/Pruebas_*.md` (si se incluyen) para detalles.

---

## 10. Notas adicionales

- Los contratos de API se documentan en:  
  `docs/API_Contracts.md`.
- El mapeo exacto de campos del formulario hacia la plantilla Excel se detalla en:  
  `docs/Diccionario_Form-Excel.md`.
- Acuerdos sobre protección de hoja, contraseñas internas y errores 422 se encuentran en:  
  `docs/Acuerdos_de_Afinamiento_VI.md`.

Para dudas funcionales, consultar primero el Manual de Usuario.  
Para dudas técnicas, revisar este README y los documentos en `/docs`.
