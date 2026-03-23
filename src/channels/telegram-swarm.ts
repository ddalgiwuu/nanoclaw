import https from 'https';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
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
  } catch {
    await api.sendMessage(chatId, text, options);
  }
}

interface SwarmBot {
  bot: Bot;
  token: string;
  username?: string;
}

/**
 * Telegram Swarm Channel
 *
 * Creates additional grammy Bot instances from TELEGRAM_SWARM_TOKENS
 * (comma-separated list of bot tokens). Each bot can send and receive
 * messages independently, enabling Agent Teams to use different bot
 * identities.
 *
 * JID format: tgs:<chatId>:<botIndex>
 *   - tgs:123456789:0  -> first swarm bot
 *   - tgs:123456789:1  -> second swarm bot
 *
 * All swarm bots share the same message routing: inbound messages from
 * any swarm bot are delivered with a jid that encodes which bot received
 * it. Outbound messages are sent via the bot whose index is in the jid.
 */
export class TelegramSwarmChannel implements Channel {
  name = 'telegram-swarm';

  private bots: SwarmBot[] = [];
  private opts: ChannelOpts;
  private tokens: string[];

  constructor(tokens: string[], opts: ChannelOpts) {
    this.tokens = tokens;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const connectPromises = this.tokens.map(async (token, index) => {
      const bot = new Bot(token.trim(), {
        client: {
          baseFetchConfig: { agent: https.globalAgent, compress: true },
        },
      });

      const swarmBot: SwarmBot = { bot, token: token.trim() };
      this.bots[index] = swarmBot;

      // /chatid command
      bot.command('chatid', (ctx) => {
        const chatId = ctx.chat.id;
        const chatType = ctx.chat.type;
        const chatName =
          chatType === 'private'
            ? ctx.from?.first_name || 'Private'
            : (ctx.chat as any).title || 'Unknown';

        ctx.reply(
          `Chat ID: \`tgs:${chatId}:${index}\`\nName: ${chatName}\nType: ${chatType}\nSwarm bot #${index}`,
          { parse_mode: 'Markdown' },
        );
      });

      bot.command('ping', (ctx) => {
        ctx.reply(`${ASSISTANT_NAME} swarm bot #${index} is online.`);
      });

      const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

      bot.on('message:text', async (ctx) => {
        if (ctx.message.text.startsWith('/')) {
          const cmd = ctx.message.text
            .slice(1)
            .split(/[\s@]/)[0]
            .toLowerCase();
          if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
        }

        const chatJid = `tgs:${ctx.chat.id}:${index}`;
        let content = ctx.message.text;
        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName =
          ctx.from?.first_name ||
          ctx.from?.username ||
          ctx.from?.id.toString() ||
          'Unknown';
        const sender = ctx.from?.id.toString() || '';
        const msgId = ctx.message.message_id.toString();

        const chatName =
          ctx.chat.type === 'private'
            ? senderName
            : (ctx.chat as any).title || chatJid;

        // Translate @bot_username mentions into trigger format
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
          if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }

        const isGroup =
          ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          chatName,
          'telegram-swarm',
          isGroup,
        );

        const group = this.opts.registeredGroups()[chatJid];
        if (!group) {
          logger.debug(
            { chatJid, chatName, swarmIndex: index },
            'Message from unregistered Telegram swarm chat',
          );
          return;
        }

        this.opts.onMessage(chatJid, {
          id: msgId,
          chat_jid: chatJid,
          sender,
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });

        logger.info(
          { chatJid, chatName, sender: senderName, swarmIndex: index },
          'Telegram swarm message stored',
        );
      });

      // Non-text message handlers
      const storeNonText = (ctx: any, placeholder: string) => {
        const chatJid = `tgs:${ctx.chat.id}:${index}`;
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
          'telegram-swarm',
          isGroup,
        );
        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content: `${placeholder}${caption}`,
          timestamp,
          is_from_me: false,
        });
      };

      bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
      bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
      bot.on('message:voice', (ctx) =>
        storeNonText(ctx, '[Voice message]'),
      );
      bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
      bot.on('message:document', (ctx) => {
        const name = ctx.message.document?.file_name || 'file';
        storeNonText(ctx, `[Document: ${name}]`);
      });
      bot.on('message:sticker', (ctx) => {
        const emoji = ctx.message.sticker?.emoji || '';
        storeNonText(ctx, `[Sticker ${emoji}]`);
      });
      bot.on('message:location', (ctx) =>
        storeNonText(ctx, '[Location]'),
      );
      bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

      bot.catch((err) => {
        logger.error(
          { err: err.message, swarmIndex: index },
          'Telegram swarm bot error',
        );
      });

      return new Promise<void>((resolve) => {
        bot.start({
          onStart: (botInfo) => {
            swarmBot.username = botInfo.username;
            logger.info(
              {
                username: botInfo.username,
                id: botInfo.id,
                swarmIndex: index,
              },
              'Telegram swarm bot connected',
            );
            console.log(
              `  Telegram swarm bot #${index}: @${botInfo.username}`,
            );
            resolve();
          },
        });
      });
    });

    await Promise.all(connectPromises);
    console.log(
      `  Telegram swarm: ${this.bots.length} bot(s) connected\n`,
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const match = jid.match(/^tgs:(-?\d+):(\d+)$/);
    if (!match) {
      logger.warn({ jid }, 'Invalid telegram-swarm JID format');
      return;
    }

    const chatId = match[1];
    const botIndex = parseInt(match[2], 10);
    const swarmBot = this.bots[botIndex];

    if (!swarmBot) {
      logger.warn(
        { jid, botIndex, totalBots: this.bots.length },
        'Swarm bot index out of range',
      );
      return;
    }

    try {
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(swarmBot.bot.api, chatId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            swarmBot.bot.api,
            chatId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info(
        { jid, length: text.length, botIndex },
        'Telegram swarm message sent',
      );
    } catch (err) {
      logger.error({ jid, err, botIndex }, 'Failed to send swarm message');
    }
  }

  isConnected(): boolean {
    return this.bots.length > 0;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tgs:');
  }

  async disconnect(): Promise<void> {
    for (const swarmBot of this.bots) {
      swarmBot.bot.stop();
    }
    this.bots = [];
    logger.info('Telegram swarm bots stopped');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const match = jid.match(/^tgs:(-?\d+):(\d+)$/);
    if (!match) return;

    const chatId = match[1];
    const botIndex = parseInt(match[2], 10);
    const swarmBot = this.bots[botIndex];
    if (!swarmBot) return;

    try {
      await swarmBot.bot.api.sendChatAction(chatId, 'typing');
    } catch (err) {
      logger.debug(
        { jid, err },
        'Failed to send swarm typing indicator',
      );
    }
  }
}

registerChannel('telegram-swarm', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_SWARM_TOKENS']);
  const raw =
    process.env.TELEGRAM_SWARM_TOKENS ||
    envVars.TELEGRAM_SWARM_TOKENS ||
    '';
  if (!raw) {
    logger.debug(
      'Telegram Swarm: TELEGRAM_SWARM_TOKENS not set, skipping',
    );
    return null;
  }

  const tokens = raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    logger.debug('Telegram Swarm: no tokens found in TELEGRAM_SWARM_TOKENS');
    return null;
  }

  logger.info(
    { count: tokens.length },
    'Telegram Swarm: initializing with bot tokens',
  );
  return new TelegramSwarmChannel(tokens, opts);
});
