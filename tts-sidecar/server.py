from __future__ import annotations

import asyncio
import io
import logging
import subprocess
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

logger = logging.getLogger("nanoclaw-tts")
logging.basicConfig(level=logging.INFO)

_pipeline = None

DEFAULT_VOICE = "af_heart"
VOICE_SPEED = 1.0


class SynthesizeRequest(BaseModel):
    text: str
    voice: str = DEFAULT_VOICE


async def load_model() -> None:
    global _pipeline
    try:
        from kokoro import KPipeline
        _pipeline = KPipeline(lang_code="a")
        logger.info("Kokoro model loaded successfully")
    except Exception:
        logger.exception("Failed to load Kokoro model")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await load_model()
    yield


app = FastAPI(title="NanoClaw TTS Sidecar", lifespan=lifespan)


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "model_loaded": _pipeline is not None,
    }


def _wav_to_ogg_opus(wav_bytes: bytes) -> bytes:
    """Convert WAV audio to OGG Opus via ffmpeg subprocess."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as wav_f:
        wav_f.write(wav_bytes)
        wav_path = wav_f.name

    ogg_path = wav_path.replace(".wav", ".ogg")
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", wav_path,
                "-c:a", "libopus",
                "-b:a", "64k",
                "-ar", "24000",
                ogg_path,
            ],
            capture_output=True,
            timeout=300,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"ffmpeg failed: {result.stderr.decode(errors='replace')}"
            )
        return Path(ogg_path).read_bytes()
    finally:
        Path(wav_path).unlink(missing_ok=True)
        Path(ogg_path).unlink(missing_ok=True)


@app.post("/synthesize")
async def synthesize(req: SynthesizeRequest) -> Response:
    if _pipeline is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Text is empty")

    try:
        segments = []
        for _gs, _ps, audio in _pipeline(req.text, voice=req.voice, speed=VOICE_SPEED):
            segments.append(audio)

        if not segments:
            raise HTTPException(status_code=500, detail="No audio generated")

        full_audio = np.concatenate(segments)

        wav_buf = io.BytesIO()
        sf.write(wav_buf, full_audio, 24000, format="WAV")
        wav_bytes = wav_buf.getvalue()

        ogg_bytes = await asyncio.to_thread(_wav_to_ogg_opus, wav_bytes)

        return Response(content=ogg_bytes, media_type="audio/ogg")

    except HTTPException:
        raise
    except Exception:
        logger.exception("TTS synthesis failed")
        raise HTTPException(status_code=500, detail="Synthesis failed")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=7099)
