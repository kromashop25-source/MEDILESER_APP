import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app
from pathlib import Path
from openpyxl import Workbook
from openpyxl.worksheet.worksheet import Worksheet
from typing import cast

@pytest.mark.asyncio
async def test_upload_excel(tmp_path: Path):
    # crea un excel temporal
    fp = tmp_path / "a.xlsx"
    wb = Workbook()
    ws: Worksheet = cast(Worksheet,wb.active)
    ws["A1"] = "ok"
    wb.save(fp)
    wb.close()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        files = {"file": ("a.xlsx", fp.read_bytes(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
        data =  {"suggested_name": "prueba.xlsx"}
        r = await ac.post("/files/upload", files=files, data=data)
        assert r.status_code == 201
        payload = r.json()
        saved_rel = payload["relative_path"]
        assert saved_rel.startswith("data/uploads/")
        # el archivo realmente existe
        assert Path(saved_rel).exists()