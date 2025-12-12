import logging
import os
import socket
import sys
import threading
import time
import webbrowser
from functools import partial
from pathlib import Path

import pystray
import uvicorn
from PIL import Image

from app.main import app
from single_instance import ensure_single_instance


SERVER_HOST = "127.0.0.1"
DEFAULT_PORT = 8000


def _get_paths() -> tuple[Path, Path]:
    """
    Returns (bundle_dir, base_dir):
    - bundle_dir: PyInstaller temp dir with bundled assets.
    - base_dir: folder where the exe lives (for logs, db, etc.).
    """
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        bundle_dir = Path(sys._MEIPASS)  # type: ignore[attr-defined]
        base_dir = Path(sys.executable).resolve().parent
    else:
        bundle_dir = Path(__file__).resolve().parent
        base_dir = bundle_dir
    return bundle_dir, base_dir


_BUNDLE_DIR, _BASE_DIR = _get_paths()
LOG_PATH = _BASE_DIR / "vi_backend.log"

# File-only logging (no console; avoids issues with --noconsole)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[logging.FileHandler(LOG_PATH, encoding="utf-8")],
    force=True,
)
logger = logging.getLogger(__name__)


def _is_port_available(host: str, port: int) -> bool:
    """Check if TCP port is free on the given host."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((host, port)) != 0


def choose_port(host: str, preferred: int) -> int:
    """
    Try to use `preferred`; if it's busy, pick a random free port.
    """
    if _is_port_available(host, preferred):
        return preferred

    logger.warning("Port %s is in use. Looking for a free port...", preferred)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        _, fallback_port = sock.getsockname()

    logger.info("Selected fallback port %s", fallback_port)
    return int(fallback_port)


def run_server_thread(host: str, port: int) -> None:
    """Run Uvicorn in a background thread."""
    try:
        uvicorn.run(
            app,
            host=host,
            port=port,
            log_level="info",
            access_log=False,
            log_config=None,  # do not reconfigure logging; avoids isatty errors
        )
    except Exception:
        logger.exception("Fatal error while running Uvicorn")


def open_browser_delayed(url: str) -> None:
    """Wait a bit for the server to start, then open the browser."""
    time.sleep(2)
    webbrowser.open(url)


def on_exit(icon, _item):
    logger.info("Closing app from tray menu")
    icon.stop()
    os._exit(0)


def on_open(_icon, _item, url: str):
    webbrowser.open(url)


def main() -> None:
    ensure_single_instance()
    logger.info("Starting Registro VI...")

    port = choose_port(SERVER_HOST, DEFAULT_PORT)
    frontend_url = f"http://{SERVER_HOST}:{port}/"
    logger.info("Using backend at %s", frontend_url)

    icon_path = _BUNDLE_DIR / "icon_vi.ico"
    if not icon_path.exists():
        logger.error("Icon not found at %s", icon_path)
        threading.Thread(target=run_server_thread, args=(SERVER_HOST, port), daemon=True).start()
        return

    try:
        image = Image.open(str(icon_path))
    except Exception:
        logger.exception("Error opening tray icon image")
        return

    open_browser = partial(open_browser_delayed, frontend_url)
    tray_icon_open = partial(on_open, url=frontend_url)

    menu = pystray.Menu(
        pystray.MenuItem("Abrir Registro VI", tray_icon_open, default=True),
        pystray.MenuItem("Salir", on_exit),
    )

    tray_icon = pystray.Icon("registro_vi", image, "Registro VI", menu)

    server_thread = threading.Thread(target=run_server_thread, args=(SERVER_HOST, port), daemon=True)
    server_thread.start()

    threading.Thread(target=open_browser, daemon=True).start()

    logger.info("Running system tray...")
    tray_icon.run()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        logger.exception("Unhandled error in main")
