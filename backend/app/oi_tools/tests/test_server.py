import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app
from app.config import settings
import asyncio

@pytest.mark.asyncio
async def test_health_ok():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        resp = await ac.get("/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}

@pytest.mark.asyncio
async def test_root_ok():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        resp = await ac.get("/")
        assert resp.status_code == 200
        data = resp.json()
        assert data.get("version") == settings.version
        assert "corriendo" in data.get("message", "").lower()

        