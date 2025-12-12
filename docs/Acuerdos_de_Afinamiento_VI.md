# Acuerdos de Afinamiento - Formato VI

Este documento resume los acuerdos técnicos de afinamiento para:

- Uso de la hoja fija **"ERROR FINAL"** em la plantilla VI.
- Política de protección de libro y hoja (contraseñas internas y celdas bloqueadas).
- Manejo de errores **HTTP 422** cuando los valores no coinciden con las listas del Excel (Q3 y Alcance).

## 1. Plantilla y hoja fija "ERROR FINAL"

### 1.1 Ubicación y carga de la plantilla

- La plantilla se configura vía `settings.template_abs_path` (variable de entorno documentada en Settings/.env). :contentReference[oaicite:2]{index=2}  
- El servicio `generate_excel(oi, bancadas, password)`carga siempre el libro a partir de esa ruta.
- Para evitar avisos de "reparaciones" en Excel, se abre con `keep_links=True, respetando vínculos externos existentes en la plantilla.

### 1.2 Hoja lógica de trabajo

- El nombre lógico de la hoja para el Formato VI es **`ERROR FINAL"`**.
- El backend utiliza esta hoja como referencia principal:

python
SHEET_NAME = "ERROR FINAL"
ws = _get_sheet(wb, SHEET_NAME)

- Acuerdo funcional: la plantilla oficial de Formato VI debe contener una hoja llamada exactamente "ERROR FINAL" con la estructura espeada
(cabeceras en fila 8, datos desde fila 9, fórmulas AU..BL, etc.).
- Si por configuración o error la hoja no existe, el código tiene un fallback hacia la hoja activa, pero esto se considera fuera de contrato y no se garantiza el funcionamiento correcto.

### 1.2 Fila de cabecera y filas de datos

- Fila de cabecera lógica: 8 (HEADER_ROW = 8).
- Primera fila de datos: 9 (DATA_START_ROW = 9).
- Las cabeceras se usan para encontrar dinámicamente columnas como "Estado" y "# Medidor".
- La columna de fórmulas automáticas (control de errores y conformidad) va desde Q hasta BL (FORMULA_START_COL = "Q", FORMULA_END_COL = "BL").

## 2. Política de protección (estructura, hoja y celdas)

La protección del Excel generado se basa en dos niveles de contraseña y en una configuración de celdas bloqueadas/desbloqueadas.

### 2.1 Contraseña interna (estructura y hoja)

- Se obtiene de settings.cells_protection_password (configurable en .env).
- Esta contraseña no se pide al usuario en el frontend.
- Uso:

    1. Estructura de libro
        wb.security = WorkbookProtection(lockStructure=True, lockRevision=True)
        wb.security.set_workbook_password(internal_pwd)
        wb.security.set_revisions_password(internal_pwd)

    2. Hoja "ERROR FINAL"
        ws.protection.enable()
        ws.protection.set_password(internal_pwd)
        - Protege la hoja de cambios en celdas bloqueadas (fórmulas, cabeceras críticas, etc.).

- Acuerdo: la contraseña interna se mantiene reservada al equipo de TI/OI; los técnicos solo trabajan sobre celdas desbloqueadas.

### 2.2 Celdas desbloqueadas (editables)

Después de escribir todos los datos y fórmulas, el servicio:

1. Crea un objeto de protección desbloqueada:
    unlocked_protection = CellProtection(locked=False)


2. Desbloquea explícitamente:

  - Celdas de cabecera seleccionable:
    - E4 → Q3 (lista AZ2:BC2).
    - O4 → Alcance (lista AZ1:BE1).

  - Celdas de la mini-planilla por fila:
    editable_col_ranges = [1, 7] + list(range(9, 17)) + list(range(22, 29)) + list(range(34, 41))

    Esto significa:
    - Columna A: Item (fila) – editable solo si el usuario decide ajustar manualmente, aunque por defecto viene autonumerada.
    - Columna G: # Medidor.
    - J..P: bloque Q3 (Temperatura, presiones, L.I., L.F., Vol, Tiempo).
    - V..AB: bloque Q2.
    - AH..AN: bloque Q1.

 - Para cada fila de datos r_idx entre DATA_START_ROW y current_row - 1 se asigna locked=False en esas columnas.

3. El resto de celdas queda bloqueado, asegurando:
    - Fechas (B, C), banco (D), técnico (E), presión bar (H), columnas ocultas de segundos/horas, columnas de resultados AR, AS y el bloque AU..BL no son modificables directamente por el usuario.
    - Si en algún momento se actualiza el diseño de la plantilla, estos rangos se actualizan en el código, manteniendo la política de que solo los datos “de campo” son editables.

### 2.3 Contraseña ingresada por el usuario (solo lectura recomendada)

En el endpoint POST /oi/{id}/excel, el cliente envía un objeto ExcelRequest con el campo:
    
    class ExcelRequest(BaseModel):
        password: str

- Esta password NO modifica la protección interna de estructura/hoja.
- Se usa únicamente para generar un mensaje de “libro reservado/solo lectura” en el nivel de workbook.xml:

    hashed_reservation = hash_password(password)
    workbook_bytes = _inject_reservation_notice(workbook_bytes, hashed_reservation, reserved_by)

