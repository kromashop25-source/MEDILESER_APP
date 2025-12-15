from datetime import datetime
from typing import Optional, List
from sqlmodel import SQLModel, Field, Relationship
from sqlalchemy import Column, CheckConstraint, Enum as SAEnum, event
from sqlalchemy.types import JSON
from .schemas import NumerationType

class User(SQLModel, table=True):
    """Usuario del sistema OI.

    Por ahora se usa principalmente para auditoría; la autenticación
    sigue usando usuarios de prueba en memoria.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(index=True, unique=True)
    first_name: str
    last_name: str
    password_hash: str
    tech_number: int
    role: str = Field(default="user")  # "admin" | "user"
    is_active: bool = Field(default=True)
    allowed_modules: Optional[List[str]] = Field(default=None, sa_column=Column(JSON))

class OI(SQLModel, table=True):
    __table_args__ = (
        CheckConstraint(
            "numeration_type in ('correlativo','no correlativo')",
            name="ck_oi_numeration_type",
        ),
    )
 
    id: Optional[int] = Field(default=None, primary_key=True)
    code: str = Field(index=True)  # OI-####-YYYY (se permite duplicado)
    q3: float
    alcance: int
    pma: int
    presion_bar: float
    banco_id: int
    tech_number: int
    locked_by_user_id: Optional[int] = Field(default=None, foreign_key="user.id", index=True)
    locked_at: Optional[datetime] = Field(default=None)
    # Tipo de numeración para la columna #Medidor del Grid:
    # "correlativo" → incrementa +1
    # "no correlativo" → solo replica prefijo
    numeration_type: NumerationType = Field(
        default=NumerationType.correlativo,
        sa_column=Column(
            SAEnum(
                NumerationType,
                # Persist the enum value with espacio ("no correlativo") so it matches the DB check constraint
                values_callable=lambda obj: [e.value for e in obj],
                native_enum=False,
                name="numerationtype",
            ),
            nullable=False,
        ),
    )
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: Optional[datetime] = None

    bancadas: List["Bancada"] = Relationship(back_populates="oi")

class Bancada(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    oi_id: int = Field(foreign_key="oi.id")
    item: int                       # autonum (1..n)
    # Campos mínimos de ejemplo (agrega los reales luego)
    medidor: Optional[str] = None
    estado: int = Field(default=0, ge=0, le=5)  # 0..5 (editable; default 0)
    rows: int = Field(default=15, ge=1)
    # Grid de filas de la bancada (cada elemento representa una fila del modal/Excel).
    # Se almacena como JSON (lista de dicts) para conservar la mini-planilla completa.
    rows_data: Optional[List[dict]] = Field(
        default=None,
        sa_column=Column(JSON)
    )

    # Auditoría de la bancada
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: Optional[datetime] = None

    oi: Optional[OI] = Relationship(back_populates="bancadas")

# --- Normalización de numeration_type al guardar ---
@event.listens_for(OI, "before_insert")
@event.listens_for(OI, "before_update")
def _normalize_numeration_type(mapper, connection, target: OI):
    """Asegura que siempre se guarde con el valor oficial ('correlativo' o 'no correlativo')."""
    raw = getattr(target, "numeration_type", None)
    if raw is None:
        target.numeration_type = NumerationType.correlativo
        return

    # Permite valores con guion bajo o Enum
    try:
        enum_val = raw if isinstance(raw, NumerationType) else NumerationType(raw)
    except Exception:
        enum_val = NumerationType._missing_(raw)
        if enum_val is None:
            enum_val = NumerationType.correlativo
    # Guardamos siempre como string oficial (con espacio)
    target.numeration_type = enum_val.value if isinstance(enum_val, NumerationType) else str(enum_val)
