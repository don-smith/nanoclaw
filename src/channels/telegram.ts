import fs from 'fs';
import https from 'https';
import path from 'path';

import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFileByPrefix } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { getTriggerPattern } from '../config.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface BotInstance {
  bot: Bot;
  name: string; // e.g., "sid" — derived from env var suffix
  token: string;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

/**
 * Extract the bot name from a group folder.
 * Supports both channel-prefixed ("telegram_sid" → "sid") and
 * channel-agnostic ("sid" → "sid") folder names.
 */
function folderToBotName(folder: string): string {
  if (folder.startsWith('telegram_')) return folder.slice('telegram_'.length).toLowerCase();
  if (folder.startsWith('whatsapp_')) return folder.slice('whatsapp_'.length).toLowerCase();
  return folder.toLowerCase();
}

/**
 * Build a JID for a Telegram chat. In multi-bot mode, private chats share the
 * same numeric chat ID (the user's Telegram ID) across all bots, so we embed
 * the bot name to make each JID unique: `tg:<botName>:<chatId>`.
 */
function buildTgJid(botName: string, chatId: number | string): string {
  return `tg:${botName}:${chatId}`;
}

/**
 * Extract the numeric Telegram chat ID from a JID.
 * Handles both `tg:<botName>:<chatId>` and legacy `tg:<chatId>`.
 */
