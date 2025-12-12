import sys
import ctypes
import win32event
import win32api
import winerror


MUTEX_NAME = "MEDILESER_FORMATO_VI_SINGLE_INSTANCE_MUTEX"
_MUTEX_HANDLE = None


def ensure_single_instance():
    """
    Evita que se ejecuten múltiples instancias de la aplicación.
    Si ya hay una instancia corriendo, este proceso termina inmediatamente.
    """
    global _MUTEX_HANDLE

    # Si ya tomamos el mutex en este proceso, no repetir.
    if _MUTEX_HANDLE:
        return

    handle = win32event.CreateMutex(None, False, MUTEX_NAME)
    last_error = win32api.GetLastError()

    if last_error == winerror.ERROR_ALREADY_EXISTS:
        ctypes.windll.user32.MessageBoxW(
            0,
            "La aplicación Registro VI ya se encuentra ejecutándose.\n"
            "Búscala en la bandeja del sistema (cerca del reloj).",
            "Registro VI",
            0x00000040,  # MB_ICONINFORMATION
        )
        sys.exit(0)

    # Mantener referencia para no liberar el mutex hasta que termine el proceso
    _MUTEX_HANDLE = handle
