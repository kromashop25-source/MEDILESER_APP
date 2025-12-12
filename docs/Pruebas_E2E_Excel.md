# Pruebas E2E de generación de Excel – Formato VI

Este documento define los casos de prueba end-to-end (E2E) para validar la generación del Excel del Formato VI desde la aplicación web Registro VI.

El objetivo es asegurar que:

- La generación del Excel respete la estructura de la plantilla `PLANTILLA_VI.xlsx`:
  - Cabeceras en fila **8**.
  - Datos desde fila **9**.
  - Fórmulas replicadas en rango **AU:BL**.
  - Borde inferior en rango **A:BL** al final de cada bancada.
  - Celdas fijas:
    - `E4` ← valor de Q3 seleccionado.
    - `O4` ← valor de Alcance Q3/Q1 seleccionado.
- El comportamiento de Q3, Q2 y Q1 (lecturas, cálculos de Q y E%) es consistente con la UI.
- Se soportan correctamente:
  - 1…N bancadas por OI.
  - 1…50 filas por bancada.

---

## 1. Entorno de prueba

- Backend:
  - FastAPI + SQLModel + servicio `excel_service.py` actualizado.
  - Base de datos SQLite en estado sano (verificada con `PRAGMA integrity_check: ok`).
- Frontend:
  - React + TypeScript con `BancadaModal.tsx` actualizado.
  - Límite aplicado de **50 filas máximas por bancada**.
- Plantilla:
  - `backend/app/data/PLANTILLA_VI.xlsx`.

---

## 2. Matriz de casos de prueba E2E

### TC-E2E-EXCEL-01 – Caso base (1 OI, 1 bancada, pocas filas)

**Objetivo:**  
Verificar la generación correcta del Excel con una sola OI y una bancada con pocas filas.

**Setup:**

1. Crear una OI con:
   - Q3: valor de catálogo (ej. 2.5).
   - Alcance Q3/Q1: valor de catálogo (ej. 500).
   - PMA: 16 (Presión(bar) calculada 25.6).
2. Crear una bancada asociada a esa OI con **5 filas**:
   - Estados = 0.
   - Q3/Q2/Q1 con lecturas completas y consistentes en la fila 1.
   - Resto de filas con lecturas válidas.

**Acción:**

- Desde la UI, generar el Excel para esa OI.

**Resultados esperados:**

- El archivo se descarga con nombre `OI-####-YYYY.xlsx` según código de la OI.
- En la hoja principal:
  - `E4` contiene el valor de Q3 seleccionado.
  - `O4` contiene el Alcance seleccionado.
  - Las cabeceras están en fila **8** (A:AS).
  - Los datos empiezan en fila **9**.
  - Las fórmulas en columnas **AU:BL** están presentes y ajustadas para filas 9 a 13.
  - Existe un borde inferior (A:BL) al final de la bancada.
- Los datos de medidor, estados y lecturas coinciden con la UI.
- No se generan errores 500 ni 422.

---

### TC-E2E-EXCEL-02 – 1 OI con múltiples bancadas

**Objetivo:**  
Validar el consolidado de varias bancadas para una misma OI en un solo Excel.

**Setup:**

1. Crear una OI válida (Q3, Alcance, PMA).
2. Crear **3 bancadas** asociadas a esa OI:
   - Bancada 1: 10 filas.
   - Bancada 2: 8 filas.
   - Bancada 3: 5 filas.

**Acción:**

- Generar el Excel para esa OI.

**Resultados esperados:**

- El Excel contiene todas las bancadas en la **misma hoja**.
- Las filas se distribuyen de forma continua sin saltos vacíos inesperados.
- Después de cada bancada:
  - Se aplica un borde inferior en rango A:BL para la última fila de esa bancada.
- Las fórmulas en AU:BL abarcan el rango completo de filas usadas por las 3 bancadas.
- La autonumeración en columna A es continua (no se reinicia por bancada).

---

### TC-E2E-EXCEL-03 – Filas sin lecturas (estado = 0)

**Objetivo:**  
Validar que, cuando una fila no tiene lecturas en Q3/Q2/Q1, el Excel deja L.I/L.F vacías y mantiene el resto de la lógica.

**Setup:**

1. Crear una OI y una bancada con **6 filas**.
2. Configurar:
   - Fila 1: lecturas completas en Q3, Q2 y Q1.
   - Fila 4:
     - Estado = 0.
     - Medidor configurado.
     - Sin lecturas digitadas en Q3, Q2, Q1 (L.I y L.F vacíos en el modal).
   - Resto de filas con lecturas válidas.

**Acción:**

- Generar el Excel para esa OI.

**Resultados esperados en Excel:**

