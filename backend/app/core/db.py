from pathlib import Path
from sqlmodel import SQLModel, create_engine
import os
import sys

from app.core.settings import get_settings

settings = get_settings()

# Ruta física de la BD (compartida entre versiones)
DB_PATH: Path = settings.data_dir / settings.database_filename


def _set_hidden_windows(path: Path) -> None:
    """
    Marca una carpeta como oculta en Windows.
    Solo se usa en modo EXE (cuando corre PyInstaller).
    """
    if os.name != "nt":
        return
    try:
        import ctypes

        FILE_ATTRIBUTE_HIDDEN = 0x02
        attrs = ctypes.windll.kernel32.GetFileAttributesW(str(path))
        if attrs == -1:
            return  # ruta no existe o error
        if not (attrs & FILE_ATTRIBUTE_HIDDEN):
            ctypes.windll.kernel32.SetFileAttributesW(str(path), attrs | FILE_ATTRIBUTE_HIDDEN)
    except Exception:
        # No rompemos la app si falla; simplemente no se oculta
        pass


# Aseguramos que la carpeta data exista (en root_dir/data)
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

# Si estamos corriendo dentro del EXE, ocultar la carpeta data
if getattr(sys, "_MEIPASS", None) is not None or getattr(sys, "frozen", False):
    _set_hidden_windows(DB_PATH.parent)

"""
Notas de robustez y backup de vi.db
-----------------------------------
- La base de datos principal está en data/vi.db (DB_PATH), en el directorio raíz
  de la aplicación (por ejemplo, Y:\...\REGISTRO_VI_APP\data\vi.db).
- El engine usa un timeout ampliado para reducir errores "database is locked".
- Se recomienda programar un backup periódico de data/vi.db hacia un
  repositorio seguro (por ejemplo, un share SMB con snapshots). La copia puede
  hacerse con herramientas de sistema (robocopy, rsync, tarea programada) o
  utilizando el comando `sqlite3` con `.backup`, idealmente en horarios de
  baja actividad.
"""

engine = create_engine(
    settings.database_url,
    echo=False,
    connect_args={
        # Permitimos uso multi-hilo en FastAPI/Uvicorn
        "check_same_thread": False,
        # Tiempo máximo de espera antes de lanzar "database is locked" (segundos)
        "timeout": 5.0,
    },
)


def _configure_sqlite_pragmas() -> None:
    """
    Ajusta PRAGMAs globales de SQLite para uso multiusuario:
    - journal_mode = WAL (mejor concurrente en red).
    - synchronous = NORMAL (equilibrio entre seguridad y rendimiento).
    - busy_timeout = 5000 ms (espera hasta 5s antes de lanzar "database is locked").

    Se ejecuta una vez al iniciar la aplicación; WAL queda persistente en el
    archivo de la BD, mientras que el timeout se aplica a la conexión actual
    (en este caso, al pool de SQLAlchemy).
    """
    with engine.begin() as conn:
        conn.exec_driver_sql("PRAGMA journal_mode=WAL;")
        conn.exec_driver_sql("PRAGMA synchronous=NORMAL;")
        # Además del timeout de conexión, reforzamos el valor con PRAGMA.
        conn.exec_driver_sql("PRAGMA busy_timeout = 5000;")


def _ensure_updated_at_column() -> None:
    """Add the updated_at column when an old schema is missing it."""
    with engine.begin() as conn:
        cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(oi)").all()}
        # If the table does not exist yet, create_all will create it fully
        if not cols:
            return
        if "updated_at" not in cols:
            conn.exec_driver_sql("ALTER TABLE oi ADD COLUMN updated_at DATETIME")
            conn.exec_driver_sql(
                "UPDATE oi SET updated_at = created_at WHERE updated_at IS NULL"
            )

def _ensure_oi_lock_columns() -> None:
    """
    Agrega columnas de lock (locked_by_user_id, locked_at) si faltan en esquemas antiguos.
    """
    with engine.begin() as conn:
        cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(oi)").all()}
        if not cols:
            return
        if "locked_by_user_id" not in cols:
            conn.exec_driver_sql("ALTER TABLE oi ADD COLUMN locked_by_user_id INTEGER")
        if "locked_at" not in cols:
            conn.exec_driver_sql("ALTER TABLE oi ADD COLUMN locked_at DATETIME")


def _ensure_bancada_updated_at_column() -> None:
    """Add and backfill updated_at in bancada if an older DB is missing it."""
    with engine.begin() as conn:
        cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(bancada)").all()}
        if not cols:
            return
        if "updated_at" not in cols:
            conn.exec_driver_sql("ALTER TABLE bancada ADD COLUMN updated_at DATETIME")
        base_column = "created_at" if "created_at" in cols else None
        if base_column:
            conn.exec_driver_sql(
                f"UPDATE bancada SET updated_at = {base_column} WHERE updated_at IS NULL"
            )
        else:
            conn.exec_driver_sql(
                "UPDATE bancada SET updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)"
            )


def _ensure_oi_constraints() -> None:
    """
    Asegura un índice normal sobre oi.code (para búsquedas), sin unicidad.
    """
    from sqlmodel import Session

    with Session(engine) as session:
        conn = session.connection()
        conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS idx_oi_code ON oi (code)"
        )


