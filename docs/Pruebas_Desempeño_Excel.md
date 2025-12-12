# Pruebas de desempeño (estrés) – Registro VI / Formato VI

Este documento define las pruebas de desempeño (estrés) para la generación del Excel del Formato VI y el uso del módulo de bancadas, considerando el límite actual de **50 filas por bancada**.

El objetivo es:

- Medir el tiempo de respuesta de la generación de Excel en escenarios “pesados” pero realistas.
- Verificar que el consumo de recursos (CPU/RAM) se mantiene en niveles aceptables durante la operación.
- Confirmar que el sistema no se degrada ni se bloquea al ejecutar varias generaciones de Excel de forma consecutiva.

---

## 1. Métricas y criterios de aceptación

### Métricas principales

- **T_gen_backend**: tiempo desde que el backend inicia la generación del Excel (llamada al servicio de Excel) hasta que termina de escribir el archivo.
- **T_gen_end_to_end**: tiempo desde que el usuario hace clic en “Generar Excel” hasta que el archivo está disponible para descargar/abrir.
- **Uso de memoria aproximado** del proceso backend (Python/uvicorn/EXE) durante la generación en el peor caso probado.

### Criterios de aceptación (orientativos)

- **T_gen_end_to_end**:
  - Caso 1 OI / 1 bancada / 10 filas: ≤ 2 s.
  - Caso 1 OI / 1 bancada / 50 filas: ≤ 4 s.
  - Caso 1 OI / 3 bancadas / 50 filas c/u: ≤ 6 s.
- No se deben producir errores 500, timeouts ni bloqueos aparentes de la UI.
- El uso de memoria del backend debe mantenerse en un rango razonable (sin crecer de forma sostenida caso tras caso).

> Nota: los valores exactos pueden ajustarse según el hardware del servidor y el entorno real, pero cualquier desviación importante debe ser analizada.

---

## 2. Preparación para las mediciones

### 2.1. Entorno

- Backend ejecutándose en el entorno objetivo (PC local o servidor donde se usará el sistema).
- Frontend cargado en navegador (Chrome u otro navegador estándar).
- BD en estado sano (sin corrupción).
- PLANTILLA_VI.xlsx estable y definitiva.

### 2.2. Soporte para medir tiempos

Se recomienda:

- Activar logs de tiempo en el backend para el endpoint de generación de Excel:
  - Log “start generating Excel” con timestamp.
  - Log “finished generating Excel” con timestamp.
- Opcional:
  - Medir también con cronómetro manual desde la UI para T_gen_end_to_end.

---

## 3. Casos de prueba de desempeño

### PERF-01 – Caso base ligero

**Objetivo:**  
Medir el tiempo de generación en un escenario simple y confirmar que el desempeño es muy rápido.

**Setup:**

1. Crear una OI con parámetros válidos (Q3, Alcance, PMA).
2. Crear 1 bancada con **10 filas**, con lecturas completas (Q3/Q2/Q1) en todas las filas o en la mayoría.

**Acción:**

- Ejecutar la generación de Excel 3 veces seguidas para esta OI.

**Métricas:**

- Para cada ejecución:
  - Medir T_gen_backend desde logs.
  - Medir T_gen_end_to_end (cronómetro manual o herramienta de medición).
- Calcular promedio y máximo.

**Criterio de aceptación:**

- T_gen_end_to_end promedio ≤ 2 s.
- No hay errores ni degradación entre la 1.ª y la 3.ª ejecución.

---

### PERF-02 – Peor caso por bancada (50 filas)

**Objetivo:**  
Validar desempeño en una bancada al límite de filas (50).

**Setup:**

1. Crear una OI con parámetros válidos.
2. Crear 1 bancada con **50 filas**:
   - Fila 1 con lecturas completas Q3/Q2/Q1.
   - Varias filas con combinaciones de:
     - Lecturas completas.
     - Filas sin lecturas (L.I/L.F vacías).
     - Estados 0, 1–4, 5.

**Acción:**

- Generar el Excel para esa OI al menos 3 veces.

**Métricas:**

- T_gen_backend y T_gen_end_to_end en cada ejecución.
- Observación del uso de CPU/RAM del proceso backend durante las ejecuciones.

