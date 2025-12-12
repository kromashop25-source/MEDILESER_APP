# Integración VIMA → LISTA de OIs

## Qué resuelve
Copia las OI desde la plantilla **VIMA** (C..N) hacia la **LISTA de OIs** (B..M), preservando estilos y combinaciones de celdas. Soporta modo **incremental**: solo agrega OIs posteriores al último OI presente en LISTA.

## Endpoints
- `POST /integrations/vima-to-lista`  
  Ejecuta la integración. Campos clave:
  - `incremental: bool` (default `false`)
  - `oi_pattern: string` (default `^OI-(\d+)-(\d{4})$`)
  - `strict_incremental: bool` (default `false`)
- `POST /integrations/vima-to-lista/dry-run`  
  Simula la integración, devolviendo solo conteos y rangos.

## Reglas
- OI válida: `OI-<correlativo>-<AAAA>` (regex configurable).
- Fila válida: C con OI y **G..N** con datos (o al menos uno si `require_all_g_to_n=false`).
- Incremental estricto: si el último OI en LISTA no matchea el patrón, responde **400**.

## Ejemplos (curl)
```bat
curl -X POST "http://127.0.0.1:8000/integrations/vima-to-lista" -H "Content-Type: application/json" --data "@payload_incremental.json"
curl -X POST "http://127.0.0.1:8000/integrations/vima-to-lista/dry-run" -H "Content-Type: application/json" --data "@payload_incremental.json"
