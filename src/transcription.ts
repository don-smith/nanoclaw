import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { ProxyAgent } from 'undici';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

// Build undici ProxyAgent for media downloads through the firewall proxy
const proxyUrl =
  process.env.https_proxy ||
  process.env.HTTPS_PROXY ||
  process.env.http_proxy ||
  process.env.HTTP_PROXY;
const mediaDispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

interface TranscriptionConfig {
  model: string;
  enabled: boolean;
  fallbackMessage: string;
}

const DEFAULT_CONFIG: TranscriptionConfig = {
  model: 'whisper-1',
  enabled: true,
  fallbackMessage: '[Voice Message - transcription unavailable]',
};

/**
 * Transcribe an audio buffer using OpenAI's Whisper API.
 * Channel-agnostic — works with any audio source.
 */
export async function transcribeBuffer(
  audioBuffer: Buffer,
): Promise<string | null> {
  const config = DEFAULT_CONFIG;
  if (!config.enabled) return config.fallbackMessage;

  const env = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = env.OPENAI_API_KEY;

  if (!apiKey) {
    logger.warn(
      'OPENAI_API_KEY not set in .env — voice transcription disabled',
    );
    return null;
  }

  try {
    const openaiModule = await import('openai');
    const OpenAI = openaiModule.default;
    const toFile = openaiModule.toFile;

    const openai = new OpenAI({
      apiKey,
      fetch: (mediaDispatcher
        ? (url: any, init?: any) =>
            fetch(url, { ...init, dispatcher: mediaDispatcher } as any)
        : undefined) as any,
    });

    const file = await toFile(audioBuffer, 'voice.ogg', {
      type: 'audio/ogg',
    });

    const transcription = await openai.audio.transcriptions.create({
      file: file,
      model: config.model,
      response_format: 'text',
    });

    // When response_format is 'text', the API returns a plain string
    return (transcription as unknown as string)?.trim() || null;
  } catch (err) {
    logger.error({ err }, 'OpenAI transcription failed');
    return null;
  }
}

export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket,
): Promise<string | null> {
  const config = DEFAULT_CONFIG;

  if (!config.enabled) {
    return config.fallbackMessage;
  }

  try {
    const buffer = (await downloadMediaMessage(
      msg,
      'buffer',
      { options: { dispatcher: mediaDispatcher as any } as any },
      {
        logger: console as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    if (!buffer || buffer.length === 0) {
      logger.error('Failed to download audio message');
      return config.fallbackMessage;
    }

    logger.info({ bytes: buffer.length }, 'Downloaded audio message');

    const transcript = await transcribeBuffer(buffer);

    if (!transcript) {
      return config.fallbackMessage;
    }

    return transcript;
  } catch (err) {
    logger.error({ err }, 'Transcription error');
    return config.fallbackMessage;
  }
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
