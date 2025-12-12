from httpx import AsyncClient, ASGITransport
from app.main import app

import pytest

@pytest.mark.asyncio
async def test_version_endpoint():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        r = await ac.get("/version")
        assert r.status_code == 200
        assert "version" in r.json()
