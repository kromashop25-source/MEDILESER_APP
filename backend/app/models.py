from datetime import datetime
from typing import Optional, List, ClassVar
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
    role: str = Field(default="technician")  # admin | administrator | technician | standard (legacy: user)
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
    saved_at: Optional[datetime] = None

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
    saved_at: Optional[datetime] = None

    oi: Optional[OI] = Relationship(back_populates="bancadas")

class Log01Run(SQLModel, table=True):
    __tablename__: ClassVar[str] = "log01_run"

    id: Optional[int] = Field(default=None, primary_key=True)

    # Trazabilidad con el job async actual
    operation_id: str = Field(index=True)

    # Igual a /logistica/log01/start
    source: str = Field(index=True)

    # Nombre final del Excel (rest.out_name)
    output_name: Optional[str] = Field(default=None)

    # Estados en español para historail (no afecta estados internos del job)
    status: str = Field(default="COMPLETADO", index=True)

    created_at: datetime = Field(default_factory=datetime.utcnow)
    completed_at: Optional[datetime] = None

    # Auditoría del usuario (snapshot de sesión)
    created_by_user_id: Optional[int] = Field(default=None, index=True)
    created_by_username: str = Field(index=True)
    created_by_full_name: Optional[str] = None
    created_by_banco_id: Optional[int]  = Field(default=None, index=True)
    
    # Guardamos el summary completo del consolidado
    summary_json: Optional[dict] = Field(default= None, sa_column=Column(JSON))

    #Soft delete
    deleted_at: Optional[datetime] = None
    deleted_by_user_id: Optional[int] = None
    deleted_by_username: Optional[str] = None
    delete_reason: Optional[str] = None

    artifacts: List["Log01Artifact"] = Relationship(back_populates="run")

class Log01Artifact(SQLModel, table=True):
    __tablename__: ClassVar[str] = "log01_artifact"

    id: Optional[int] = Field(default=None, primary_key=True)
    run_id: int = Field(foreign_key="log01_run.id", index=True)

    # EXCEL_FINAL | JSON_NO_CONFORME_FINAL | JSON_MANIFIESTO
    kind: str = Field(index=True)

    filename: str
    storage_rel_path: str # relativo a settings.data_dir
    content_type: str
    size_bytes: Optional[int] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)

    run: Optional[Log01Run] = Relationship(back_populates="artifacts")



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
    target.numeration_type = enum_val