- Fila 1: Q3/Q2/Q1 completos (L.I, L.F y cálculos).
- Fila 4 :
  - L.I y L.F de Q3/Q2/Q1 aparecen **vacíos** (no arrastran valores desde la fila 1).
  - Temp / P.Ent / P.Sal / Vol / Tpo se ajustan según la lógica de replicación.
  - Las fórmulas de Q y E% están presentes en el rango AU:BL para esas filas.
- El resto de filas coinciden con lo mostrado en la UI.

---

### TC-E2E-EXCEL-04 – Filas con estado ≠ 0 y sin lecturas

**Objetivo:**  
Verificar el comportamiento cuando una fila tiene estado de daño/falla/paralizado pero no tiene lecturas.

**Setup:**

1. Crear una OI y una bancada con **6 filas**.
2. Configurar:
   - Fila 1:
     - Lecturas completas en Q3, Q2 y Q1.
   - Fila 3:
     - Estado = 1 (daño físico u otro código 1–4).
     - Sin lecturas en Q3/Q2/Q1.
   - Fila 5:
     - Estado = 5 (paralizado).
     - Sin lecturas en Q3/Q2/Q1.
   - El resto de filas pueden tener estados y lecturas variadas.

**Acción:**

- Generar el Excel.

**Resultados esperados:**

- En filas 3 y 5, para Q3/Q2/Q1:
  - L.I y L.F aparecen vacíos (no copian las lecturas de la fila 1).
  - Temp, P.Ent, P.Sal, Vol, Tpo se mantienen según lo replicado desde la fila base.
  - Las fórmulas de Q y E% siguen aplicándose (el resultado puede ser vacío o 0 según la fórmula).
- En la columna de Estado del Excel se reflejan los valores 1 y 5 correctamente.
- No se genera error 500 durante la operación.

---

### TC-E2E-EXCEL-05 – Límite de filas (50 filas por bancada)

**Objetivo:**  
Validar que el sistema maneja correctamente el límite de 50 filas por bancada en rendimiento y consistencia del Excel.

**Setup:**

1. Crear una OI y una bancada con **50 filas**.
2. Configurar:
   - Fila 1: lecturas completas en Q3/Q2/Q1.
   - Otras filas:
     - Algunas con lecturas.
     - Algunas sin lecturas (L.I y L.F vacíos).
     - Combinación de estados 0, 1–4 y 5.

**Acción:**

- Generar el Excel.

**Resultados esperados:**

- El Excel se genera sin errores y en un tiempo razonable.
- Todas las filas hasta la fila correspondiente a la número 50 de la bancada:
  - Tienen fórmulas en AU:BL correctamente replicadas.
  - Presentan datos y estados alineados con la UI.
- Hay un borde inferior en rango A:BL bajo la última fila usada por la bancada (fila 50).
- No se observan filas “perdidas” o truncadas en la salida.

---

### TC-E2E-EXCEL-06 – Validación de Q3 / Alcance y listas

**Objetivo:**  
Verificar la correcta escritura de Q3 y Alcance en E4 y O4, y la ausencia de errores 422 relacionados con listas.

**Setup:**

1. Crear al menos 3 OI con combinaciones distintas de:
   - Q3 (varios valores de catálogo).
   - Alcance Q3/Q1 (varios valores de catálogo).
2. Para cada OI, crear al menos una bancada válida.

**Acción:**

- Generar el Excel para cada OI.

**Resultados esperados:**

- En cada archivo generado:
  - `E4` refleja el valor de Q3 seleccionado en la OI.
  - `O4` refleja el Alcance seleccionado en la OI.
- No se presentan errores 422 por listas al generar el Excel.
- Las listas internas de la plantilla (Q3, Alcance) funcionan sin conflictos.

---

### TC-E2E-EXCEL-07 – Caso “sin bancadas” (validación negativa)

**Objetivo:**  
Validar el comportamiento cuando se intenta generar un Excel para una OI sin bancadas.

**Setup:**

1. Crear una OI válida sin asociar ninguna bancada.

**Acción:**

- Intentar generar el Excel desde la UI.

**Resultados esperados:**

- La operación es rechazada de forma controlada:
  - La API responde con estado 4xx apropiado (ej. 400) o la UI bloquea la acción.
  - Se muestra un mensaje claro al usuario indicando que debe registrar al menos una bancada.
- No se genera un archivo Excel vacío o corrupto.
- No se produce error 500.

---

## 3. Observaciones

- Este plan de pruebas E2E está ajustado al límite de **50 filas por bancada**, que se considera suficiente para el uso real del Formato VI.
- La ejecución periódica de estos casos debe realizarse:
  - Al finalizar cambios relevantes en `excel_service.py`.
  - Antes de publicar una nueva versión estable del Registro VI.
