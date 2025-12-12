from __future__ import annotations
from typing import List, Optional, Literal, Dict, Any
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, SecretStr

from app.services.excel_io import inspect_excel, update_excel, ExcelError
from app.services import read_as_dataframe, validate_dataframe
from app.utils.refs import is_valid_cell_ref

router = APIRouter()

class EditItem(BaseModel):
    sheet: str = Field(..., description="Nombre de la hoja de Excel")
    cell: str = Field(..., description="Referencia tipo A1 (ej. 'B3')")
    value: Any = Field(..., description="Valor a asignar a la celda")

class InspectRequest(BaseModel):
    file_path: str = Field(..., description="Ruta local o red al archivo de Excel")
    open_password: Optional[SecretStr] = Field(default=None, description="Contraseña para abrir el archivo (si tiene)")

class UpdateRequest(BaseModel):
    file_path: str
    edits: List[EditItem] 
    open_password: Optional[SecretStr]  = None
    save_mode: Literal["same_password", "no_password", "new_password"] = "same_password"
    new_password: Optional[SecretStr] = None

class ChangePasswordRequest(BaseModel):
    file_path: str
    open_password: SecretStr
    mode: Literal["no_password", "new_password"]
    new_password: Optional[SecretStr] = None

class ValidateRequest(BaseModel):
    file_path: str
    sheet: Optional[str] = None
    header_row: int = 1
    required_columns: List[str] = Field(default_factory=list)
    type_rules: Dict[str, Literal["int", "float", "str", "date"]] = Field(default_factory=dict)
    open_password: Optional[SecretStr] = None

@router.post("/inspect")
def excel_inspect(payload: InspectRequest):
    # Nunca loguear contraseñas
    pw = payload.open_password.get_secret_value() if payload.open_password else None
    try:
        result = inspect_excel(payload.file_path, pw)
        # Limpiar password de memoria
        del pw
        return result
    except ExcelError as ex:
        raise HTTPException(status_code=400, detail=str(ex)) from ex
    except FileNotFoundError as ex:
        raise HTTPException(status_code=404, detail=str(ex)) from ex
    except PermissionError as ex:
        raise HTTPException(status_code=403, detail=f"Permisos insuficientes: {ex}") from ex
    except Exception as ex:
        raise HTTPException(status_code=500, detail=f"Error inesperado: {type(ex).__name__}: {ex}") from ex
     
@router.post("/update")
def excel_update(payload: UpdateRequest):
    # ✅ Validación TEMPRANA (fuera del try): evita convertir 400→500
    for e in payload.edits:
        if not is_valid_cell_ref(e.cell):
            raise HTTPException(
                status_code=400,
                detail=f"Celda inválida: {e.cell}. Formato esperado tipo A1 (p. ej., B3)"
            )
    # Extraer secretos SOLO si la validación pasó
    pw = payload.open_password.get_secret_value() if payload.open_password else None
    new_pw = payload.new_password.get_secret_value() if payload.new_password else None
    try:
        result = update_excel(
            path=payload.file_path,
            edits=[e.model_dump() for e in payload.edits],
            password=pw,
            save_mode=payload.save_mode,
            new_password=new_pw
        )
        # Limpiar secrets
        del pw
        del new_pw
        return result
    except ExcelError as ex:
        raise HTTPException(status_code=400, detail=str(ex)) from ex
    except HTTPException:
        # Dejar pasar HTTPException explícitas
         raise
    except FileNotFoundError as ex:
        raise HTTPException(status_code=404, detail=str(ex)) from ex
    except PermissionError as ex:
        raise HTTPException(status_code=403, detail=f"Permisos insuficientes: {ex}") from ex
    except Exception as ex:
        raise HTTPException(status_code=500, detail=f"Error inesperado: {type(ex).__name__}: {ex}") from ex
    
@router.post("/change-password")
def excel_change_password(payload: ChangePasswordRequest):
    pw = payload.open_password.get_secret_value()
    new_pw = payload.new_password.get_secret_value() if payload.new_password else None
    try:
        if payload.mode == "new_password" and not new_pw:
            raise HTTPException(status_code=400, detail="Debes enviar 'new_password' cuando mode='new_password'.")
        
        # Reutilizamos la lógica central con edits vacíos
        result = update_excel(
            path=payload.file_path,
            edits=[], # no cambiamos celdas, sólo la protección
            password=pw,
            save_mode="no_password" if payload.mode == "no_password" else "new_password",
            new_password=new_pw,
        )
        del pw, new_pw
        return result
    except ExcelError as ex:
        raise HTTPException(status_code=400, detail=str(ex)) from ex
    except HTTPException:
        # Deja pasar las HTTPException que hayamos lanzado explícitamente
        raise
    except FileNotFoundError as ex:
        raise HTTPException(status_code=404, detail=str(ex)) from ex
    except PermissionError as ex:
        raise HTTPException(status_code=403, detail=f"Permisos insuficientes: {ex}") from ex
    except Exception as ex:
        raise HTTPException(status_code=500, detail=f"Error inesperado: {type(ex).__name__}: {ex}") from ex
@router.post("/validate")  
def excel_validate(payload: ValidateRequest):
    pw = payload.open_password.get_secret_value() if payload.open_password else None
    try:
        df = read_as_dataframe(
            path=payload.file_path,
            sheet=payload.sheet,
            header_row=payload.header_row,
            password=pw,
        )
        result = validate_dataframe(
            df=df,
            required_columns=payload.required_columns,
            type_rules=payload.type_rules,
        )
        # no retornamos el DataFrame; solo el resultado
        del pw
        return result

    except ExcelError as ex:
        raise HTTPException(status_code=400, detail=str(ex)) from ex
    except FileNotFoundError as ex:
        raise HTTPException(status_code=404, detail=str(ex)) from ex
    except PermissionError as ex:
        raise HTTPException(status_code=403, detail=f"Permisos insuficientes: {ex}") from ex
    except Exception as ex:
        raise HTTPException(status_code=500, detail=f"Error inesperado: {type(ex).__name__}: {ex}") from ex
