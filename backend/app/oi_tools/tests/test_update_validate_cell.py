import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app
from pathlib import Path
from openpyxl import Workbook

@pytest.mark.asyncio
async def test_update_rejects_invalid_cell(tmp_path: Path):
    fp = tmp_path / "b.xlsx"
    from openpyxl import Workbook
    wb = Workbook()
    wb.save(fp)
    wb.close()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        payload = {
            "file_path": str(fp),
            "edits": [{"sheet": "Sheet", "cell": "B0", "value": "x"}],  # fila 0 no válida
            "save_mode": "same_password"
        }
        r = await ac.post("/excel/update", json=payload)
        assert r.status_code == 400
        assert "Celda inválida" in r.json()["detail"]
