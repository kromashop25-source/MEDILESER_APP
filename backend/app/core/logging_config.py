from logging.config import dictConfig


def configure_logging() -> None:
    """
    Configura logging estructurado para la app FORMATO VI.

    - Salida por consola (stdout).
    - Formato compacto con campos clave.
    - Usa el root logger, así que logger = logging.getLogger(__name__)
      en main.py funciona sin cambios.
    """
    dictConfig(
        {
            "version": 1,
            "disable_existing_loggers": False,
            "formatters": {
                "default": {
                    "format": (
                        "%(asctime)s | %(levelname)s | %(name)s | "
                        "msg=%(message)s"
                    )
                }
            },
            "handlers": {
                "console": {
                    "class": "logging.StreamHandler",
                    "formatter": "default",
                    "level": "INFO",
                }
            },
            "root": {
                "handlers": ["console"],
                "level": "INFO",
            },
        }
    )
