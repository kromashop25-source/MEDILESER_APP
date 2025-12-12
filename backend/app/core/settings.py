import sys
from functools import lru_cache
from pathlib import Path
from typing import List
from pydantic_settings import BaseSettings


def _get_root_dir() -> Path:
    """
    Directorio base para datos externos (BD, logs) en runtime.

    - En EXE (PyInstaller):
        sys.executable -> ...\REGISTRO_VI_APP\releases\v0.X.Y\Registro_VI.exe
        root_dir       -> ...\REGISTRO_VI_APP

    - En desarrollo:
        __file__ = .../backend/app/core/settings.py
        root_dir -> .../backend
    """
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        # releases\v0.X.Y -> subimos un nivel a REGISTRO_VI_APP
        return exe_dir.parent
    # Dev: backend/
    return Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """
    Settings generales de la app FORMATO VI.

    Todas las variables se pueden sobreescribir vía .env usando el prefijo VI_, por ejemplo:
    - VI_CORS_ORIGINS
    - VI_DATA_TEMPLATE_PATH
    - VI_CELLS_PROTECTION_PASSWORD
    - VI_APP_NAME
    """

    # Nombre de la aplicación (se puede mostrar en títulos, logs, etc.)
    app_name: str = "Formato VI"

    # Orígenes permitidos para CORS (frontend React, etc.)
    cors_origins: List[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    # Ruta relativa (desde app/) a la plantilla Excel
    data_template_path: str = "data/PLANTILLA_VI.xlsx"

    # Nombre del archivo de base de datos
    database_filename: str = "vi.db"

    # Contraseña interna para proteger celdas bloqueadas y estructura del libro.
    # No se expone en la UI. Se puede sobreescribir con VI_CELLS_PROTECTION_PASSWORD
    cells_protection_password: str = "OI2025"

    class Config:
        env_prefix = "VI_"
        env_file = ".env"

    # ----------------------------
    # Rutas para PLANTILLA EXCEL
    # ----------------------------
    @property
    def template_abs_path(self) -> str:
        """Ruta absoluta de la plantilla en runtime."""
        # Intentamos obtener _MEIPASS de forma segura.
        # Si no existe (estamos en VS Code), devuelve None.
        meipass_path = getattr(sys, "_MEIPASS", None)

        if meipass_path:
            # Si existe, estamos DENTRO del EXE
            base = Path(meipass_path) / "app"
        else:
            # Si es None, estamos EN DESARROLLO (tu PC)
            base = Path(__file__).resolve().parents[1]  # .../backend/app

        return str((base / self.data_template_path).resolve())

    # ----------------------------
    # Rutas para BD y otros datos
    # ----------------------------
    @property
    def root_dir(self) -> Path:
        """Directorio raíz para datos externos (BD, logs)."""
        return _get_root_dir()

    @property
    def data_dir(self) -> Path:
        """
        Carpeta 'data' compartida entre versiones.

        - En EXE:  ...\REGISTRO_VI_APP\data
        - En dev:  ...\backend\data
        """
        data_dir = self.root_dir / "data"
        data_dir.mkdir(parents=True, exist_ok=True)
        return data_dir

    @property
    def database_url(self) -> str:
        """
        URL de conexión a SQLite usando data/vi.db en root_dir.

        Ejemplo EXE:
        sqlite:///Y:/.../REGISTRO_VI_APP/data/vi.db
        """
        db_path = self.data_dir / self.database_filename
        return f"sqlite:///{db_path.as_posix()}"


@lru_cache
def get_settings() -> Settings:
    return Settings()
