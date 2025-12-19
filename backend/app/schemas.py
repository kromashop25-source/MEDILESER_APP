from typing import Optional, List, Literal, Annotated, Any
from enum import Enum
from pydantic import BaseModel, Field, ConfigDict, StringConstraints
from datetime import datetime

OI_CODE_PATTERN = r"^OI-\d{4}-\d{4}$"

class NumerationType(str, Enum):
    correlativo = "correlativo"
    no_correlativo = "no correlativo"

    @classmethod
    def _missing_(cls, value):
        """
        Acepta variantes legadas como 'no_correlativo' (con guión bajo) o
        mayúsculas/minúsculas diferentes y las normaliza al valor oficial.
        """
        if not isinstance(value, str):
            return None
        normalized = value.strip().lower().replace("_", " ")
        for member in cls:
            if member.value == normalized:
                return member
        return None

class BancadaRow(BaseModel):
    medidor: Optional[str] = None
    estado: int = Field(default=0, ge=0, le=5)
    q3: Optional[dict[str, Any]] = None
    q2: Optional[dict[str, Any]] = None
    q1: Optional[dict[str, Any]] = None
    conformidad: Optional[str] = None
    model_config = ConfigDict(extra="allow")

class OICreate(BaseModel):
    code: Annotated[str, StringConstraints(pattern=OI_CODE_PATTERN, strip_whitespace=True)]
    q3: float
    alcance: int
    pma: Literal[10, 16]
    banco_id: int
    tech_number: int
    numeration_type: NumerationType = NumerationType.correlativo

class OIUpdate(BaseModel):
    """Payload para actualizar solo los valores técnicos de la OI."""
    q3: float
    alcance: int
    pma: Literal[10, 16]
    numeration_type: NumerationType
    updated_at: datetime

class OIRead(BaseModel):
    id: int
    code: str
    q3: float
    alcance: int
    pma: int
    presion_bar: float
    banco_id: int
    tech_number: int
    numeration_type: NumerationType
    created_at: datetime
    updated_at: Optional[datetime] = None
    creator_name: str
    locked_by_user_id: Optional[int] = None
    locked_by_full_name: Optional[str] = None
    locked_at: Optional[datetime] = None
    read_only_for_current_user: bool = False
    medidores_usuario: Optional[int] = 0
    medidores_total_code: Optional[int] = 0


class BancadaBase(BaseModel):
    medidor: Optional[str] = None
    estado: int = Field(default=0, ge=0, le=5)
    rows: int = Field(default=15, ge=1)  # mínimo 1, por defecto 15
    # Aseguramos que acepte la lista de diccionarios de la grid
    rows_data: Optional[List[BancadaRow]] = None


class BancadaCreate(BancadaBase):
    pass

class BancadaUpdate(BancadaBase):
    updated_at: datetime


class BancadaRead(BancadaBase):
    id: int
    item: int
    created_at: datetime
    updated_at: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)


class OiWithBancadasRead(OIRead):
    bancadas: List[BancadaRead] = Field(default_factory=list)

# --- ESQUEMAS DE USUARIO ---

class UserBase(BaseModel):
    username: str
    first_name: str
    last_name: str
    tech_number: int
    # Roles: admin (superusuario), administrator, technician, standard
    # Legacy soportado: user (equivale a technician)
    role: Literal["admin", "administrator", "technician", "standard", "user"] = "technician"

class UserCreate(UserBase):
    password: str

class UserRead(UserBase):
    id: int
    is_active: bool

class UserUpdatePassword(BaseModel):
    old_password: Optional[str] = None # Requerido para cambio propio
    new_password: str

class UserUpdate(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    tech_number: Optional[int] = None
    role: Optional[str] = None

class OIListSummary(BaseModel):
    medidores_resultado: int = 0
    oi_unicas: int = 0
    medidores_total_oi_unicas: int = 0


class OIListResponse(BaseModel):
    items: List[OIRead]
    total: int
    limit: int
    offset: int
    summary: Optional[OIListSummary] = None