def _ensure_user_role_column() -> None:
    """
    Agrega la columna role a la tabla user si falta, y la rellena.
    - default 'user'
    - si el username es 'admin', asigna 'admin'
    """
    with engine.begin() as conn:
        cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info([user])").all()}
        if not cols:
            return
        if "role" not in cols:
            conn.exec_driver_sql("ALTER TABLE [user] ADD COLUMN role TEXT DEFAULT 'user'")
            # backfill
            conn.exec_driver_sql("UPDATE [user] SET role = 'admin' WHERE lower(username) = 'admin'")
            conn.exec_driver_sql("UPDATE [user] SET role = COALESCE(role, 'user')")


def _ensure_user_is_active_column() -> None:
    """
    Agrega la columna is_active a la tabla user si falta, y la rellena en 1.
    """
    with engine.begin() as conn:
        cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info([user])").all()}
        if not cols:
            return
        if "is_active" not in cols:
            conn.exec_driver_sql("ALTER TABLE [user] ADD COLUMN is_active BOOLEAN DEFAULT 1")
            conn.exec_driver_sql("UPDATE [user] SET is_active = 1 WHERE is_active IS NULL")


DEFAULT_USERS = [
    # id, username, first_name, last_name, password_hash, tech_number, role, is_active
    (1, "admin", "Admin", "Sistema", "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4", 101, "admin", 1),
    (2, "inspector", "Inspector", "Demo", "8fdde8f277d0bb990e2d2042cdd4bebf6b23363e3ab4838b2ca2419b64d6bd17", 102, "user", 1),
    (3, "acedeño", "Antony", "Cedeño", "8b1cba50887d112bc3eccb5ac1511d6e3a3fc6a6a6793aa0de9cfeba58706329", 1, "user", 1),
    (4, "fpasco", "Federico", "Pasco", "9d77e2ec8d141896d2f5d1c635c9a83f6bb09438eddb866707b061fd7a226e65", 2, "user", 1),
    (5, "acordova", "Alfredo", "Cordova", "1f94d6e9a124376432492163dabf68884c9bb917627c0081feb119efe9dd64ab", 3, "user", 1),
    (6, "lnoriega", "Luis", "Noriega", "e6dd63f535a2137c2ef44bc1c34043f988a38267ce31db46b61fc27f41a05407", 4, "user", 1),
    (7, "amansilla", "Antony", "Mansilla", "0f5402f1712cda47311a52f235dbb092f2bf619f2f6630feb02c181bbafbcad8", 5, "user", 1),
    (8, "cmezarina", "Carlo", "Mezarina", "3b738ff2af735502af183d6849d1756761752d2120520ca6489f5937f1c810b9", 6, "user", 1),
    (9, "efatama", "Emerson", "Fatama", "474d25547210e9d0520174d711b61b70bb03e8a02ffa5cfd1f1c5e09ecf40af4", 8, "user", 1),
    (10, "gfelix", "Gianfranco", "Felix", "92f73114eb093619fc8e697aebf59ce6ab1e7d2763e30d4c564c1fa809667ef2", 9, "user", 1),
    (11, "mquispe", "Mario", "Quispe", "8bdfc4786d5894f9fffc639e7548abe01f6dfa2e3f216b5cf29966e54f424531", 10, "user", 1),
    (12, "dflores", "Diego", "Flores", "f3ec67da5683d3215c2f8befda83dd916f2540bfdc207dda95303be5adbf0430", 11, "user", 1),
    (13, "pmuñoz", "Percy", "Muñoz", "e57613fbb3b60adbe694ea6783955220eb012925f92a9fd0be89641526cfe2a9", 13, "user", 1),
    (14, "kllanos", "Kevin", "Llanos", "19b38ad628daae808bf8652ca5ee00e205bc7bb49e7ef156f04898572a8e1218", 14, "user", 1),
    (15, "bquinto", "Bryan", "Quinto", "b640b38628f709947c0e1c1872378b937b953d3b9d87a1dd1ffb79943b224a2b", 15, "user", 1),
    (16, "mmezahuaman", "Marcos", "Mezahuaman", "94f72fe6755da2b7d86da6fbc2b3cf319880b253cc93991bd9b76ad6333c46f0", 16, "user", 1),
]


def _seed_default_users() -> None:
    """
    Inserta usuarios base solo si no existen (INSERT OR IGNORE).
    Esto garantiza que al empaquetar el EXE la BD arranque con estos usuarios.
    """
    if not DEFAULT_USERS:
        return
    with engine.begin() as conn:
        conn.exec_driver_sql(
            """
            INSERT OR IGNORE INTO [user]
                (id, username, first_name, last_name, password_hash, tech_number, role, is_active)
            VALUES
                (:id, :username, :first, :last, :pwd, :tech, :role, :active)
            """,
            [
                {
                    "id": u[0],
                    "username": u[1],
                    "first": u[2],
                    "last": u[3],
                    "pwd": u[4],
                    "tech": u[5],
                    "role": u[6],
                    "active": u[7],
                }
                for u in DEFAULT_USERS
            ],
        )


def init_db() -> None:
    SQLModel.metadata.create_all(engine)
    _configure_sqlite_pragmas()
    _ensure_updated_at_column()
    _ensure_oi_lock_columns()
    _ensure_bancada_updated_at_column()
    _ensure_oi_constraints()
    _ensure_user_role_column()
    _ensure_user_is_active_column()
    _seed_default_users()
