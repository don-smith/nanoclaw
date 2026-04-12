import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getVoiceForGroup,
  synthesizeSpeech,
  checkSidecarHealth,
  startSidecar,
  stopSidecar,
  ensureSidecarRunning,
} from './tts.js';

// --- Voice Mapping ---

describe('getVoiceForGroup', () => {
  it('returns bm_fable for sid', () => {
    expect(getVoiceForGroup('sid')).toBe('bm_fable');
  });

  it('returns bf_emma for corsa', () => {
    expect(getVoiceForGroup('corsa')).toBe('bf_emma');
  });

  it('returns af_sky for paula', () => {
    expect(getVoiceForGroup('paula')).toBe('af_sky');
  });

  it('returns am_michael for brian', () => {
    expect(getVoiceForGroup('brian')).toBe('am_michael');
  });

  it('returns default voice af_heart for unknown groups', () => {
    expect(getVoiceForGroup('unknown')).toBe('af_heart');
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
