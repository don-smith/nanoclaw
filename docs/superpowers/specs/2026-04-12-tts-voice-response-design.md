# TTS Voice Response for Telegram

**Date:** 2026-04-12
**Status:** Draft
**Author:** Claude (brainstormed with Don)

## Summary

Add text-to-speech voice message responses to Telegram agents. When Don includes a phrase like "format for speech" in a message, the agent responds with text as usual, and the harness follows up with a voice message generated from that text using Kokoro TTS running locally on Apple Silicon via MLX.

## Motivation

Don walks frequently and engages with agents via Telegram while mobile. Listening to a voice response is much easier than reading on a phone while walking. The feature allows him to request a spoken version of any agent response by including a trigger phrase in his message.

## Architecture Overview

Three components:

1. **TTS Sidecar** (`tts-sidecar/`) — A Python FastAPI HTTP service running Kokoro TTS with MLX for Apple Silicon GPU acceleration. Accepts text + voice ID, returns OGG Opus audio.
2. **Harness Integration** (`src/tts.ts`) — Trigger detection, voice mapping, sidecar lifecycle management, and TTS client logic in the NanoClaw Node.js harness.
3. **Telegram Channel Extension** (`src/channels/telegram.ts`) — New `sendVoice()` method to deliver audio via Telegram Bot API.

```
User sends message (text or voice note)
    |
    v
[Whisper transcription if voice note — already exists]
    |
    v
[Harness: trigger detection — scan text for "format for speech" etc.]
    |
    v  (flag set, message passed to agent UNMODIFIED)
[Agent generates text response]
    |
    v
[Harness sends text response to Telegram — normal flow]
    |
    v  (if speech flag was set)
[Harness calls sidecar: POST /synthesize {text, voice}]
    |
    v
[Sidecar: Kokoro+MLX generates WAV -> ffmpeg converts to OGG Opus]
    |
    v
[Harness sends voice message via Telegram sendVoice()]
```

## TTS Sidecar

### Location

`tts-sidecar/` at the repo root, alongside `container/` and `src/`. Self-contained Python project with its own `pyproject.toml`, managed by uv.

### API

**POST /synthesize**

Request:
```json
{
  "text": "Here's what I found about that topic...",
  "voice": "bf_emma"
}
```

Response: `audio/ogg` binary (Opus codec)

**GET /health**

Response:
```json
{
  "status": "ok",
  "model_loaded": true
}
```

### Internals

- FastAPI server bound to `127.0.0.1:7099` (localhost only)
- Loads Kokoro 82M model once at startup via MLX
- On request: generates WAV via Kokoro+MLX, pipes through ffmpeg subprocess to convert to OGG Opus, returns audio binary
- ffmpeg is a system dependency (already installed on Don's Mac)

### Dependencies

- `kokoro` (MLX variant)
- `fastapi`
- `uvicorn`
- `ffmpeg` (system)

### Tests

`test_server.py` covering:
- Health endpoint returns OK after model load
- Synthesize endpoint returns valid OGG Opus audio
- Invalid voice ID falls back to default
- Empty text returns appropriate error

## Harness Integration

### New file: `src/tts.ts`

Three responsibilities:

**1. Trigger Detection**

Scans incoming message text for the presence of the phrase "for speech" (case-insensitive substring match). This covers natural variations like:

- "format for speech"
- "format your response for speech"
- "please respond for speech"
- "format this for speech"

Returns a boolean. The match is deliberately simple — "for speech" is unlikely to appear in normal conversation outside this context.

**2. Voice Mapping**

Maps agent group folder names to Kokoro voice presets:

| Agent | Group Folder | Voice ID |
|-------|-------------|----------|
| Sid | telegram_sid | bm_fable |
| Corsa | telegram_corsa | bf_emma |
| Paula | telegram_paula | af_sky |
| Brian | telegram_brian | am_echo |
| Default | (any other) | af_heart |

**3. TTS Client**

- Calls `POST http://127.0.0.1:{port}/synthesize` with text and voice ID
- Returns audio buffer on success
- Returns null on failure (logged, error message sent to user)

### Sidecar Lifecycle Management

The harness manages the sidecar as a child process:

- **Startup:** Launches sidecar on NanoClaw startup (`python -m uvicorn ...` or `uv run ...`)
- **Health check:** Waits for `/health` to return OK (timeout: 30 seconds)
- **On-demand restart:** If health check fails before a TTS request, attempts to start/restart the sidecar
- **Shutdown:** Kills sidecar when NanoClaw stops

### Integration Point

In the message handling flow (likely `src/index.ts`):

1. When a user message arrives, run trigger detection
2. If triggered, set a flag on the message context
3. Message passes to agent unmodified
4. After agent responds and text is sent to Telegram:
   - Check sidecar health
   - Call `/synthesize` with response text + agent's voice ID
   - Send audio via `channel.sendVoice()`
   - On any failure, send error message instead

## Telegram Channel Changes

### New method on channel interface

```typescript
sendVoice(jid: string, audio: Buffer, threadId?: number): Promise<void>
```

Optional method on the channel interface — only Telegram implements it.

Implementation uses grammyjs `bot.api.sendVoice(chatId, new InputFile(audio, 'voice.ogg'))`. Extracts the correct bot instance and chat ID from the JID using the same pattern as existing `sendMessage`.

## Error Handling

Text delivery is never affected by TTS. Voice is a best-effort add-on. On any TTS failure, the harness sends a short error message to the same Telegram chat:

| Failure | Message |
|---------|---------|
| Sidecar won't start | `⚠️ TTS: Could not start the voice sidecar. Text response was delivered above.` |
| Audio conversion fails | `⚠️ TTS: Audio conversion failed. Text response was delivered above.` |
| Sidecar error or timeout | `⚠️ TTS: Voice generation failed. Text response was delivered above.` |

If the trigger phrase is not detected, nothing happens — no TTS attempt, no error message. This is expected behavior (the user simply didn't ask for voice).

## Configuration

### Environment variables (`.env`)

```
TTS_SIDECAR_PORT=7099
TTS_DEFAULT_VOICE=af_heart
```

### In code (`src/tts.ts`)

- Voice map (agent group folder → voice ID)
- Trigger phrases list
- Health check timeout (30 seconds)
- Sidecar startup command

## Scope

### In scope

- TTS sidecar with Kokoro+MLX
- Trigger phrase detection in harness
- Per-agent voice mapping (4 agents + default)
- Voice message delivery via Telegram
- Error messages on failure
- Sidecar lifecycle management
- Tests for sidecar

### Out of scope (future)

- Emoji trigger (e.g., speaker emoji)
- Retroactive voice for previous messages ("format the last message for speech")
- Chunking long responses into multiple voice messages
- Other channels (WhatsApp, Slack, etc.)
- Voice cloning or custom voice training
- Streaming TTS (send audio as it generates)

## Fallback Plan

If the Python+MLX sidecar proves too complex or unreliable, fall back to Approach 2: `kokoro-js` running directly in the Node.js harness process. This is simpler (no sidecar, single process) but CPU-only (no Apple Silicon GPU acceleration). The harness integration and Telegram changes remain the same — only the TTS generation layer changes.
