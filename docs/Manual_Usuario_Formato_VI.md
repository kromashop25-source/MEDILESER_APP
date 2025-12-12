# Manual de Usuario – Interfaz Formato VI

Sistema de registro y generación del **Formato VI** para el Organismo de Inspección (OI).

---

## 1. Acceso al sistema

### 1.1 Requisitos

- Navegador web actualizado (Chrome, Edge o equivalente).
- Conexión a la red interna donde se expone el servidor (ej. `http://localhost:5173` o dirección definida por TI).
- Usuario y contraseña proporcionados por OI/TI.
- Número de banco asignado al usuario técnico.

### 1.2 Inicio de sesión

1. Ingresar a la URL del sistema.
2. En la pantalla de **Login**, completar:

   - **Usuario**: nombre de usuario asignado (ej. `tecnico01`).
   - **Contraseña**.
   - **N° de banco**: seleccionar el banco en el que trabaja el técnico.

3. Presionar **Iniciar sesión**.

Si las credenciales son correctas:

- Se muestra el **nombre completo** del usuario en la interfaz.
- Se carga el sistema filtrado al banco seleccionado.

Si el usuario está inactivo o la contraseña es incorrecta, el sistema muestra un mensaje de error y no permite el acceso.

---

## 2. Pantalla principal de OI

Al iniciar sesión se muestra el **Listado de OI** (Ordenes de Inspección) del usuario.

### 2.1 Elementos principales

- **Barra superior / menú**:
  - Nombre del usuario y banco actual.
  - Opción para **cerrar sesión**.
- **Filtros de búsqueda**:
  - **Texto**: búsqueda parcial por código de OI.
  - **Fecha desde / hasta**: filtra por fecha de registro.
  - Botones:
    - **Buscar**.
    - **Limpiar filtros** (reinicia texto, fechas y vuelve a la página 1).
- **Tabla de OI**:
  - Código de OI.
  - Q3, Alcance, PMA, Presión(bar).
  - Banco y Técnico.
  - Estado de edición (fecha de creación/actualización).
  - Botones de acción:
    - **Editar OI**.
    - **Ver / Gestionar Bancadas**.
    - **Generar Excel**.
    - **Eliminar OI** (solo usuario con rol `admin`).

---

## 3. Crear y editar una OI

### 3.1 Crear nueva OI

1. Desde el listado, hacer clic en **Nueva OI**.
2. Completar el formulario:

   - **Código OI**  
     - Formato obligatorio: `OI-####-YYYY`  
       - `####`: correlativo de 4 dígitos.  
       - `YYYY`: año (ej. 2025).
   - **Q3 (m³/h)**  
     - Seleccionar desde la lista desplegable (valores alineados con la plantilla Excel).
   - **Alcance Q3/Q1**  
     - Seleccionar desde la lista desplegable (también alineada con la plantilla).
   - **PMA**  
     - Elegir 10 o 16 bar.
     - La **Presión(bar)** se calcula automáticamente (10→16.0, 16→25.6).
   - **Tipo de numeración de medidor**  
     - `Correlativo`: genera secuencias de medidor (ej. PA25517601, PA25517602, …).  
     - `No correlativo`: cada medidor se digita manualmente en el Grid.

3. Guardar la OI:
   - El sistema valida el formato del código y los valores permitidos.
   - Si todo es correcto, se registra la OI asociando:
     - Banco del usuario.
     - N° de técnico del usuario.
     - Presión(bar) derivada del PMA.

### 3.2 Editar una OI existente

1. En el listado de OI, ubicar la OI deseada.
2. Presionar **Editar**.
3. Se pueden modificar:

   - Q3
   - Alcance
   - PMA
   - Tipo de numeración

> **Importante:** El **código OI** no se modifica una vez creada.

4. Guardar cambios:
   - El sistema verifica que la OI no haya sido modificada por otro usuario (control de `updated_at`).
   - Si existe conflicto de edición, se mostrará un mensaje indicando que la OI fue modificada en paralelo.

---

## 4. Gestión de Bancadas (Grid)

Cada OI puede tener **una o varias bancadas**. Cada bancada corresponde a un bloque de filas en el Excel.

### 4.1 Abrir la gestión de bancadas