function extractChatId(jid: string): string {
  const parts = jid.replace(/^tg:/, '').split(':');
  return parts[parts.length - 1];
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bots: Map<string, BotInstance> = new Map(); // botName → instance
  private opts: TelegramChannelOpts;
  private botTokens: Map<string, string>; // botName → token

  constructor(botTokens: Map<string, string>, opts: TelegramChannelOpts) {
    this.botTokens = botTokens;
    this.opts = opts;
  }

  /**
   * Find which bot instance should handle a given JID.
   * Looks up the registered group's folder name to determine the bot.
   */
  private getBotForJid(jid: string): BotInstance | undefined {
    const group = this.opts.registeredGroups()[jid];
    if (group) {
      const botName = folderToBotName(group.folder);
      if (this.bots.has(botName)) {
        return this.bots.get(botName);
      }
    }
    // Fallback: if there's only one bot, use it
    if (this.bots.size === 1) {
      return this.bots.values().next().value;
    }
    return undefined;
  }

  /**
   * Download a Telegram file to the group's attachments directory.
   * Returns the container-relative path (e.g. /workspace/group/attachments/photo_123.jpg)
   * or null if the download fails.
   */
  private async downloadFile(
    botInstance: BotInstance,
    fileId: string,
    groupFolder: string,
    filename: string,
  ): Promise<string | null> {
    try {
      const file = await botInstance.bot.api.getFile(fileId);
      if (!file.file_path) {
        logger.warn({ fileId }, 'Telegram getFile returned no file_path');
        return null;
      }

      const groupDir = resolveGroupFolderPath(groupFolder);
      const attachDir = path.join(groupDir, 'attachments');
      fs.mkdirSync(attachDir, { recursive: true });

      // Sanitize filename and add extension from Telegram's file_path if missing
      const tgExt = path.extname(file.file_path);
      const localExt = path.extname(filename);
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const finalName = localExt ? safeName : `${safeName}${tgExt}`;
      const destPath = path.join(attachDir, finalName);

      const fileUrl = `https://api.telegram.org/file/bot${botInstance.token}/${file.file_path}`;
      const resp = await fetch(fileUrl);
      if (!resp.ok) {
        logger.warn(
          { fileId, status: resp.status },
          'Telegram file download failed',
        );
        return null;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(destPath, buffer);

      logger.info({ fileId, dest: destPath }, 'Telegram file downloaded');
      return `/workspace/group/attachments/${finalName}`;
    } catch (err) {
      logger.error({ fileId, err }, 'Failed to download Telegram file');
      return null;
    }
  }

  /**
   * Set up message handlers for a bot instance.
   */
  private setupBotHandlers(instance: BotInstance): void {
    const { bot, name: botName } = instance;

    // Command to get chat ID (useful for registration)
    bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatJid = buildTgJid(botName, chatId);
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`${chatJid}\`\nBot: ${botName}\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    bot.command('ping', (ctx) => {
      const chatJid = buildTgJid(botName, ctx.chat.id);
      const group = this.opts.registeredGroups()[chatJid];
      const agentName = group?.assistantName || ASSISTANT_NAME;
      ctx.reply(`${agentName} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = buildTgJid(botName, ctx.chat.id);
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const threadId = ctx.message.message_thread_id;

      const replyTo = ctx.message.reply_to_message;
      const replyToMessageId = replyTo?.message_id?.toString();
      const replyToContent = replyTo?.text || replyTo?.caption;
      const replyToSenderName = replyTo
        ? replyTo.from?.first_name ||
          replyTo.from?.username ||
          replyTo.from?.id?.toString() ||
          'Unknown'
        : undefined;

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into trigger format.
      // Use per-group trigger pattern and assistant name.
      const group = this.opts.registeredGroups()[chatJid];
      const groupAssistantName = group?.assistantName || ASSISTANT_NAME;
      const triggerPattern = getTriggerPattern(group?.trigger);

      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !triggerPattern.test(content)) {
          content = `@${groupAssistantName} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      if (!group) {
        logger.debug(
          { chatJid, chatName, bot: botName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: threadId ? threadId.toString() : undefined,
        reply_to_message_id: replyToMessageId,
        reply_to_message_content: replyToContent,
        reply_to_sender_name: replyToSenderName,
      });

      logger.info(
        { chatJid, chatName, sender: senderName, bot: botName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages: download files when possible, fall back to placeholders.
    const storeMedia = (
      ctx: any,
      placeholder: string,
      opts?: { fileId?: string; filename?: string },
    ) => {
      const chatJid = buildTgJid(botName, ctx.chat.id);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      const deliver = (content: string) => {
        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });
      };

      // If we have a file_id, attempt to download; deliver asynchronously
      if (opts?.fileId) {
        const msgId = ctx.message.message_id.toString();
        const filename =
          opts.filename ||
          `${placeholder.replace(/[\[\] ]/g, '').toLowerCase()}_${msgId}`;
        this.downloadFile(instance, opts.fileId, group.folder, filename).then(
          (filePath) => {
            if (filePath) {
              deliver(`${placeholder} (${filePath})${caption}`);
            } else {
              deliver(`${placeholder}${caption}`);
            }
          },
        );
        return;
      }

      deliver(`${placeholder}${caption}`);
    };

    bot.on('message:photo', (ctx) => {
      // Telegram sends multiple sizes; last is largest
      const photos = ctx.message.photo;
      const largest = photos?.[photos.length - 1];
      storeMedia(ctx, '[Photo]', {
        fileId: largest?.file_id,
        filename: `photo_${ctx.message.message_id}`,
      });
    });
    bot.on('message:video', (ctx) => {
      storeMedia(ctx, '[Video]', {
        fileId: ctx.message.video?.file_id,
        filename: `video_${ctx.message.message_id}`,
      });
    });
    bot.on('message:voice', (ctx) => {
      storeMedia(ctx, '[Voice message]', {
        fileId: ctx.message.voice?.file_id,
        filename: `voice_${ctx.message.message_id}`,
      });
    });
    bot.on('message:audio', (ctx) => {
      const name =
        ctx.message.audio?.file_name || `audio_${ctx.message.message_id}`;
      storeMedia(ctx, '[Audio]', {
        fileId: ctx.message.audio?.file_id,
        filename: name,
      });
    });
    bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeMedia(ctx, `[Document: ${name}]`, {
        fileId: ctx.message.document?.file_id,
        filename: name,
      });
    });
    bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeMedia(ctx, `[Sticker ${emoji}]`);
    });
    bot.on('message:location', (ctx) => storeMedia(ctx, '[Location]'));
    bot.on('message:contact', (ctx) => storeMedia(ctx, '[Contact]'));

    // Handle errors gracefully
    bot.catch((err) => {
      logger.error({ err: err.message, bot: botName }, 'Telegram bot error');
    });
  }

  async connect(): Promise<void> {
    const startPromises: Promise<void>[] = [];

    for (const [botName, token] of this.botTokens) {
      const bot = new Bot(token, {
        client: {
          baseFetchConfig: { agent: https.globalAgent, compress: true },
        },
      });

      const instance: BotInstance = { bot, name: botName, token };
      this.bots.set(botName, instance);

      this.setupBotHandlers(instance);

      // Start polling — collect promises so we await all
      const startPromise = new Promise<void>((resolve) => {
        bot.start({
          onStart: (botInfo) => {
            logger.info(
              { username: botInfo.username, id: botInfo.id, bot: botName },
              'Telegram bot connected',
            );
            console.log(`  Telegram bot [${botName}]: @${botInfo.username}`);
            resolve();
          },
        });
      });

      startPromises.push(startPromise);
    }

    await Promise.all(startPromises);
    if (this.bots.size > 0) {
      console.log(
        `  Send /chatid to any bot to get a chat's registration ID\n`,
      );
    }
  }

  async sendMessage(
    jid: string,
    text: string,
    threadId?: string,
  ): Promise<void> {
    const botInstance = this.getBotForJid(jid);
    if (!botInstance) {
      logger.warn(
        { jid, availableBots: [...this.bots.keys()] },
        'No Telegram bot found for JID',
      );
      return;
    }

    try {
      const numericId = extractChatId(jid);
      const options = threadId
        ? { message_thread_id: parseInt(threadId, 10) }
        : {};

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(
          botInstance.bot.api,
          numericId,
          text,
          options,
        );
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            botInstance.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
            options,
          );
        }
      }
      logger.info(
        { jid, length: text.length, threadId, bot: botInstance.name },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error(
        { jid, err, bot: botInstance.name },
        'Failed to send Telegram message',
      );
    }
  }

  isConnected(): boolean {
    return this.bots.size > 0;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    for (const [name, instance] of this.bots) {
      instance.bot.stop();
      logger.info({ bot: name }, 'Telegram bot stopped');
    }
    this.bots.clear();
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const botInstance = this.getBotForJid(jid);
    if (!botInstance) return;
    try {
      const numericId = extractChatId(jid);
      await botInstance.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  // Collect all bot tokens from env vars.
  // Convention: TELEGRAM_BOT_TOKEN_<NAME> where NAME maps to folder telegram_<name>
  // Also supports the legacy single-bot TELEGRAM_BOT_TOKEN.
  const envTokens = readEnvFileByPrefix('TELEGRAM_BOT_TOKEN');
  const botTokens = new Map<string, string>();

  for (const [key, value] of Object.entries(envTokens)) {
    const envValue = process.env[key] || value;
    if (!envValue) continue;

    if (key === 'TELEGRAM_BOT_TOKEN') {
      // Legacy single-token: use 'default' as bot name
      if (!botTokens.has('default')) {
        botTokens.set('default', envValue);
      }
    } else {
      // TELEGRAM_BOT_TOKEN_SID → botName "sid"
      const suffix = key.slice('TELEGRAM_BOT_TOKEN_'.length).toLowerCase();
      if (suffix) {
        botTokens.set(suffix, envValue);
      }
    }
  }

  if (botTokens.size === 0) {
    logger.warn('Telegram: no TELEGRAM_BOT_TOKEN* vars set');
    return null;
  }

  logger.info(
    { bots: [...botTokens.keys()] },
    `Telegram: ${botTokens.size} bot(s) configured`,
  );

  return new TelegramChannel(botTokens, opts);
});
