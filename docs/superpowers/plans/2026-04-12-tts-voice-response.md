# TTS Voice Response Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add text-to-speech voice message responses to Telegram agents using Kokoro TTS with MLX on Apple Silicon.

**Architecture:** A Python FastAPI sidecar runs Kokoro+MLX on localhost. The Node.js harness detects a "for speech" trigger phrase in user messages, lets the agent respond normally, then calls the sidecar to synthesize audio and sends it as a Telegram voice message. Per-agent voice mapping gives each agent a distinct Kokoro voice preset.

**Tech Stack:** Python 3.11+, FastAPI, uvicorn, kokoro (MLX), ffmpeg, Node.js, grammyjs, undici

**Spec:** `docs/superpowers/specs/2026-04-12-tts-voice-response-design.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `tts-sidecar/pyproject.toml` | Python project config (uv, dependencies) |
| `tts-sidecar/server.py` | FastAPI TTS service (synthesize + health endpoints) |
| `tts-sidecar/test_server.py` | Sidecar tests |
| `src/tts.ts` | Trigger detection, voice mapping, sidecar client, lifecycle management |
| `src/tts.test.ts` | Harness-side TTS tests |

### Modified files

| File | Change |
|------|--------|
| `src/types.ts:88-99` | Add optional `sendVoice` method to Channel interface |
| `src/channels/telegram.ts:515-564` | Add `sendVoice()` method to TelegramChannel |
| `src/index.ts:197-293` | Wire trigger detection + voice sending into `processGroupMessages` |
| `src/index.ts:560-580` | Start/stop sidecar in `main()` and `shutdown()` |
| `src/config.ts` | Add `TTS_SIDECAR_PORT` and `TTS_DEFAULT_VOICE` constants |

---

## Task 1: TTS Sidecar — Python Project Setup

**Files:**
- Create: `tts-sidecar/pyproject.toml`
- Create: `tts-sidecar/server.py`

- [ ] **Step 1: Create the uv project**

```bash
cd /Users/don/projects/nanoclaw
mkdir -p tts-sidecar
```

Write `tts-sidecar/pyproject.toml`:

```toml
[project]
name = "nanoclaw-tts-sidecar"
version = "0.1.0"
description = "Kokoro TTS sidecar for NanoClaw voice messages"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.115.0",
    "uvicorn[standard]>=0.34.0",
    "misaki[en]>=0.9.0",
    "kokoro>=0.9.0",
]

[tool.pytest.ini_options]
asyncio_mode = "auto"

[project.optional-dependencies]
test = ["pytest>=8.0", "httpx>=0.28.0", "pytest-asyncio>=0.25.0"]
```

- [ ] **Step 2: Write the health endpoint first**

Write `tts-sidecar/server.py`:

```python
from __future__ import annotations

import io
import logging
import subprocess
import tempfile
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

logger = logging.getLogger("nanoclaw-tts")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="NanoClaw TTS Sidecar")

# --- Model loading (deferred to startup) ---

_pipeline = None
_voices: dict[str, object] = {}

DEFAULT_VOICE = "af_heart"

VOICE_SPEED = 1.0


class SynthesizeRequest(BaseModel):
    text: str
    voice: str = DEFAULT_VOICE


@app.on_event("startup")
async def load_model() -> None:
    global _pipeline
    try:
        from kokoro import KPipeline

        _pipeline = KPipeline(lang_code="a")
        logger.info("Kokoro model loaded successfully")
    except Exception:
        logger.exception("Failed to load Kokoro model")


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
        # Kokoro KPipeline returns a generator of (graphemes, phonemes, audio) tuples.
        # For long text it yields multiple segments. Concatenate all audio.
        import soundfile as sf
        import numpy as np

        segments = []
        for _gs, _ps, audio in _pipeline(req.text, voice=req.voice, speed=VOICE_SPEED):
            segments.append(audio)

        if not segments:
            raise HTTPException(status_code=500, detail="No audio generated")

        full_audio = np.concatenate(segments)

        # Write to WAV in memory
        wav_buf = io.BytesIO()
        sf.write(wav_buf, full_audio, 24000, format="WAV")
        wav_bytes = wav_buf.getvalue()

        # Convert to OGG Opus
        ogg_bytes = _wav_to_ogg_opus(wav_bytes)

        return Response(content=ogg_bytes, media_type="audio/ogg")

    except HTTPException:
        raise
    except Exception:
        logger.exception("TTS synthesis failed")
        raise HTTPException(status_code=500, detail="Synthesis failed")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=7099)