1. En el listado de OI, elegir la OI deseada.
2. Hacer clic en **Bancadas** o en el botón que abre la gestión de bancadas.
3. Se muestra:
   - Lista de bancadas existentes.
   - Botones para **Agregar**, **Editar** y **Eliminar** bancadas.

### 4.2 Crear una nueva bancada

1. Presionar **Agregar Bancada**.
2. Se abre el **Modal de Bancada**, que contiene:
   - Campos de cabecera de bancada:
     - **Medidor base** (opcional).
     - **Estado de bancada** (0–5).
     - **Número de filas** (si no se usa Grid detallado).
   - **Grid Q3/Q2/Q1** (mini-planilla tipo Excel):
     - Columnas:
       - # Medidor.
       - Bloque Q3 (J..P): Temperatura, Presión Entrada, Presión Salida, L.I., L.F., Vol, Tiempo.
       - Bloque Q2 (V..AB): mismos conceptos.
       - Bloque Q1 (AH..AN): mismos conceptos.

3. Completar los datos en la **primera fila** de la bancada:
   - # Medidor.
   - Valores de Q3, Q2 y Q1 según el ensayo.

4. Opcionalmente:
   - Agregar filas adicionales.
   - Ajustar estados por fila (columna Estado).
   - Modificar o borrar filas.

5. Guardar la bancada:
   - Si hay errores de validación (por ejemplo, condiciones de L.I./L.F. que se deben cumplir), el sistema:
     - Resalta las celdas problemáticas (color de fondo).
     - Muestra mensajes explicativos al pasar el cursor o al intentar guardar.
     - **Impide guardar** cuando se incumplen reglas críticas (ej. L.F < L.I).

### 4.3 Editar una bancada existente

1. Seleccionar la bancada en el listado.
2. Presionar **Editar**.
3. En el modal:

   - Ajustar el **Medidor base** o el **Estado de bancada**.
   - Actualizar valores en el Grid (Q3/Q2/Q1, Estados por fila).
   - Agregar o eliminar filas.

4. Guardar:
   - El sistema valida que no haya conflicto de edición (control de `updated_at`).
   - Si otro usuario modificó la bancada mientras se editaba, se mostrará un mensaje de conflicto.

### 4.4 Navegación con teclado en el Grid

Para agilizar el registro, el Grid permite navegación tipo Excel:

- **Enter**:
  - Baja a la siguiente celda de la **misma columna**.
  - En la última fila de la columna, pasa a la **primera fila de la siguiente columna**.
- **Tab / Shift+Tab**:
  - Avanza o retrocede entre columnas.
- **Flechas**:
  - Permiten navegar celda por celda.

La celda enfocada se resalta con un fondo diferenciado para ayudar a identificar dónde se está digitando, sin afectar la legibilidad.

---

## 5. Estados y validaciones

### 5.1 Estado por fila (columna Estado)

- Cada fila tiene un **Estado** numérico (0–5).
- Movimiento típico:
  - 0: sin revisar.
  - 1–5: categorías de conformidad/observación definidas por OI.
- Este valor se guarda por fila y se refleja en el Excel.

Si no se establece un estado por fila:

- El sistema toma como referencia el **estado de la bancada** para la primera fila.
- Filas siguientes pueden heredar el estado de la fila anterior.

### 5.2 Validaciones de rangos

El sistema aplica validaciones sobre Q3/Q2/Q1:

- Revisión de rangos aceptables para errores de indicación (E%).
- Reglas entre L.I. y L.F. y entre niveles Q3, Q2, Q1 (según acuerdos de OI).

Cuando se detecta un valor fuera de rango:

- La celda se resalta (color de advertencia).
- Se muestra el motivo al posicionar el puntero o al intentar guardar.
- En casos críticos, **no se permite guardar** la bancada hasta corregir los valores.

> Las reglas exactas de los rangos están alineadas con el PDF de criterios de OI y con las fórmulas AU..BL de la plantilla Excel.

---

## 6. Generación del Excel

### 6.1 Desde la lista de OI

1. En el listado de OI, localizar la OI deseada.
2. Presionar el botón **Generar Excel**.
3. Se abrirá un cuadro solicitando opcionalmente una **contraseña** para el archivo generado.

### 6.2 Contraseña en la generación

