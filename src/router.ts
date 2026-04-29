import { TTS_MIN_CHARS } from './config.js';
import { logger } from './logger.js';
import {
  ensureSidecarRunning,
  getVoiceForGroup,
  synthesizeSpeech,
} from './tts.js';
import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

/**
 * Send a text reply, then a voice version when the channel supports it
 * and the text is long enough to be worth listening to. The text send is
 * awaited; the voice send is fire-and-forget so a TTS hiccup never delays
 * or fails the text reply.
 */
export async function sendReplyWithVoice(
  channel: Channel,
  group: { name: string; folder: string },
  jid: string,
  text: string,
): Promise<void> {
  await channel.sendMessage(jid, text);
  if (!channel.sendVoice || text.length < TTS_MIN_CHARS) return;

  const voice = getVoiceForGroup(group.folder);
  ensureSidecarRunning()
    .then(async (ready) => {
      if (!ready) {
        logger.warn(
          { group: group.name },
          'TTS sidecar unavailable, skipping voice message',
        );
        return;
      }
      const audio = await synthesizeSpeech(text, voice);
      if (audio) {
        await channel.sendVoice!(jid, audio);
      } else {
        logger.warn(
          { group: group.name },
          'TTS synthesis failed, skipping voice message',
        );
      }
    })
    .catch((err) => {
      logger.error({ err, group: group.name }, 'TTS voice send failed');
    });
}
