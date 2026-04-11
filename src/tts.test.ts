import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectSpeechTrigger,
  getVoiceForGroup,
  synthesizeSpeech,
  checkSidecarHealth,
  startSidecar,
  stopSidecar,
  ensureSidecarRunning,
} from './tts.js';

// --- Trigger Detection ---

describe('detectSpeechTrigger', () => {
  it('detects "format for speech" in a message', () => {
    expect(
      detectSpeechTrigger('Please format your response for speech'),
    ).toBe(true);
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

// --- Voice Mapping ---

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

// --- Sidecar Client ---

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
      arrayBuffer: async () =>
        fakeOgg.buffer.slice(
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

// --- Sidecar Lifecycle ---

describe('sidecar lifecycle', () => {
  it('startSidecar is callable', () => {
    expect(typeof startSidecar).toBe('function');
  });

  it('stopSidecar is callable', () => {
    expect(typeof stopSidecar).toBe('function');
  });

  it('ensureSidecarRunning is callable', () => {
    expect(typeof ensureSidecarRunning).toBe('function');
  });
});