**Criterio de aceptación:**

- T_gen_end_to_end promedio ≤ 4 s.
- Sin errores, sin bloqueos visuales prolongados.
- Sin crecimiento anómalo de consumo de memoria.

---

### PERF-03 – Múltiples bancadas al límite

**Objetivo:**  
Probar el peor escenario realista: una OI con varias bancadas pesadas.

**Setup:**

1. Crear una OI con parámetros válidos.
2. Crear **3 bancadas** asociadas a esa OI:
   - Cada bancada con **50 filas**.
   - Datos variados (similar a PERF-02).

**Acción:**

- Generar el Excel para esa OI 2 veces seguidas.

**Métricas:**

- T_gen_backend y T_gen_end_to_end para cada ejecución.
- Observación de CPU/RAM.

**Criterio de aceptación:**

- T_gen_end_to_end promedio ≤ 6 s.
- Sin errores 500 ni mensajes de fallo de generación.
- El uso de memoria no se dispara entre la primera y la segunda ejecución.

---

### PERF-04 – Ejecuciones consecutivas (estrés moderado)

**Objetivo:**  
Verificar estabilidad tras varias generaciones consecutivas, evitando pérdidas de rendimiento o fugas de memoria.

**Setup:**

1. Usar uno de los escenarios anteriores (recomendado PERF-02 o PERF-03).
2. Mantener el sistema en el entorno real de ejecución (misma máquina, mismas condiciones).

**Acción:**

- Generar el Excel **10 veces seguidas** para la misma OI, esperando a que termine cada generación antes de lanzar la siguiente.

**Métricas:**

- Registrar T_gen_backend y T_gen_end_to_end para cada una de las 10 ejecuciones.
- Observar evolución de uso de memoria del backend.

**Criterio de aceptación:**

- No hay crecimiento significativo de T_gen_end_to_end entre la primera y la décima ejecución.
- No se observa crecimiento sostenido del consumo de memoria.
- No se producen errores 500 ni bloqueos.

---

### PERF-05 – Escenario de carga ligera con uso normal

**Objetivo:**  
Simular uso normal por un técnico en una jornada corta, con varias OI y bancadas de tamaño medio.

**Setup:**

1. Crear entre 3 y 5 OI distintas, cada una con:
   - 1 o 2 bancadas de entre 10 y 30 filas.
2. Para algunas OI, generar Excel dos veces (ej. después de modificar bancadas).

**Acción:**

- Durante una ventana de tiempo (por ejemplo 30–60 minutos), usar el sistema “como en la práctica”:
  - Crear OI, editar bancadas, generar Excel cuando corresponde.
  - No lanzar pruebas irreales (sincronizadas) sino acciones similares a las del usuario final.

**Métricas:**

- Tiempo promedio de generación en estos casos.
- Observación general de fluidez del sistema.

**Criterio de aceptación:**

- La sensación subjetiva es de fluidez y tiempos de espera razonables.
- No se registran errores en los logs.
- El sistema permanece estable durante toda la sesión.

---

## 4. Registro de resultados

Se recomienda llevar una tabla de resultados, por ejemplo:

| ID Caso   | Fecha ejecución | T_gen_backend (promedio) | T_gen_end_to_end (promedio) | Resultado | Observaciones                        |
|-----------|-----------------|--------------------------|-----------------------------|-----------|--------------------------------------|
| PERF-01   | dd/mm/aaaa      | X.XX s                   | Y.YY s                      | OK/KO     |                                      |
| PERF-02   | dd/mm/aaaa      | X.XX s                   | Y.YY s                      | OK/KO     |                                      |
| PERF-03   | dd/mm/aaaa      | X.XX s                   | Y.YY s                      | OK/KO     |                                      |
| PERF-04   | dd/mm/aaaa      | X.XX s                   | Y.YY s                      | OK/KO     |                                      |
| PERF-05   | dd/mm/aaaa      | X.XX s                   | Y.YY s                      | OK/KO     |                                      |

Las evidencias (logs relevantes y, si se desea, capturas de los tiempos de ejecución) pueden almacenarse en:

`docs/evidencias/18.1.15_Pruebas_Desempeno/`
