import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import { TTS_SIDECAR_PORT, TTS_DEFAULT_VOICE } from './config.js';
import { logger } from './logger.js';

// --- Voice Mapping ---

const VOICE_MAP: Record<string, string> = {
  sid: 'bm_fable', // British male, grade C
  corsa: 'bf_emma', // British female, grade B-
  paula: 'af_sky', // American female, grade B
  brian: 'am_michael', // American male, grade C+
};

/**
 * Get the Kokoro voice preset for a group folder name.
 * Falls back to TTS_DEFAULT_VOICE for unmapped groups.
 */
export function getVoiceForGroup(groupFolder: string): string {
  return VOICE_MAP[groupFolder] || TTS_DEFAULT_VOICE;
}

// --- Sidecar Client ---

const SIDECAR_BASE_URL = `http://127.0.0.1:${TTS_SIDECAR_PORT}`;

/**
 * Check if the TTS sidecar is running and the model is loaded.
 */
export async function checkSidecarHealth(): Promise<boolean> {
  try {
    const resp = await fetch(`${SIDECAR_BASE_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return false;
    const data = (await resp.json()) as {
      status: string;
      model_loaded: boolean;
    };
    return data.model_loaded === true;
  } catch {
    return false;
  }
}

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

// --- Sidecar Lifecycle ---

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
      [
        'run',
        'uvicorn',
        'server:app',
        '--host',
        '127.0.0.1',
        '--port',
        String(TTS_SIDECAR_PORT),
      ],
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
  if (await checkSidecarHealth()) return true;

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
