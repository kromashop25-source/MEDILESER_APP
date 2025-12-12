# app/services/excel_styles.py
from __future__ import annotations
from copy import copy
from openpyxl.cell import Cell


def copy_style(src: Cell, dst: Cell, copy_number_format: bool = True) -> None:
    """
    Copia estilos visibles de celda a celda.
    Se clonan los componentes para evitar referencias compartidas o proxies.
    """
    if not src.has_style:
        return

    # Pylance a veces marca estos setters; forzamos ignorar el false positive
    dst.font = copy(src.font)            # type: ignore[assignment]
    dst.fill = copy(src.fill)            # type: ignore[assignment]
    dst.border = copy(src.border)        # type: ignore[assignment]
    dst.alignment = copy(src.alignment)  # type: ignore[assignment]

    if copy_number_format:
        dst.number_format = src.number_format
