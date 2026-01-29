import sys
from functools import lru_cache
from pathlib import Path
from typing import Optional
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

    # LOG-02: raíces permitidas para el "explorador" de carpetas.
    # Seguridad: el usuario podrá navegador dentro de esas rutas.
    # Sugerencia: configurar vía VI_LOG02_UNC_ROOTS como JSON:
    # VI_LOG02_UNC_ROOTS=["\\\\192.168.1.237\\data\\MEDILESER_APP","\\\\SERVIDOR\\Compartido\\Certificados"]
    log02_unc_roots: List[str] = []

    # ===========================================
    # LOG-02 (PB-LOG-021): handering I/O copiado
    # ===========================================
    # Intentos máximos por archivo al copiar (reintentos controlados antes locks/PermissionError).
    log02_copy_max_attempts: int = 5
    # Backoff base (ms) y máximo (ms) entre reintentos
    log02_copy_retry_base_ms: int = 200
    log02_copy_retry_max_ms: int = 2000
    # Umbral para marcar copias "lentas" (ms) en auditoría
    log02_copy_slow_ms: int = 3000
    # Ruta relativa (desde app/) a la plantilla Excel
    # Nota: el template vive en app/data/templates/vi/
    data_template_path: str = "data/templates/vi/PLANTILLA_VI.xlsx"

    # Plantilla LOG-01 (Logística)
    log01_template_path: str = "data/templates/logistica/LOG01_PLANTILLA_SALIDA.xlsx"


    # Nombre del archivo de base de datos
    database_filename: str = "vi.db"

    # URL opcional para BD (ej: MySQL). Se lee desde VI_DATABASE_URL
    database_url: str | None = None

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

        # Prioridad:
        # 1) VI_DATA_TEMPLATE_PATH (si existe)
        # 2) ruta estándar en repo (data/templates/vi/PLANTILLA_VI.xlsx)
        # 3) ruta legacy (data/PLANTILLA_VI.xlsx)
        candidates = [
            (base / self.data_template_path),
            (base / "data" / "templates" / "vi" / "PLANTILLA_VI.xlsx"),
            (base / "data" / "PLANTILLA_VI.xlsx"),
        ]
        for cand in candidates:
            if cand.exists():
                return str(cand.resolve())

        # Si no existe ninguna, devolvemos la primera para mantener el fallback actual
        # (el servicio de Excel creará un workbook vacío).
        return str(candidates[0].resolve())
    
    @property
    def log01_template_abs_path(self) -> str:
        """Ruta absoluta de la plantilla LOG-01 en runtime."""
        meipass_path = getattr(sys, "_MEIPASS", None)
        if meipass_path:
            base = Path(meipass_path) / "app"
        else:
            base = Path(__file__).resolve().parents[1]  # .../backend/app

        # Permite override con VI_LOG01_TEMPLATE_PATH
        candidates = [
            (base / self.log01_template_path),
            (base / "data" / "templates" / "logistica" / "LOG01_PLANTILLA_SALIDA.xlsx"),
            (base / "data" / "LOG01_PLANTILLA_SALIDA.xlsx"),  # legacy si existiera
        ]
        for p in candidates:
            if p.exists():
                return str(p.resolve())

        raise FileNotFoundError(
            "No se encontró LOG01_PLANTILLA_SALIDA.xlsx. "
            f"Revisar VI_LOG01_TEMPLATE_PATH o colocarla en {candidates[0]}"
        )


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
    def database_url_resolved(self) -> str:
        """
        URL de conexión a la base de datos.
        - Si VI_DATABASE_URL está definido, se usa tal cual.
        - Si no, se usa SQLite (data/vi.db) como fallback.
        """
        if self.database_url:
            return self.database_url

        db_path = self.data_dir / self.database_filename
        return f"sqlite:///{db_path.as_posix()}"



@lru_cache
def get_settings() -> Settings:
    return Settings()