- Efecto práctico:

    - Al abrir el archivo, Excel mostrará la advertencia de “libro reservado / abrir como solo lectura”, usando como userName algo como Banco01, Banco02, etc.

    - El usuario puede optar por abrir como lectura o continuar con edición (respetando las protecciones de hoja y libro definidas por la contraseña interna).

Resumen de política de contraseñas

 1. Contraseña interna (cells_protection_password)
    - Protege estructura del libro y hoja ERROR FINAL.
    - No se expone al usuario final.

2. Contraseña de exportación (campo password en frontend)
    - Solo afecta el mensaje de reserva / solo lectura.
    - Opcional; si viene vacía, el archivo se genera igual, solo sin el mensaje de “reservado”.


## 3. Manejo de errores 422 (listas y validaciones)

### 3.1 Normalización y listas (Q3 y Alcance)

Regla central:

- Q3 y Alcance se seleccionan en el formulario desde catálogos; en el Excel deben coincidir exactamente con las listas de la plantilla:

    - Q3 → rango AZ2:BC2 (lista para E4).
    - Alcance Q3/Q1 → rango AZ1:BE1 (lista para O4).

- Antes de buscar, se aplica normalización (coma/punto, trims, etc.) para tolerar diferencias de formato:

    - normalize_for_excel_list convierte 4, 4.0 o 4.00 en "4,0" si corresponde.
    - find_exact_in_range primero intenta coincidencia de texto, luego coincidencia numérica tolerando 4 vs 4,0.

  Si aún así no se encuentra coincidencia:

    - Para Q3:
        if q3_value is None:
            raise ValueError("Q3 no coincide con la lista de la plantilla")

    - Para Alcance:

    if alcance_value is None:
        raise ValueError("Alcance no coincide con la lista de la plantilla")

### 3.2 Cómo se convierte en HTTP 422

En el endpoint:

    @router.post("/{oi_id}/excel")
    def export_excel(...):
        ...
        try:
            data, _ = build_excel_file(oi, bancadas, password=req.password)
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e))


    - Cualquier ValueError lanzado por generate_excel(...) se traduce en un HTTP 422 con detail igual al mensaje de Python.
    - Para las listas, los mensajes son explícitos:

        - "Q3 no coincide con la lista de la plantilla"
        - "Alcance no coincide con la lista de la plantilla"

Acuerdo de comportamiento:

1. Si los catálogos de frontend y los rangos AZ1:BE1 / AZ2:BC2 están alineados, este error no debería ocurrir en operación normal.

2. Si ocurre un 422 al exportar Excel:

    - El frontend debe mostrar el mensaje detail al usuario (toast, modal o equivalente).
    - El técnico deberá:

        - Verificar que el Q3 / Alcance seleccionado corresponde a un valor vigente en la plantilla oficial.

        - En caso de desalineación, escalar al administrador para actualizar catálogos o plantilla.

### 3.3 Otros casos de 422 (validaciones de OI)

Además del caso de listas, existen otras validaciones que devuelven 422 en los endpoints de OI:

- Código OI inválido (create_oi):
    - Patrón obligatorio: ^OI-\d{4}-\d{4}$.
    - Si no cumple: 422 "Código OI inválido (formato OI-####-YYYY)."

- PMA inválido (create_oi / update_oi):
    - Tabla PMA→Presión(bar): {10→16.0, 16→25.6}.
    - Si el PMA no es 10 o 16: 422 "PMA inválido (solo se aceptan 10 o 16)."

- Tipo de numeración inválido:
    - Valores aceptados: "correlativo" o "no correlativo" (se aceptan variantes internas con _, pero se normalizan).
    - Si el valor no es reconocido: 422 "Tipo de numeración inválido; use 'correlativo' o 'no correlativo'."

Acuerdo: todos los 422 indican errores de datos de entrada, no errores de servidor. El frontend debe tratarlos como mensajes de validación, no como “fallas del sistema”.

## 4. Resumen del flujo de generación de Excel

1. El usuario solicita POST /oi/{id}/excel enviando:
    - password (opcional, para la advertencia de reserva).

2. El backend:
    1. Valida que la OI exista y que el usuario tenga permisos.
    2. Carga todas las bancadas, ordenadas por item.
    3. Llama a generate_excel(oi, bancadas, password):
        - Carga plantilla a partir de settings.template_abs_path.
        - Obtiene/crea hoja "ERROR FINAL".
        - Escribe E4 y O4 (Q3, Alcance) usando las listas internas.
        - Vuelca filas de bancadas (rows / rows_data).
        - Copia fórmulas AU..BL y aplica bordes A..BL por bancada.
        - Desbloquea celdas editables.
        - Aplica protección de libro y hoja con contraseña interna.
        - Inyecta fileSharing si se ha enviado password de usuario.

    4. Devuelve un archivo .xlsx con nombre:
        - OI-####-YYYY-NOMBRE APELLIDO-YYYY-MM-DD.xlsx
        - Usando updated_at o created_at de la OI para la fecha y el nombre del técnico asociado.

3. Si en cualquier punto de generación se detectan datos incompatibles con la plantilla (Q3/Alcance, PMA, tipo de numeración, etc.), se retorna HTTP 422 con un mensaje descriptivo que el frontend debe mostrar al usuario.