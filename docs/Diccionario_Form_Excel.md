# Diccionario Formulario Web ↔ Excel (Formato VI)

**Plantilla:** `backend/app/data/PLANTILLA_VI.xlsx`  
**Hoja:** `ERROR FINAL`  
**Fila de cabecera de datos:** 8  
**Primera fila de datos:** 9 (`DATA_START_ROW = 9`) :contentReference[oaicite:0]{index=0}  

Este diccionario describe cómo se mapean los campos del formulario web y del API a las celdas/columnas del Excel de Formato VI, incluyendo:

- Celdas fijas `E4` (Q3) y `O4` (Alcance Q3/Q1).
- Columnas de datos por fila (A..BL).
- Uso del campo `rows` por bancada.
- Columnas calculadas AU..BL y bordes A..BL por bancada.
- Reglas PMA → Presión(bar) y listas validadas.

---

## 1. Datos de OI (cabecera del formulario)

Los datos de la OI se modelan en los esquemas `OICreate`, `OIUpdate` y `OIRead` y en el modelo `OI`.   
Al generar el Excel, se carga siempre la hoja `ERROR FINAL` y se escriben las celdas fijas `E4` y `O4` usando listas validadas. :contentReference[oaicite:2]{index=2}  

| Campo UI                                    | Clave JSON / Modelo                             | Editable UI | Requerido | Tipo           | Transformación / Regla                                                                                                                                                       | Excel (hoja/celda/columna)                                             | Observaciones |
|--------------------------------------------|-------------------------------------------------|------------|-----------|----------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------|--------------|
| N° OI                                      | `code` (`OICreate.code`)                        | Sí         | Sí        | string (patrón) | Debe cumplir regex `^OI-\d{4}-\d{4}$`. No se usa dentro del Excel; sólo para nombre de archivo `OI-####-YYYY.xlsx`. :contentReference[oaicite:3]{index=3}                                         | No aplica (se usa para nombre de archivo)                              | Validación en backend; se rechaza si no cumple el patrón. |
| Q3 (m³/h)                                  | `q3` (`OICreate.q3`)                            | Sí         | Sí        | number (select) | El valor elegido debe existir en la lista de Excel `AZ2:BC2`. Se normaliza coma/punto y se busca coincidencia exacta con `find_exact_in_range`.  | `E4` (celda fija, lista validada).                                     | Campo de selección en el front; en Excel, `E4` queda desbloqueada. |
| Alcance Q3/Q1                              | `alcance` (`OICreate.alcance`)                  | Sí         | Sí        | number (select) | Igual que Q3 pero contra la lista `AZ1:BE1`. :contentReference[oaicite:5]{index=5}                                                                                                            | `O4` (celda fija, lista validada).                                     | Campo de selección en el front; `O4` queda desbloqueada. |
| PMA                                        | `pma` (`OICreate.pma`)                          | Sí         | Sí        | number (select) | Valores permitidos: `10` o `16`. En el Excel no se escribe PMA directamente: se transforma a **Presión(bar)** con la tabla: 10→16.0, 16→25.6.       | No aplica directo; se refleja como Presión(bar) en columna **H**.      | Campo de selección; en el Excel sólo se ve el resultado en H. |
| Banco de ensayo                            | `banco_id` (`OICreate.banco_id`)                | Sí         | Sí        | number (select) | Se replica en todas las filas de la OI.                                                                                                                                       | Columna **D**, filas de datos (D9..Dn).                                | Valor bloqueado en Excel (no editable por usuario). |
| N° de técnico                              | `tech_number` (`OICreate.tech_number`)          | No (lo trae el login) | Sí | number         | Se obtiene del usuario autenticado (modelo `User.tech_number`). :contentReference[oaicite:7]{index=7}                                                                                         | Columna **E**, filas de datos (E9..En).                                | No se edita en UI de OI; viene del usuario logueado. |
| Tipo de numeración (#Medidor correlativo)  | `numeration_type` (`OICreate.numeration_type`)  | Sí         | No (tiene default) | enum          | `"correlativo"` (default) o `"no correlativo"`. Controla cómo se generan/replican los valores de `# Medidor` cuando el usuario usa numeración automática.  | No tiene columna propia; afecta la lógica de generación de `G` (Medidor). | Configuración de comportamiento del Grid, no un dato de Excel. |
| Fecha ensayo presión estática              | (sin campo UI)                                  | No         | No        | date           | Se llena automáticamente con la fecha actual en cada fila (`datetime.now().date()`).                                                           | Columna **B**, filas de datos (B9..Bn).                                | Bloqueado en UI y Excel; no editable. |
| Fecha ensayo errores de indicación         | (sin campo UI)                                  | No         | No        | date           | Igual que la anterior; usa la misma fecha actual. :contentReference[oaicite:10]{index=10}                                                                                                        | Columna **C**, filas de datos (C9..Cn).                                | Bloqueado en UI y Excel; no editable. |
| Presión (bar)                              | (derivado de `pma`)                             | No         | Sí        | number (calc)   | Primera fila de cada bancada: `pma_to_pressure(pma)`. Filas siguientes: fórmula `=H{fila_anterior}`.                                            | Columna **H**, filas de datos.                                         | Columna no editable; sólo se modifica cambiando PMA en la OI. |

---

## 2. Datos de Bancada (cabecera de bancada)

Las bancadas se almacenan en la tabla `Bancada` y los esquemas `BancadaBase`, `BancadaCreate`, `BancadaRead`.   
Cada bancada agrupa N filas consecutivas en el Excel; al final de ese bloque se aplica un borde grueso de A..BL. :contentReference[oaicite:13]{index=13}  

| Campo UI                               | Clave JSON / Modelo                      | Editable UI | Requerido | Tipo      | Transformación / Regla                                                                                             | Excel (hoja/celda/columna)                         | Observaciones |
|---------------------------------------|------------------------------------------|------------|-----------|-----------|--------------------------------------------------------------------------------------------------------------------|----------------------------------------------------|--------------|
| N° de bancada (Item de bancada)       | `item` (`Bancada.item`)                  | No (autonum) | N/A     | number   | Se asigna secuencialmente en backend (1..N) al crear la bancada.                                                  | No tiene columna propia; se usa para agrupar filas | Visible en el listado de bancadas, no en el Excel. |
| Medidor base de bancada               | `medidor` (`Bancada.medidor`)            | Sí         | No        | string   | Valor por defecto para `# Medidor` de las filas que no tengan `rows_data[k].medidor`.                              | Columna **G**, filas de la bancada (prioridad: fila→bancada).  | Puede dejarse vacío si cada fila tiene su propio medidor. |
| Estado de bancada (legacy / default)  | `estado` (`Bancada.estado`)              | Sí         | No        | number   | Rango 0–5 (validado con `ge=0, le=5`). Si no existe `rows_data`, se usa como valor de Estado para toda la bancada; si hay `rows_data`, es el valor por defecto de filas sin `estado`.  | Columna **Estado** (I) en Excel, según el modo (ver sección 3). | Leyenda de Estado 0–5 se gestiona en la UI/plantilla. |
| N° de filas de la bancada             | `rows` (`Bancada.rows`)                  | Sí         | No        | number   | Si `rows_data` está vacío, define cuántas filas se generan en Excel (mínimo 1, default 15). Si `rows_data` tiene elementos, prevalece el largo de esa lista.  | Controla cuántas filas de Excel ocupa la bancada. | No se refleja en una columna; es parte de la lógica de generación. |
| Grid de filas (mini-planilla)         | `rows_data` (`Bancada.rows_data`)        | Sí         | No        | array<BancadaRow> | Lista de objetos `BancadaRow` que representan cada fila del modal/Grid. Si está presente, se ignora `rows` para el conteo y se usa una fila por elemento.  | Ver sección 3.                                                       | Estructura principal para el Grid de Q3/Q2/Q1. |
| Auditoría de bancada                  | `created_at`, `updated_at`               | No         | No        | datetime | Se gestionan en backend.                                                                                           | No aplica.                                          | No se muestran en UI ni Excel. |

---

## 3. Datos por fila de bancada (Grid Q3/Q2/Q1)

Cada elemento de `rows_data` es un `BancadaRow`. :contentReference[oaicite:18]{index=18}  
En Excel, cada `BancadaRow` genera una fila de datos (A..BL), copiando fórmulas y estilos desde la fila 9 y aplicando bordes al final de la bancada. :contentReference[oaicite:19]{index=19}  

### 3.1 Campos generales por fila

| Campo UI                       | Clave JSON / Modelo                        | Editable UI | Requerido | Tipo    | Transformación / Regla                                                                                                            | Excel (hoja/celda/columna)                                      | Observaciones |
|--------------------------------|--------------------------------------------|------------|-----------|---------|-----------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------|--------------|
| # Medidor (fila)              | `rows_data[k].medidor` (`BancadaRow`)      | Sí         | No        | string | Prioridad para columna G: 1) valor de fila; 2) `Bancada.medidor`; 3) vacío.                                                           | Columna **G** (`# Medidor`).                                     | Editable en Grid; en Excel se copia como texto/valor. |
| Estado (fila)                 | `rows_data[k].estado` (`BancadaRow`)       | Sí         | No        | number | 0–5. Si está presente, se escribe directamente en la columna Estado. Si es `None`, se usa el estado de la bancada (k=0) o la fórmula `=I{fila_anterior}` (k>0).  | Columna **Estado** (I).                                          | Columna editable en Grid; en Excel queda el valor numérico o fórmula. |
| Conformidad observada (texto) | `rows_data[k].conformidad`                 | Sí         | No        | string | Campo libre de observación por fila; actualmente se almacena en JSON pero no se mapea a una columna específica en Excel.  | (No aplica de momento)                                           | Reservado para futuras ampliaciones o notas. |

> **Fechas (B y C), Banco (D) y Técnico (E)** no tienen campos en el Grid: se rellenan automáticamente con la fecha actual, el banco y el técnico de la OI en cada fila.   

---

### 3.2 Bloques Q3, Q2 y Q1 por fila

Cada `BancadaRow` tiene tres bloques: `q3`, `q2`, `q1`, cada uno es un `dict` con las claves `c1..c7` y `c7_seconds`.   

Las columnas por bloque son:

- **Q3**: columnas J..P (Temperatura, P.Entrada, P.Salida, L.I., L.F., Vol.P, Tiempo).  
- **Q2**: columnas V..AB (mismos conceptos que Q3).  
- **Q1**: columnas AH..AN (mismos conceptos que Q3).  
- Adicionalmente, por bloque se crean dos columnas ocultas:  
  - `start_col + 8` → segundos (`c7_seconds`).  
  - `start_col + 9` → horas (`=+<col_segundos>/3600`).   

Regla de replicado vertical:

- Columnas compartidas (`c1`, `c2`, `c3`, `c6`, `c7`) replican el valor de la fila base mediante fórmula (ej.: `=J9`) en las filas siguientes.  
- Columnas `c4` (L.I.) y `c5` (L.F.) pueden variar por fila y se escriben como valores.  
- En Q1, `L.I.` (columna AK) es siempre independiente (no replica de la fila anterior). :contentReference[oaicite:26]{index=26}  

#### 3.2.1 Q3 (J..P)

| Campo UI (columna Excel)   | Clave JSON (Q3)              | Editable UI | Requerido | Tipo     | Transformación / Regla                                                                                             | Excel (columna) | Observaciones |
|----------------------------|------------------------------|------------|-----------|----------|--------------------------------------------------------------------------------------------------------------------|-----------------|--------------|
| Q3 – Temperatura           | `rows_data[k].q3.c1`         | Sí         | Sí*       | number   | Valor numérico; en filas posteriores se replica con fórmula si no hay dato específico.                             | **J**           | Columna compartida (replicada). |
| Q3 – Presión Entrada       | `rows_data[k].q3.c2`         | Sí         | Sí*       | number   | Igual que anterior.                                                                                                | **K**           | Compartida. |
| Q3 – Presión Salida        | `rows_data[k].q3.c3`         | Sí         | Sí*       | number   | Igual que anterior.                                                                                                | **L**           | Compartida. |
| Q3 – L.I.                  | `rows_data[k].q3.c4`         | Sí         | Sí*       | number   | Puede variar por fila; se escribe valor numérico si es posible.                                                    | **M**           | Independiente por fila. |
| Q3 – L.F.                  | `rows_data[k].q3.c5`         | Sí         | Sí*       | number   | Igual que L.I.                                                                                                     | **N**           | Independiente por fila. |
| Q3 – Vol. P                | `rows_data[k].q3.c6`         | Sí         | Sí*       | number   | Compartida; se replica mediante fórmula en filas siguientes.                                                       | **O**           | Compartida. |
| Q3 – Tiempo (texto)        | `rows_data[k].q3.c7`         | Sí         | Sí*       | string   | Texto de tiempo (formato libre).                                                                                   | **P**           | Se acompaña de segundos/horas ocultos. |
| Q3 – Tiempo (segundos)     | `rows_data[k].q3.c7_seconds` | Sí         | No        | number   | Se escribe en `start_col+8` y se transforma a horas en `start_col+9` con fórmula `/3600`.                          | Columna oculta  | No visible en UI de Excel; se usa en cálculos. |

\*Requerido según reglas de negocio de OI; el backend acepta `None` pero la operativa normal exige completar los campos para la primera fila de cada bancada.

#### 3.2.2 Q2 (V..AB)

Mismo patrón que Q3, pero con `rows_data[k].q2.*` y columnas:

- Temperatura → **V**
- Presión Entrada → **W**
- Presión Salida → **X**
- L.I. → **Y**
- L.F. → **Z**
- Vol. P → **AA**
- Tiempo (texto) → **AB**
- Segundos ocultos → **(V+8) = AD**
- Horas ocultas → **(V+9) = AE**

#### 3.2.3 Q1 (AH..AN)

Mismo patrón que Q3, pero con `rows_data[k].q1.*` y columnas:

- Temperatura → **AH**
- Presión Entrada → **AI**
- Presión Salida → **AJ**
- L.I. → **AK** (siempre independiente por fila).   
- L.F. → **AL**
- Vol. P → **AM**
- Tiempo (texto) → **AN**
- Segundos ocultos → **(AH+8) = AP**
- Horas ocultas → **(AH+9) = AQ**

---

## 4. Columnas calculadas y celdas sin campo UI

### 4.1 Columnas AR y AS (Q1 y E%)

En la plantilla:

- **AR**: Q1 (caudal nominal) – cabecera `Q1`.  
- **AS**: error porcentual `E %` para Q1. :contentReference[oaicite:28]{index=28}  

Ambas columnas se mantienen como fórmulas en Excel (semilla en fila 9, replicada hacia abajo junto con AU..BL); no tienen campo JSON ni UI específico. Se alimentan de los valores de Q3/Q2/Q1 y de rangos de referencia (`J6`, `V6`, `AH6`). :contentReference[oaicite:29]{index=29}  

### 4.2 Columnas AU..BL (lógica de conformidad)

Las columnas AU..BL contienen fórmulas que determinan si el ensayo es correcto, aceptable, conforme/no conforme, y comparan signos de errores. Se inicializan en la fila 9 y se copian a todas las filas de datos con `_copy_formulas(ws, DATA_START_ROW, r, FORMULA_START_COL, FORMULA_END_COL)`.   

Resumen de cada columna (fila base 9):

- **AU**: `=B9=C9` → Verifica que las dos fechas de ensayo coincidan.  
- **AV**: `=N9<Y9` → Compara L.F. de Q3 contra L.I. de Q2.  
- **AW**: `=Z9<=AK9` → Compara L.F. de Q2 contra L.I. de Q1.  
- **AX**: Evalúa si hay `Qcorrecto` según Estado y resultados AY..BA.  
- **AY**: Valida el caudal Q1 (AR9) contra el valor de referencia `$AH$6`.  
- **AZ**: Valida Q2 (AF9) contra `$V$6`.  
- **BA**: Valida Q3 (T9) contra `$J$6`.  
- **BB / BC**: Evalúan conformidad global en función de los errores de Q3, Q2, Q1.  
- **BD / BE / BF**: Signo del error de cada Q (SIGNO de U9, AG9, AS9).  
- **BG**: Concatenación de signos.  
- **BH / BI**: Flags SI/SD según combinación de signos.  
- **BJ**: Resultado OR de BH/BI.  
- **BK**: Determina si los signos son iguales o diferentes.  
- **BL**: Conclusión final de conformidad/no conformidad por fila.

Estas columnas:

- **No tienen campo UI**.
- **No se modifican via API**; se calculan sólo dentro del Excel a partir de los datos de Q3/Q2/Q1 y E%.  
- Deben considerarse **columnas bloqueadas** en la interfaz (no editables).

---

## 5. Bordes por bancada

Al finalizar cada bancada, el backend aplica un borde inferior grueso desde la columna **A** hasta **BL** en la última fila de la bancada (`_apply_thick_bottom_border(ws, last_row, "A", "BL")`). :contentReference[oaicite:31]{index=31}  

- Esto separa visualmente las bancadas en la hoja `ERROR FINAL`.
- El borde **no depende de la UI**; se calcula con la suma de filas de cada `Bancada` (según `rows` o longitud de `rows_data`).

---

## 6. Resumen de columnas bloqueadas / derivadas

**Columnas no editables por el usuario (Excel):**

- A (Item) – autonumerada por backend.
- B, C (Fechas de ensayo) – siempre fecha actual.
- D (Banco), E (Técnico) – vienen del login/OI.
- H (Presión bar) – derivada de PMA.
- Columna `Estado` cuando se deriva por fórmula (filas > 1 cuando no hay `rows_data.estado`).
- Columnas ocultas de segundos/horas por bloque.
- AR, AS (Q1, E% Q1) – fórmulas.
- AU..BL – fórmulas de validación y conformidad.

**Columnas editables (desde el Grid / UI):**

- G (`# Medidor` por fila).
- I (`Estado` por fila, cuando se ingresa manualmente).
- J..P (Q3), V..AB (Q2), AH..AN (Q1) – valores de medición (L.I., L.F., Vol, Tiempo, etc.), según lo visible en el modal Bancada.

---

Con este diccionario se cubren:

- Celdas fijas **E4/O4** (listas Q3 y Alcance).
- Uso de `rows` y `rows_data` para el número de filas por bancada.
- Columnas de fórmulas **AU..BL** y su relación con Q3/Q2/Q1.
- Aplicación del borde A..BL por bancada.

Este documento permite validar la implementación actual del backend/frontend contra la plantilla de Excel y sirve como referencia para futuras modificaciones del Formato VI.
