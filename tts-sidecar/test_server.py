import pytest
from httpx import ASGITransport, AsyncClient

import server
from server import app


@pytest.fixture(scope="module")
def anyio_backend():
    return "asyncio"


@pytest.fixture(scope="module", autouse=True)
async def _load_model_once():
    """Load the Kokoro model once for all tests in this module."""
    await server.load_model()
    assert server._pipeline is not None, "Kokoro model failed to load"


@pytest.mark.asyncio
async def test_health_returns_ok():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "model_loaded" in data


@pytest.mark.asyncio
async def test_synthesize_returns_ogg_audio():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.post(
            "/synthesize",
            json={"text": "Hello world.", "voice": "af_heart"},
        )
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "audio/ogg"
        # OGG files start with "OggS" magic bytes
        assert resp.content[:4] == b"OggS"
        # Should be non-trivial size (at least 1KB for a short phrase)
        assert len(resp.content) > 1024


@pytest.mark.asyncio
async def test_synthesize_empty_text_returns_400():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.post(
            "/synthesize",
            json={"text": "   ", "voice": "af_heart"},
        )
        assert resp.status_code == 400


@pytest.mark.asyncio
async def test_synthesize_uses_default_voice():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.post(
            "/synthesize",
            json={"text": "Testing default voice."},
        )
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "audio/ogg"
