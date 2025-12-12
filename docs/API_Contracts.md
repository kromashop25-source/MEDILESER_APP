# API Contracts – Formato VI

Backend: **FastAPI**  
Base URL por defecto: `http://localhost:8000`

Los endpoints se organizan en los siguientes grupos:

- `/auth` – autenticación y gestión de usuarios
- `/catalogs` – catálogos de Q3, Alcance, PMA y bancos
- `/oi` – gestión de OI y generaciones de Excel
- `/oi/.../bancadas` – CRUD de bancadas asociadas a una OI

---

## 0. Convenciones generales

### 0.1 Autenticación

- La autenticación se basa en **tokens de sesión** (no JWT) devueltos por `POST /auth/login`.
- Cada petición autenticada debe incluir el header:

```http
Authorization: Bearer <token>
```

- El token expira luego de 12 horas (se valida en backend antes de cada uso).

### 0.2 Formato de datos

- Todas las entradas/salidas son JSON, salvo descargas de Excel (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`).
- Fechas de filtro en query string siempre en formato `YYYY-MM-DD`.
- Fechas en payloads (`created_at`, `updated_at`) se manejan como ISO 8601.

### 0.3 Roles y acceso

- `admin`:
  - Puede ver todas las OI y bancadas.
  - Puede crear/editar/eliminar usuarios (con restricciones).
  - Puede eliminar OI.
- `user` (técnico):
  - Solo ve y modifica sus OI (mismo `techNumber` y `bancoId` que la sesión).
  - No puede gestionar otros usuarios.

---

## 1. /auth – Autenticación y usuarios

### 1.1 POST /auth/login

**Descripción**  
Inicia sesión con usuario y contraseña y crea una sesión en memoria.

**Request body**

```json
{
  "username": "admin",
  "password": "1234",
  "bancoId": 3
}
```

**Response 200 – LoginOut**

```json
{
  "user": "admin",
  "userId": 1,
  "username": "admin",
  "firstName": "Administrador",
  "lastName": "Sistema",
  "fullName": "Administrador Sistema",
  "bancoId": 3,
  "techNumber": 0,
  "role": "admin",
  "token": "a3f12c..."
}
```

**Códigos de respuesta**

- `200` – login correcto.
- `401` – credenciales inválidas.
- `401` – credenciales inválidas (caso admin bootstrap con contraseña distinta a `1234`).
- `403` – usuario inactivo (`is_active = False`).

**Notas**

- Si el usuario `"admin"` no existe y se intenta loguear como `admin/1234`, el backend **crea** el usuario admin con contraseña `1234` (solo primera vez).
- El `bancoId` se almacena en la sesión para filtrar y etiquetar OI.

---

### 1.2 GET /auth/me

**Descripción**  
Devuelve los datos de la sesión actual (requiere header `Authorization: Bearer ...`).

**Response 200 – LoginOut**  
Mismo formato del objeto devuelto en `POST /auth/login`.

**Errores**

- `401` – token ausente, inválido o expirado.

---

### 1.3 POST /auth/logout

**Descripción**  
Elimina la sesión asociada al token actual.

**Request**

- Header `Authorization: Bearer <token>`.

**Response 200**

```json
{ "ok": true }
```

---

### 1.4 GET /auth/users  (solo admin)

**Descripción**  
Listado de todos los usuarios registrados.

**Response 200 – List<UserRead> (ejemplo)**

```json
[
  {
    "id": 1,
    "username": "admin",
    "first_name": "Administrador",
    "last_name": "Sistema",
    "tech_number": 0,
    "role": "admin",
    "is_active": true
  },
  {
    "id": 2,
    "username": "tecnico01",
    "first_name": "Carlos",
    "last_name": "Gómez",
    "tech_number": 101,
    "role": "user",
    "is_active": true
  }
]
```

**Errores**

- `401` – sin token.
- `403` – sesión no tiene rol `admin`.

---

### 1.5 POST /auth/users  (solo admin)

**Descripción**  
Crea un nuevo usuario técnico o admin.

**Request body – UserCreate (ejemplo)**

```json
{
  "username": "tecnico01",
  "first_name": "Carlos",
  "last_name": "Gómez",
  "tech_number": 101,
  "role": "user",
  "password": "secreto123"
}
```

**Reglas**

- `username` se guarda siempre en minúsculas.
- `username` debe ser único.
- `tech_number` debe ser único (salvo 0 para admin genérico).

**Response 200 – UserRead**  
Usuario creado sin el campo `password`.

**Errores**

- `400` – nombre de usuario ya existe.
- `400` – `tech_number` ya asignado (≠ 0).
- `401` – sin token.
- `403` – no es admin.

---

### 1.6 DELETE /auth/users/{user_id}  (solo admin)

**Descripción**  
Elimina un usuario, con reglas de seguridad adicionales.

**Reglas de negocio**

- Solo el usuario `"admin"` puede eliminar a otros administradores.
- No se puede eliminar el usuario `"admin"` principal.
- No se puede eliminar un usuario que tenga OI registradas (match por `tech_number`).

**Response 200**

```json
{ "ok": true }
```

**Errores**

- `401` – sin token.
- `403` – usuario sin rol admin o no es `"admin"` intentando eliminar otro admin.
- `400` – intento de eliminar usuario `"admin"` principal o usuario con OI asociadas.
- `404` – usuario no encontrado.

---

### 1.7 PUT /auth/users/{user_id}/password  (admin cambia contraseña de otro usuario)

**Descripción**  
Permite a un admin cambiar la contraseña de cualquier usuario, con restricciones:

- Solo usuarios con `role="admin"` acceden al endpoint.
- El superadmin `"admin"` puede cambiar la contraseña de cualquier usuario.
- Otros admins solo pueden cambiar contraseñas de técnicos (`role="user"`).

**Request body – UserUpdatePassword**

```json
{
  "new_password": "Nueva1234!"
}
```

**Response 200**

```json
{ "ok": true, "message": "Contraseña actualizada por administrador" }
```

**Errores**

- `401` – sin token.
- `403` – no admin o intento de cambiar contraseña de admin sin ser `"admin"`.
- `404` – usuario no encontrado.

---

### 1.8 PUT /auth/password  (usuario cambia SU propia contraseña)

**Descripción**  
Permite a cualquier usuario (técnico o admin) cambiar su propia contraseña.

**Request body – UserUpdatePassword**

```json
{
  "old_password": "Actual123",
  "new_password": "Nueva1234!"
}
```

**Reglas**

- `old_password` es obligatorio.
- Se verifica que coincida con la contraseña actual antes de actualizar.

**Response 200**

```json
{ "ok": true, "message": "Su contraseña ha sido actualizada" }
```

**Errores**

- `401` – sin token.
- `404` – usuario no encontrado.
- `400` – `old_password` faltante o incorrecta.

---

## 2. /catalogs – Catálogos para selects

### 2.1 GET /catalogs

**Descripción**  
Devuelve los catálogos usados en el formulario OI y login.

**Response 200**

```json
{
  "q3": [1.6, 2.5, 4.0, 6.3],
  "alcance": [100, 125, 160, 200, 400, 500],
  "pma": [10, 16],
  "bancos": [
    { "id": 3, "name": "Banco 3" },
    { "id": 4, "name": "Banco 4" },
    { "id": 5, "name": "Banco 5" },
    { "id": 6, "name": "Banco 6" }
  ]
}
```

**Notas**

- `q3` y `alcance` deben estar alineados con las listas de la plantilla Excel (rango `AZ2:BC2` y `AZ1:BE1`).
- `pma` solo se usa en el formulario; en el Excel se transforma a Presión(bar).

---

## 3. /oi – Gestión de OI

### Esquemas principales

- `OICreate` / `OIUpdate` / `OIRead`
- `OIListResponse`
- `NumerationType` (`"correlativo"` / `"no correlativo"`)

---

### 3.1 POST /oi

**Descripción**  
Crea una nueva OI para el usuario de la sesión.

**Headers**

- `Authorization: Bearer <token>`

**Request body – OICreate (ejemplo)**

```json
{
  "code": "OI-0001-2025",
  "q3": 4.0,
  "alcance": 160,
  "pma": 16,
  "numeration_type": "correlativo"
}
```

**Reglas**

- `code` debe cumplir `OI-####-YYYY`.
- `pma` solo puede ser `10` o `16`.
- `numeration_type` se normaliza:
  - Acepta `"correlativo"`, `"no correlativo"` y variantes internas (`no_correlativo`).
- `banco_id` y `tech_number` **no se toman** del payload: se extraen de la sesión.
- `presion_bar` se calcula automáticamente a partir del PMA.

**Response 200 – OIRead (ejemplo)**

```json
{
  "id": 1,
  "code": "OI-0001-2025",
  "q3": 4.0,
  "alcance": 160,
  "pma": 16,
  "presion_bar": 25.6,
  "banco_id": 3,
  "tech_number": 101,
  "numeration_type": "correlativo",
  "created_at": "2025-11-10T12:00:00",
  "updated_at": "2025-11-10T12:00:00",
  "creator_name": "Nombre Apellido"
}
```

**Errores**

- `400` – sesión inválida (faltan `techNumber`/`bancoId`).
- `401` – sin token.
- `422` – código OI inválido.
- `422` – PMA inválido (no 10/16).
- `422` – tipo de numeración inválido.

---

### 3.2 PUT /oi/{oi_id}

**Descripción**  
Actualiza Q3, Alcance, PMA y tipo de numeración de una OI.

**Headers**

- `Authorization: Bearer <token>`

**Request body – OIUpdate (ejemplo)**

```json
{
  "q3": 4.0,
  "alcance": 160,
  "pma": 10,
  "numeration_type": "no correlativo",
  "updated_at": "2025-11-10T12:00:00"
}
```

**Reglas**

- El `code` de la OI **no** se modifica.
- Se aplica control de concurrencia optimista:
  - Si `updated_at` en payload no coincide con el valor en BD, se devuelve `409`.
- Se recalcula `presion_bar` en función del PMA.

**Errores**

- `401` – sin token.
- `403` – usuario sin permisos sobre la OI.
- `404` – OI no encontrada.
- `409` – “La OI fue modificada por otro usuario…”.
- `422` – PMA o tipo de numeración inválidos.

---

### 3.3 GET /oi/{oi_id}

**Descripción**  
Devuelve los datos de una OI.

**Headers**

- `Authorization: Bearer <token>`

**Response 200 – OIRead**

Mismo formato que en `POST /oi`.

**Errores**

- `401` – sin token.
- `403` – sin permisos (tech/banco diferentes).
- `404` – OI no encontrada.

---

### 3.4 GET /oi

**Descripción**  
Listado de OI con filtros y paginación.

**Query params**

- `q` (opcional): texto de búsqueda parcial por `code` (case-insensitive).
- `date_from` (opcional): fecha inicio (YYYY-MM-DD, inclusive).
- `date_to` (opcional): fecha fin (YYYY-MM-DD, inclusive).
- `limit` (opcional): tamaño de página (1–100, default 20).
- `offset` (opcional): desplazamiento.

**Reglas de visibilidad**

- `admin` → ve todas las OI.
- resto → solo OI con mismo `tech_number` y `banco_id` que la sesión.

**Response 200 – OIListResponse**

```json
{
  "items": [
    { "id": 1, "code": "OI-0001-2025", "...": "..." },
    { "id": 2, "code": "OI-0002-2025", "...": "..." }
  ],
  "total": 18,
  "limit": 20,
  "offset": 0
}
```

**Errores**

- `400` – formato de fecha inválido.
- `401` – sin token.

---

### 3.5 DELETE /oi/{oi_id}  (solo admin)

**Descripción**  
Elimina una OI y todas sus bancadas asociadas.

**Reglas**

- Solo el usuario `"admin"` puede eliminar OI.
- Primero borra las bancadas (`Bancada`) y luego la OI.

**Response 200**

```json
{ "ok": true }
```

**Errores**

- `401` – sin token.
- `403` – no es `"admin"`.
- `404` – OI no encontrada.

---

## 4. /oi/{id}/bancadas – Bancadas de una OI

### Esquemas principales

- `BancadaCreate`, `BancadaUpdate`, `BancadaRead`
- `OiWithBancadasRead`

---

### 4.1 POST /oi/{oi_id}/bancadas

**Descripción**  
Crea una nueva bancada asociada a una OI.

**Headers**

- `Authorization: Bearer <token>`

**Request body – BancadaCreate (ejemplo)**

```json
{
  "medidor": "PA25517601",
  "estado": 0,
  "rows": 15,
  "rows_data": [
    {
      "medidor": "PA25517601",
      "estado": 0,
      "q3": { "c1": 20.0, "c2": 1.5, "c3": 1.3, "c4": 0, "c5": 10, "c6": 120, "c7": "00:30", "c7_seconds": 30 },
      "q2": { "...": "..." },
      "q1": { "...": "..." }
    }
  ]
}
```

**Reglas**

- Se autocalcula el `item` de la bancada como `max(item)+1` dentro de la OI.
- Si `rows_data` está presente, se almacena como JSON y se usa para generar filas de Excel.
- `rows` define el número de filas solo si `rows_data` es `null`/vacío.

**Response 200 – BancadaRead**

Incluye `id`, `oi_id`, `item`, `medidor`, `estado`, `rows`, `rows_data`, `created_at`, `updated_at`.

**Errores**

- `401` – sin token.
- `403` – sin permisos sobre la OI.
- `404` – OI no encontrada.

---

### 4.2 GET /oi/{oi_id}/with-bancadas

**Descripción**  
Devuelve la OI y todas sus bancadas, ordenadas por `item`.

**Response 200 – OiWithBancadasRead**

```json
{
  "id": 1,
  "code": "OI-0001-2025",
  "q3": 4.0,
  "alcance": 160,
  "pma": 16,
  "presion_bar": 25.6,
  "banco_id": 3,
  "tech_number": 101,
  "numeration_type": "correlativo",
  "created_at": "2025-11-10T12:00:00",
  "updated_at": "2025-11-10T12:30:00",
  "creator_name": "Nombre Apellido",
  "bancadas": [
    { "id": 10, "oi_id": 1, "item": 1, "...": "..." },
    { "id": 11, "oi_id": 1, "item": 2, "...": "..." }
  ]
}
```

- `/oi/{oi_id}/full` es un alias de este endpoint y devuelve exactamente el mismo payload.

**Errores**

- `401` – sin token.
- `403` – sin permisos sobre la OI.
- `404` – OI no encontrada.

---

### 4.3 GET /oi/{oi_id}/bancadas-list

**Descripción**  
Devuelve solo la lista de bancadas de una OI (sin los datos de la OI).

**Response 200 – List<BancadaRead>**

```json
[
  { "id": 10, "oi_id": 1, "item": 1, "...": "..." },
  { "id": 11, "oi_id": 1, "item": 2, "...": "..." }
]
```

---

### 4.4 PUT /oi/bancadas/{bancada_id}

**Descripción**  
Actualiza una bancada existente (medidor, estado, rows y grid completa).

**Headers**

- `Authorization: Bearer <token>`

**Request body – BancadaUpdate (ejemplo)**

```json
{
  "medidor": "PA25517601",
  "estado": 1,
  "rows": 20,
  "rows_data": [ /* grid actualizada */ ],
  "updated_at": "2025-11-10T12:30:00"
}
```

**Reglas**

- Control de concurrencia optimista:
  - Si `updated_at` del payload no coincide con `updated_at` persistido, devuelve `409`.
- Reemplaza completamente `rows_data` por la versión enviada.

**Errores**

- `401` – sin token.
- `403` – sin permisos.
- `404` – bancada u OI no encontrada.
- `409` – “La bancada fue modificada por otro usuario…”.

---

### 4.5 DELETE /oi/bancadas/{bancada_id}

**Descripción**  
Elimina una bancada asociada a una OI.

**Response 200**

```json
{ "ok": true }
```

**Errores**

- `401` – sin token.
- `403` – sin permisos sobre la OI.
- `404` – bancada u OI no encontrada.

---

## 5. /oi/{id}/excel – Generación de Excel

### 5.1 POST /oi/{oi_id}/excel

**Descripción**  
Genera y descarga el archivo Excel basado en la plantilla VI (`ERROR FINAL`), consolidando todas las bancadas de la OI.

**Headers**

- `Authorization: Bearer <token>`

**Request body – ExcelRequest**

```json
{
  "password": "medileser"
}
```

- `password` es opcional. Si se envía:
  - No cambia la protección interna de la hoja.
  - Solo agrega una marca de libro “reservado / solo lectura” con ese texto como contraseña de reserva.

**Response 200**

- Tipo: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- Encabezado `Content-Disposition` con nombre de archivo:

```text
OI-0001-2025-NOMBRE APELLIDO-2025-11-10.xlsx
```

Patrón:

- Prefijo: código de OI (`code`).
- Nombre/Apellido del técnico en mayúsculas, sin acentos ni símbolos extra.
- Fecha: última modificación de la OI (`updated_at` o `created_at`).

**Errores**

- `401` – sin token.
- `403` – sin permisos sobre la OI.
- `404` – OI no encontrada.
- `422` – error de datos / plantillas, típicamente:
  - `"Q3 no coincide con la lista de la plantilla"`
  - `"Alcance no coincide con la lista de la plantilla"`
- Otros `422` posibles por inconsistencias de datos que disparen errores durante la generación.

---

## 6. Notas sobre seguridad y hashing de contraseñas

- Las contraseñas se almacenan con un hash **sha256** simple.
- La verificación se realiza comparando el hash de la contraseña ingresada con el hash almacenado.
- En producción se recomienda reemplazar por un algoritmo robusto como **bcrypt** o **argon2**.

---
