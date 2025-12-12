from __future__ import annotations
from typing import Dict, Any, List, Optional, Literal
import math
import datetime as dt
import pandas as pd

TypeName = Literal["int", "float", "str", "date"]

def _is_nan(x: Any) -> bool:
    try:
        return pd.isna(x)
    except Exception:
        return False
    
def _check_type(value: Any, expected: TypeName) -> bool:
    if _is_nan(value):
        return True  # vacio pasa
    if expected == "str":
        return isinstance(value, str)
    if expected == "int":
        # Acepta entero de Python, pandas Int64/Int32, y floats sin decimales
        if isinstance(value, (int,)) and not isinstance(value, bool):
            return True
        if isinstance(value, float) and value.is_integer():
            return True
        return False
    if expected == "float":
        # Acepta int y  float
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "date":
        # Acpeta datetime.datetime, pandas.Timestamp, date
        return isinstance(value, (dt.date, dt.datetime, pd.Timestamp))
    return False

def validate_dataframe(
        df: pd.DataFrame,
        required_columns: List[str],
        type_rules: Dict[str, TypeName],
        sample_limit: int = 20,
) -> Dict[str, Any]:
    cols = list(df.columns.astype(str))
    missing = [c for c in required_columns if c not in cols]

    violations: List[Dict[str, Any]] = []
    # Siempre validar tipos en las columnas que existan,
    # aunque haya columnas faltantes.
    for col, tname in type_rules.items():
        if col not in df.columns:
            continue  # si no existe, ya se reporta en "missing" si era requerida
        series = df[col]
        # Enumeramos para no depender del índice de pandas y reportar filas 2..N (1 = encabezado)
        for row_no, value in enumerate(series.tolist(), start=2):
            if not _check_type(value, tname):
                violations.append({
                    "row": row_no,
                    "column": col,
                    "value_preview": str(value)[:60],
                    "expected": tname,
                })
                if len(violations) >= sample_limit:
                    break
        if len(violations) >= sample_limit:
            break
    
    return {
        "ok": (len(missing) == 0 and len(violations) == 0),
        "missing_columns": missing,
        "type_violations": violations,
        "columns": cols,
        "checked_rules": type_rules,
    }

    

    