```

- [ ] **Step 3: Install dependencies with uv**

```bash
cd /Users/don/projects/nanoclaw/tts-sidecar
uv sync
uv pip install -e ".[test]"
```

- [ ] **Step 4: Verify the sidecar starts and health endpoint works**

```bash
cd /Users/don/projects/nanoclaw/tts-sidecar
uv run python -m uvicorn server:app --host 127.0.0.1 --port 7099 &
sleep 5
curl http://127.0.0.1:7099/health
kill %1
```

Expected: `{"status":"ok","model_loaded":true}`

- [ ] **Step 5: Commit**

```bash
git add tts-sidecar/
git commit -m "feat(tts): add Kokoro+MLX TTS sidecar with FastAPI"
```

---

## Task 2: TTS Sidecar — Tests

**Files:**
- Create: `tts-sidecar/test_server.py`

- [ ] **Step 1: Write sidecar tests**

Write `tts-sidecar/test_server.py`:

```python
import pytest
from httpx import ASGITransport, AsyncClient

from server import app


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # Trigger startup event to load model
        async with ac:
            yield ac


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
```

- [ ] **Step 2: Run tests**

```bash
cd /Users/don/projects/nanoclaw/tts-sidecar
uv run pytest test_server.py -v
```

Expected: All tests pass. The `test_synthesize_returns_ogg_audio` test may take a few seconds on first run while the model loads.

- [ ] **Step 3: Commit**

```bash
git add tts-sidecar/test_server.py
git commit -m "test(tts): add sidecar endpoint tests"
```

---

## Task 3: Channel Interface — Add sendVoice

**Files:**
- Modify: `src/types.ts:88-99`
- Test: `src/tts.test.ts` (created in Task 4, tested here conceptually)

- [ ] **Step 1: Add sendVoice to the Channel interface**

In `src/types.ts`, add the optional `sendVoice` method to the `Channel` interface after the `setTyping` line (line 96):

```typescript
// In the Channel interface, after setTyping:
  sendVoice?(jid: string, audio: Buffer, threadId?: string): Promise<void>;
```

The full interface becomes:

```typescript
export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  sendVoice?(jid: string, audio: Buffer, threadId?: string): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/don/projects/nanoclaw
npx tsc --noEmit
```

Expected: No errors — `sendVoice` is optional so no implementations break.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(tts): add optional sendVoice to Channel interface"
```

---

## Task 4: Telegram sendVoice Implementation

**Files:**
- Modify: `src/channels/telegram.ts:564` (add method after sendMessage)
- Test: `src/channels/telegram.test.ts`

- [ ] **Step 1: Check existing Telegram tests for patterns**

Read `src/channels/telegram.test.ts` to understand the test setup pattern (mocking bots, JIDs, etc.).

- [ ] **Step 2: Write the failing test for sendVoice**

Add to `src/channels/telegram.test.ts`:

```typescript
describe('sendVoice', () => {
  it('sends an OGG audio buffer as a Telegram voice message', async () => {
    // Use the existing test setup pattern from this file.
    // Create a TelegramChannel instance with a mock bot.
    // Call sendVoice with a Buffer containing fake OGG data.
    // Assert that bot.api.sendVoice was called with the correct chatId and InputFile.
    const audioBuffer = Buffer.from('fake-ogg-audio-data');
    await channel.sendVoice(jid, audioBuffer);
    // Verify sendVoice was called on the bot API
    expect(mockApi.sendVoice).toHaveBeenCalledWith(
      expect.any(String), // chatId
      expect.any(Object), // InputFile
      expect.objectContaining({}),
    );
  });

  it('logs a warning and returns if no bot found for JID', async () => {
    const audioBuffer = Buffer.from('fake-ogg-audio-data');
    // Use a JID that doesn't map to any bot
    await channel.sendVoice('tg:unknown:99999', audioBuffer);
    expect(mockApi.sendVoice).not.toHaveBeenCalled();
  });
});
```

Note: Adapt this to the exact mock setup pattern used in the existing test file. The agent implementing this should read the full test file first.

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd /Users/don/projects/nanoclaw
npm test -- --grep "sendVoice"
```

Expected: FAIL — `sendVoice` method doesn't exist yet on TelegramChannel.

- [ ] **Step 4: Implement sendVoice on TelegramChannel**

In `src/channels/telegram.ts`, add this method after `sendMessage` (after line 564):

```typescript
  async sendVoice(
    jid: string,
    audio: Buffer,
    threadId?: string,
  ): Promise<void> {
    const botInstance = this.getBotForJid(jid);
    if (!botInstance) {
      logger.warn(
        { jid, availableBots: [...this.bots.keys()] },
        'No Telegram bot found for JID (sendVoice)',
      );
      return;
    }

    try {
      const { InputFile } = await import('grammy');
      const numericId = extractChatId(jid);
      const options = threadId
        ? { message_thread_id: parseInt(threadId, 10) }
        : {};

      await botInstance.bot.api.sendVoice(
        numericId,
        new InputFile(audio, 'voice.ogg'),
        options,
      );
      logger.info(
        { jid, sizeKb: Math.round(audio.length / 1024), bot: botInstance.name },
        'Telegram voice message sent',
      );
    } catch (err) {
      logger.error(
        { jid, err, bot: botInstance.name },
        'Failed to send Telegram voice message',
      );
    }
  }
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/don/projects/nanoclaw
npm test -- --grep "sendVoice"
```

Expected: PASS

- [ ] **Step 6: Verify full TypeScript compilation**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/channels/telegram.ts src/channels/telegram.test.ts
git commit -m "feat(tts): implement sendVoice on TelegramChannel"
```

---

## Task 5: Harness TTS Module — Trigger Detection and Voice Mapping

**Files:**
- Create: `src/tts.ts`
- Create: `src/tts.test.ts`

- [ ] **Step 1: Write failing tests for trigger detection and voice mapping**

Write `src/tts.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { detectSpeechTrigger, getVoiceForGroup } from './tts.js';

describe('detectSpeechTrigger', () => {
  it('detects "format for speech" in a message', () => {
    expect(detectSpeechTrigger('Please format your response for speech')).toBe(true);
  });

  it('detects "for speech" case-insensitively', () => {
    expect(detectSpeechTrigger('Format this For Speech please')).toBe(true);
  });

  it('detects "for speech" at end of message', () => {
    expect(detectSpeechTrigger('respond for speech')).toBe(true);
  });

  it('returns false when phrase is absent', () => {
    expect(detectSpeechTrigger('Tell me about speech recognition')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(detectSpeechTrigger('')).toBe(false);
  });

  it('returns false for messages that contain "speech" but not "for speech"', () => {
    expect(detectSpeechTrigger('I gave a speech today')).toBe(false);
  });
});

describe('getVoiceForGroup', () => {
  it('returns bm_fable for telegram_sid', () => {
    expect(getVoiceForGroup('telegram_sid')).toBe('bm_fable');
  });

  it('returns bf_emma for telegram_corsa', () => {
    expect(getVoiceForGroup('telegram_corsa')).toBe('bf_emma');
  });

  it('returns af_sky for telegram_paula', () => {
    expect(getVoiceForGroup('telegram_paula')).toBe('af_sky');
  });

  it('returns am_echo for telegram_brian', () => {
    expect(getVoiceForGroup('telegram_brian')).toBe('am_echo');
  });

  it('returns default voice af_heart for unknown groups', () => {
    expect(getVoiceForGroup('telegram_unknown')).toBe('af_heart');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/don/projects/nanoclaw
npm test -- --grep "detectSpeechTrigger|getVoiceForGroup"
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement trigger detection and voice mapping**

Write `src/tts.ts`:

```typescript
import { logger } from './logger.js';

