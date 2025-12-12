import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app
from pathlib import Path
from openpyxl import Workbook
from openpyxl.worksheet.worksheet import Worksheet
from typing import cast
import datetime as dt

def _make_sample(fp: Path, bad: bool = False):
    wb = Workbook()
    ws: Worksheet = cast(Worksheet, wb.active)
    ws.title = "Hoja1"
    ws.append(["ID", "Monto", "Fecha", "Nombre"])
    # Usa fechas reales para que Pandas devuelva Timestamp/Date y la regla "date" pase
    ws.append([1, 10.5, dt.date(2024, 1, 1), "Ana"])
    ws.append([2, 0.00, dt.date(2024, 5, 10), "Luis"])
    if bad:
        ws.append([3, "X", "", 123])  # tipos incorrectos: Monto:str, Fecha:vacío, Nombre:int
    wb.save(fp)   # <- ¡ejecuta el guardado!
    wb.close()    # <- ¡cierra el archivo!

@pytest.mark.asyncio
async def test_validate_ok(tmp_path: Path):
    fp = tmp_path / "ok.xlsx"
    _make_sample(fp, bad=False)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        payload = {
            "file_path": str(fp),
            "sheet": "Hoja1",
            "header_row": 1,
            "required_columns": ["ID", "Monto", "Fecha", "Nombre"],
            "type_rules": {"ID":"int", "Monto":"float", "Fecha":"date", "Nombre":"str"}
        }
        r = await ac.post("/excel/validate", json=payload)
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is True
        assert data["missing_columns"] == []
        assert data["type_violations"] == []

@pytest.mark.asyncio
async def test_validate_fail(tmp_path: Path):
    fp = tmp_path / "bad.xlsx"
    _make_sample(fp, bad=True)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        payload = {
            "file_path": str(fp),
            "sheet": "Hoja1",
            "header_row": 1,
            "required_columns": ["ID", "Monto", "Fecha", "Nombre", "Extra"],
            "type_rules": {"ID":"int", "Monto":"float", "Fecha":"date", "Nombre":"str"}
        }
        r = await ac.post("/excel/validate", json=payload)
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is False
        assert "Extra" in data["missing_columns"]
        assert len(data["type_violations"]) > 0