- La contraseña ingresada **no** cambia la protección interna de la hoja.
- Sirve para marcar el archivo como **“reservado / solo lectura”**:
  - Al abrir el archivo, Excel puede mostrar un mensaje indicando que el libro está reservado.
  - El usuario puede optar por abrir como lectura o edición, respetando las protecciones internas.

Si se deja la contraseña en blanco:

- El archivo se genera normalmente, solo sin el mensaje de “reservado”.

### 6.3 Resultado de la generación

- El sistema descarga un archivo `.xlsx` con nombre:

  `OI-####-YYYY-NOMBRE APELLIDO-YYYY-MM-DD.xlsx`

  - `OI-####-YYYY`: código de la OI.
  - `NOMBRE APELLIDO`: técnico responsable.
  - `YYYY-MM-DD`: fecha de última actualización de la OI.

- El Excel contiene:
  - Hoja **“ERROR FINAL”**:
    - Cabeceras en fila 8.
    - Datos desde fila 9.
    - Celdas fijas `E4` (Q3) y `O4` (Alcance) rellenas desde los selects de la OI.
    - Todas las bancadas de la OI, una debajo de otra.
    - Borde inferior grueso de A..BL al final de cada bancada.
    - Fórmulas y cálculos de E%, conformidad, signos de error, etc., en columnas AR..BL.

---

## 7. Uso del Excel generado

### 7.1 Apertura

1. Abrir el archivo `.xlsx` descargado.
2. Si se configuró una contraseña de reserva, Excel puede mostrar:
   - Mensaje de “libro reservado”.
   - Opciones de abrir como solo lectura o continuar con edición.

### 7.2 Celdas editables vs bloqueadas

- **Celdas editables**:
  - `E4` (Q3) y `O4` (Alcance).
  - `A`, `G`, columnas Q3 (J..P), Q2 (V..AB) y Q1 (AH..AN) por cada fila de datos.
- **Celdas bloqueadas**:
  - Fechas (B y C).
  - Banco (D) y Técnico (E).
  - Presión (H).
  - Columnas ocultas de segundos/horas por bloque.
  - Columnas Q1 y E% (AR, AS).
  - Bloque de fórmulas AU..BL (validación y conformidad).

El usuario **no debe** modificar fórmulas ni estructuras; solo los datos de ensayo están pensados para cambios.

---

## 8. Mensajes de error frecuentes

### 8.1 Error 422 al generar Excel

Si al generar el Excel aparece un mensaje tipo:

- `"Q3 no coincide con la lista de la plantilla"`
- `"Alcance no coincide con la lista de la plantilla"`

Significa que los valores seleccionados en la OI no están alineados con la lista interna de la plantilla Excel.

**Acciones sugeridas:**

1. Revisar los valores de Q3 y Alcance en el formulario OI.
2. Verificar con OI/TI que los catálogos del sistema coincidan con la plantilla oficial.
3. Si el problema persiste, reportar a TI para actualizar catálogos o plantilla.

### 8.2 Conflictos de edición (409)

Si se intenta guardar una OI o una bancada y se muestra un mensaje indicando que ha sido modificada por otro usuario:

- Significa que el valor de `updated_at` no coincide con la versión actual.
- **Recomendación**:
  - Recargar la OI/bancada.
  - Revisar los cambios recientes.
  - Volver a aplicar las modificaciones necesarias.

---

## 9. Cierre de sesión

Para salir del sistema de forma segura:

1. Hacer clic en el botón de **Cerrar sesión**.
2. Confirmar la acción si se solicita.
3. El sistema limpia la sesión y regresa a la pantalla de Login.

> Se recomienda siempre cerrar sesión al finalizar el trabajo, especialmente si el equipo es compartido.

---

## 10. Soporte y contacto

Ante cualquier problema técnico (errores inesperados, imposibilidad de generar el Excel, lentitud, etc.):

1. Anotar:
   - Código de OI.
   - Fecha y hora aproximada.
   - Mensaje de error mostrado en pantalla.
2. Contactar al responsable de TI o al líder del OI con esta información.

Este manual resume el flujo esperado para uso estándar del sistema Formato VI:  
desde el **login**, pasando por **creación de OI**, **gestión de bancadas**, hasta la **generación y uso del Excel** con la hoja **“ERROR FINAL”**.