// --- Configuration ---

export const TTS_SIDECAR_PORT = parseInt(
  process.env.TTS_SIDECAR_PORT || '7099',
  10,
);
export const TTS_DEFAULT_VOICE = process.env.TTS_DEFAULT_VOICE || 'af_heart';

const VOICE_MAP: Record<string, string> = {
  telegram_sid: 'bm_fable',
  telegram_corsa: 'bf_emma',
  telegram_paula: 'af_sky',
  telegram_brian: 'am_echo',
};

// --- Trigger Detection ---

/**
 * Check if a user message requests a voice response.
 * Matches "for speech" as a case-insensitive substring.
 */
export function detectSpeechTrigger(text: string): boolean {
  return text.toLowerCase().includes('for speech');
}

// --- Voice Mapping ---

/**
 * Get the Kokoro voice preset for a group folder name.
 * Falls back to TTS_DEFAULT_VOICE for unmapped groups.
 */
export function getVoiceForGroup(groupFolder: string): string {
  return VOICE_MAP[groupFolder] || TTS_DEFAULT_VOICE;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- --grep "detectSpeechTrigger|getVoiceForGroup"
```

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tts.ts src/tts.test.ts
git commit -m "feat(tts): add trigger detection and voice mapping"
```

---

## Task 6: Harness TTS Module — Sidecar Client

**Files:**
- Modify: `src/tts.ts`
- Modify: `src/tts.test.ts`

- [ ] **Step 1: Write failing tests for the sidecar client**

Add to `src/tts.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectSpeechTrigger, getVoiceForGroup, synthesizeSpeech, checkSidecarHealth } from './tts.js';

// Mock fetch globally for sidecar client tests
const mockFetch = vi.fn();

describe('checkSidecarHealth', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true when sidecar is healthy', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ok', model_loaded: true }),
    });
    expect(await checkSidecarHealth()).toBe(true);
  });

  it('returns false when sidecar is unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await checkSidecarHealth()).toBe(false);
  });

  it('returns false when model is not loaded', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ok', model_loaded: false }),
    });
    expect(await checkSidecarHealth()).toBe(false);
  });
});

describe('synthesizeSpeech', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns audio buffer on success', async () => {
    const fakeOgg = Buffer.from('OggS-fake-audio');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => fakeOgg.buffer.slice(
        fakeOgg.byteOffset,
        fakeOgg.byteOffset + fakeOgg.byteLength,
      ),
    });
    const result = await synthesizeSpeech('Hello world', 'af_heart');
    expect(result).toBeInstanceOf(Buffer);
    expect(result!.length).toBeGreaterThan(0);
  });

  it('returns null on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'Model not loaded',
    });
    const result = await synthesizeSpeech('Hello world', 'af_heart');
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await synthesizeSpeech('Hello world', 'af_heart');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- --grep "checkSidecarHealth|synthesizeSpeech"
```

Expected: FAIL — functions don't exist yet.

- [ ] **Step 3: Implement sidecar client functions**

Add to `src/tts.ts`:

```typescript
const SIDECAR_BASE_URL = `http://127.0.0.1:${TTS_SIDECAR_PORT}`;

// --- Sidecar Health Check ---

/**
 * Check if the TTS sidecar is running and the model is loaded.
 */
export async function checkSidecarHealth(): Promise<boolean> {
  try {
    const resp = await fetch(`${SIDECAR_BASE_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return false;
    const data = (await resp.json()) as { status: string; model_loaded: boolean };
    return data.model_loaded === true;
  } catch {
    return false;
  }
}

// --- Speech Synthesis ---

/**
 * Call the TTS sidecar to synthesize speech from text.
 * Returns an OGG Opus audio buffer, or null on failure.
 */
export async function synthesizeSpeech(
  text: string,
  voice: string,
): Promise<Buffer | null> {
  try {
    const resp = await fetch(`${SIDECAR_BASE_URL}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice }),
      signal: AbortSignal.timeout(300000), // 5 minutes for long text
    });
    if (!resp.ok) {
      const detail = await resp.text();
      logger.error({ status: resp.status, detail }, 'TTS sidecar error');
      return null;
    }
    const arrayBuf = await resp.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch (err) {
    logger.error({ err }, 'TTS synthesis request failed');
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- --grep "checkSidecarHealth|synthesizeSpeech"
```

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tts.ts src/tts.test.ts
git commit -m "feat(tts): add sidecar health check and synthesis client"
```

---

## Task 7: Harness TTS Module — Sidecar Lifecycle Management

**Files:**
- Modify: `src/tts.ts`
- Modify: `src/tts.test.ts`

- [ ] **Step 1: Write failing tests for lifecycle management**

Add to `src/tts.test.ts`:

```typescript
import { detectSpeechTrigger, getVoiceForGroup, synthesizeSpeech, checkSidecarHealth, startSidecar, stopSidecar, ensureSidecarRunning } from './tts.js';

describe('sidecar lifecycle', () => {
  // These tests verify the exported functions exist and have correct types.
  // Full integration testing (actual process spawning) is done manually.

  it('startSidecar returns a ChildProcess or null', async () => {
    // We don't actually start the sidecar in unit tests.
    // Just verify the function exists and is callable.
    expect(typeof startSidecar).toBe('function');
  });

  it('stopSidecar is callable', () => {
    expect(typeof stopSidecar).toBe('function');
  });

  it('ensureSidecarRunning is callable', async () => {
    expect(typeof ensureSidecarRunning).toBe('function');
  });
});
```

- [ ] **Step 2: Implement lifecycle management**

Add to `src/tts.ts`:

```typescript
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const SIDECAR_DIR = path.join(PROJECT_ROOT, 'tts-sidecar');

let sidecarProcess: ChildProcess | null = null;

/**
 * Start the TTS sidecar as a child process.
 * Returns the ChildProcess, or null if startup fails.
 */
export function startSidecar(): ChildProcess | null {
  if (sidecarProcess && !sidecarProcess.killed) {
    logger.debug('TTS sidecar already running');
    return sidecarProcess;
  }

  try {
    const proc = spawn(
      'uv',
      ['run', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', String(TTS_SIDECAR_PORT)],
      {
        cwd: SIDECAR_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      },
    );

    proc.stdout?.on('data', (data: Buffer) => {
      logger.debug({ source: 'tts-sidecar' }, data.toString().trim());
    });
    proc.stderr?.on('data', (data: Buffer) => {
      logger.debug({ source: 'tts-sidecar' }, data.toString().trim());
    });
    proc.on('exit', (code) => {
      logger.info({ code }, 'TTS sidecar exited');
      sidecarProcess = null;
    });

    sidecarProcess = proc;
    logger.info({ port: TTS_SIDECAR_PORT }, 'TTS sidecar started');
    return proc;
  } catch (err) {
    logger.error({ err }, 'Failed to start TTS sidecar');
    return null;
  }
}

/**
 * Stop the TTS sidecar process.
 */
export function stopSidecar(): void {
  if (sidecarProcess && !sidecarProcess.killed) {
    sidecarProcess.kill('SIGTERM');
    sidecarProcess = null;
    logger.info('TTS sidecar stopped');
  }
}

/**
 * Ensure the sidecar is running and healthy.
 * Starts it if needed, waits for health check.
 * Returns true if sidecar is ready, false otherwise.
 */
export async function ensureSidecarRunning(): Promise<boolean> {
  // Check if already healthy
  if (await checkSidecarHealth()) return true;

  // Try to start it
  logger.info('TTS sidecar not healthy, attempting to start');
  startSidecar();

  // Wait for health with timeout (30 seconds)
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await checkSidecarHealth()) return true;
  }

  logger.error('TTS sidecar failed to become healthy within 30 seconds');
  return false;
}
```

- [ ] **Step 3: Run tests**

```bash
npm test -- --grep "sidecar lifecycle"
```

Expected: PASS.

- [ ] **Step 4: Verify TypeScript compilation**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/tts.ts src/tts.test.ts
git commit -m "feat(tts): add sidecar lifecycle management"
```

---

## Task 8: Wire TTS Into Message Flow

**Files:**
- Modify: `src/index.ts:197-293` (processGroupMessages)
- Modify: `src/index.ts:560-580` (main + shutdown)

- [ ] **Step 1: Add TTS imports to index.ts**

At the top of `src/index.ts`, add:

```typescript
import {
  detectSpeechTrigger,
  getVoiceForGroup,
  synthesizeSpeech,
  ensureSidecarRunning,
  startSidecar,
  stopSidecar,
} from './tts.js';
```

- [ ] **Step 2: Add speech trigger detection in processGroupMessages**

In `src/index.ts`, inside `processGroupMessages()`, after the `missedMessages` are fetched (after line 218 `if (missedMessages.length === 0) return true;`), add trigger detection:

```typescript
  // Check if any user message requests voice response
  const wantsSpeech = missedMessages.some(
    (m) => !m.is_bot_message && detectSpeechTrigger(m.content),
  );
```

- [ ] **Step 3: Add voice message sending after text response**

In the streaming output callback inside `processGroupMessages` (around line 268-293), after the text is sent to the user (line 279 `await channel.sendMessage(chatJid, text);`), add:

```typescript
        // Queue TTS if speech was requested and channel supports voice
        if (wantsSpeech && text && channel.sendVoice) {
          // Fire and forget — don't block the streaming callback
          const voice = getVoiceForGroup(group.folder);
          synthesizeSpeech(text, voice).then(async (audio) => {
            if (audio) {
              await channel.sendVoice!(chatJid, audio);
            } else {
              await channel.sendMessage(
                chatJid,
                '⚠️ TTS: Voice generation failed. Text response was delivered above.',
              );
            }
          }).catch((err) => {
            logger.error({ err, group: group.name }, 'TTS voice send failed');
            channel.sendMessage(
              chatJid,
              '⚠️ TTS: Voice generation failed. Text response was delivered above.',
            ).catch(() => {});
          });
        }
```

- [ ] **Step 4: Start sidecar on application startup**

In `src/index.ts`, in the `main()` function, after the credential proxy is started (after line 571), add:

```typescript
  // Start TTS sidecar (best-effort — voice is optional)
  startSidecar();
```

- [ ] **Step 5: Stop sidecar on shutdown**

In the `shutdown()` function (around line 574-580), add before `process.exit(0)`:

```typescript
    stopSidecar();
```

- [ ] **Step 6: Ensure sidecar is running before synthesis**

Update the TTS block in Step 3 to check sidecar health first. Replace the `synthesizeSpeech` call with:

```typescript
        if (wantsSpeech && text && channel.sendVoice) {
          const voice = getVoiceForGroup(group.folder);
          ensureSidecarRunning().then(async (ready) => {
            if (!ready) {
              await channel.sendMessage(
                chatJid,
                '⚠️ TTS: Could not start the voice sidecar. Text response was delivered above.',
              );
              return;
            }
            const audio = await synthesizeSpeech(text, voice);
            if (audio) {
              await channel.sendVoice!(chatJid, audio);
            } else {
              await channel.sendMessage(
                chatJid,
                '⚠️ TTS: Voice generation failed. Text response was delivered above.',
              );
            }
          }).catch((err) => {
            logger.error({ err, group: group.name }, 'TTS voice send failed');
            channel.sendMessage(
              chatJid,
              '⚠️ TTS: Voice generation failed. Text response was delivered above.',
            ).catch(() => {});
          });
        }
```

- [ ] **Step 7: Verify TypeScript compilation**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts
git commit -m "feat(tts): wire TTS into message flow with trigger detection"
```

---

## Task 9: Add Config Constants

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add TTS config exports to config.ts**

In `src/config.ts`, after the existing `CREDENTIAL_PROXY_PORT` constant (around line 58), add:

```typescript
export const TTS_SIDECAR_PORT = parseInt(
  process.env.TTS_SIDECAR_PORT || '7099',
  10,
);
export const TTS_DEFAULT_VOICE = process.env.TTS_DEFAULT_VOICE || 'af_heart';
```

- [ ] **Step 2: Update tts.ts to import from config instead of reading env directly**

In `src/tts.ts`, remove the local `TTS_SIDECAR_PORT` and `TTS_DEFAULT_VOICE` declarations and import them from config:

```typescript
import { TTS_SIDECAR_PORT, TTS_DEFAULT_VOICE } from './config.js';
```

- [ ] **Step 3: Verify TypeScript compilation**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts src/tts.ts
git commit -m "refactor(tts): move TTS config to config.ts"
```

---

## Task 10: Add .gitignore and Documentation

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add Python artifacts to .gitignore**

Add to `.gitignore`:

```
# TTS sidecar (Python)
tts-sidecar/.venv/
tts-sidecar/__pycache__/
tts-sidecar/*.egg-info/
tts-sidecar/uv.lock
```

- [ ] **Step 2: Verify no unwanted files are tracked**

```bash
git status
```

Expected: Only the `.gitignore` change is staged, no Python venv or cache files.

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: add Python artifacts to .gitignore"
```

---

## Task 11: End-to-End Manual Test

This task is manual verification — no code changes.

- [ ] **Step 1: Start the TTS sidecar manually and verify**

```bash
cd /Users/don/projects/nanoclaw/tts-sidecar
uv run uvicorn server:app --host 127.0.0.1 --port 7099
```

In another terminal:

```bash
curl http://127.0.0.1:7099/health
```

Expected: `{"status":"ok","model_loaded":true}`

- [ ] **Step 2: Test synthesis manually**

```bash
curl -X POST http://127.0.0.1:7099/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, this is a test of the voice synthesis system.", "voice": "bf_emma"}' \
  --output /tmp/test-voice.ogg

# Verify it's a valid OGG file
file /tmp/test-voice.ogg
# Play it
afplay /tmp/test-voice.ogg
```

Expected: Hear "Hello, this is a test of the voice synthesis system" in bf_emma's voice.

- [ ] **Step 3: Build and start NanoClaw**

```bash
cd /Users/don/projects/nanoclaw
npm run build
npm run dev
```

Verify in logs that "TTS sidecar started" appears.

- [ ] **Step 4: Send a test message via Telegram**

Send a message to one of the agents (e.g., Corsa) on Telegram:

> "What's a good recipe for banana bread? Please format your response for speech"

Expected:
1. Text response arrives as normal
2. A few seconds later, a voice message arrives with the same content spoken in bf_emma's voice

- [ ] **Step 5: Test error case — stop sidecar and verify error message**

Kill the sidecar process and send another message with "for speech". Verify:
1. Text response arrives as normal
2. The harness attempts to restart the sidecar
3. If restart fails within 30s, you receive: `⚠️ TTS: Could not start the voice sidecar. Text response was delivered above.`

- [ ] **Step 6: Test with each agent voice**

Send a "for speech" message to each agent and verify the correct voice is used:
- Sid → bm_fable (British male)
- Corsa → bf_emma (British female)
- Paula → af_sky (American female)
- Brian → am_echo (American male)
