import {
  Client,
  GatewayIntentBits,
  TextChannel,
  Message,
  ChannelType,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { getRegisteredAgentTypesForJid } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// Support dual-bot setup: DISCORD_BOT_TOKEN for default,
// DISCORD_CLAUDE_TOKEN / DISCORD_CODEX_TOKEN for agent-specific
const agentType = process.env.NANOCLAW_AGENT_TYPE || 'claude-code';
const envFile = readEnvFile([
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLAUDE_TOKEN',
  'DISCORD_CODEX_TOKEN',
]);

function getDiscordToken(): string | undefined {
  // Agent-specific token takes priority
  if (agentType === 'codex') {
    return (
      process.env.DISCORD_CODEX_TOKEN ||
      envFile.DISCORD_CODEX_TOKEN ||
      process.env.DISCORD_BOT_TOKEN ||
      envFile.DISCORD_BOT_TOKEN
    );
  }
  return (
    process.env.DISCORD_CLAUDE_TOKEN ||
    envFile.DISCORD_CLAUDE_TOKEN ||
    process.env.DISCORD_BOT_TOKEN ||
    envFile.DISCORD_BOT_TOKEN
  );
}

const DISCORD_TOKEN = getDiscordToken();

registerChannel('discord', (opts: ChannelOpts): Channel | null => {
  if (!DISCORD_TOKEN) {
    return null;
  }
  // Only activate Discord in dedicated Discord processes (NANOCLAW_CHANNEL=discord)
  // This prevents the main Telegram process from also connecting to Discord
  const channelFilter = process.env.NANOCLAW_CHANNEL;
  if (channelFilter && channelFilter !== 'discord') {
    return null;
  }
  if (!channelFilter) {
    // No filter set — skip Discord to avoid conflict with dedicated Discord processes
    logger.info(
      'Discord: skipping (no NANOCLAW_CHANNEL set, use dedicated process)',
    );
    return null;
  }
  return new DiscordChannel(opts);
});

class DiscordChannel implements Channel {
  name = 'discord';
  private client: Client;
  private opts: ChannelOpts;
  private typingIntervals: Map<string, ReturnType<typeof setInterval>> =
    new Map();
  private lastMessageIds: Map<string, string> = new Map();

  constructor(opts: ChannelOpts) {
    this.opts = opts;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });
  }

  async connect(): Promise<void> {
    this.client.on('messageCreate', async (msg: Message) => {
      // Ignore bot messages (prevents self-loop)
      // But in paired rooms we might want other bot's messages — handled at DB level
      if (msg.author.id === this.client.user?.id) return;

      const jid = this.messageToJid(msg);

      // Only process channels registered for THIS agent type
      // Claude process only handles claude-code channels, Codex only handles codex channels
      if (!this.isRegisteredForMyAgentType(jid)) {
        const baseJid = `discord:${msg.channelId}`;
        if (!this.isRegisteredForMyAgentType(baseJid)) {
          return;
        }
      }

      const effectiveJid = this.opts.registeredGroups()[jid]
        ? jid
        : `discord:${msg.channelId}`;

      // Translate @bot mentions to trigger pattern
      let content = msg.content;
      const botId = this.client.user?.id;
      if (botId && content.includes(`<@${botId}>`)) {
        content = content.replace(`<@${botId}>`, `@${ASSISTANT_NAME}`).trim();
        if (!TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // If this is a Discord reply, fetch the referenced message and prepend as quoted context
      if (msg.reference?.messageId) {
        try {
          const referenced = await msg.fetchReference();
          const refAuthor =
            referenced.member?.displayName ||
            referenced.author.displayName ||
            referenced.author.username;
          const refContent = referenced.content || '(no text content)';
          // Prepend referenced message as quoted context so the agent sees what's being replied to
          content = `[답장 대상 — ${refAuthor}]:\n> ${refContent.replace(/\n/g, '\n> ')}\n\n${content}`;
        } catch (err) {
          logger.debug({ err, refId: msg.reference.messageId }, 'Failed to fetch referenced message');
        }
      }

      const timestamp = msg.createdAt.toISOString();
      const senderName =
        msg.member?.displayName ||
        msg.author.displayName ||
        msg.author.username;
      const sender = msg.author.id;
      const msgId = msg.id;

      const channelName =
        msg.channel.type === ChannelType.GuildText
          ? (msg.channel as TextChannel).name
          : msg.channel.type === ChannelType.PublicThread ||
              msg.channel.type === ChannelType.PrivateThread
            ? msg.channel.name
            : 'unknown';

      // Track last message ID for reactions
      this.lastMessageIds.set(effectiveJid, msgId);

      // Chat metadata
      this.opts.onChatMetadata(
        effectiveJid,
        timestamp,
        channelName,
        'discord',
        !msg.channel.isDMBased(),
      );

      // Deliver message
      this.opts.onMessage(effectiveJid, {
        id: msgId,
        chat_jid: effectiveJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        is_bot_message:
          msg.author.bot && msg.author.id !== this.client.user?.id,
      });

      logger.info(
        { jid: effectiveJid, channelName, sender: senderName },
        'Discord message stored',
      );
    });

    this.client.on('ready', () => {
      logger.info(
        { username: this.client.user?.tag, id: this.client.user?.id },
        'Discord bot connected',
      );
    });

    await this.client.login(DISCORD_TOKEN);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = this.jidToChannelId(jid);
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        const chunks = this.splitMessage(text, 2000);
        for (const chunk of chunks) {
          await (channel as TextChannel).send(chunk);
        }
      }
    } catch (err) {
      logger.error({ jid, channelId, err }, 'Discord sendMessage failed');
    }
  }

  async sendAndTrack(jid: string, text: string): Promise<string | null> {
    const channelId = this.jidToChannelId(jid);
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        const msg = await (channel as TextChannel).send(text);
        return msg.id;
      }
    } catch (err) {
      logger.error({ jid, channelId, err }, 'Discord sendAndTrack failed');
    }
    return null;
  }

  async editMessageById(
    jid: string,
    messageId: string,
    newText: string,
  ): Promise<void> {
    const channelId = this.jidToChannelId(jid);
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        const msg = await (channel as TextChannel).messages.fetch(messageId);
        await msg.edit(newText);
      }
    } catch (err) {
      logger.error(
        { jid, channelId, messageId, err },
        'Discord editMessageById failed',
      );
      throw err;
    }
  }

  async sendReaction(
    jid: string,
    messageKey: { id: string; remoteJid: string; fromMe?: boolean },
    emoji: string,
  ): Promise<void> {
    const channelId = this.jidToChannelId(jid);
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        const msg = await (channel as TextChannel).messages.fetch(
          messageKey.id,
        );
        await msg.react(emoji);
      }
    } catch (err) {
      logger.error(
        { jid, messageId: messageKey.id, emoji, err },
        'Discord sendReaction failed',
      );
    }
  }

  async reactToLatestMessage(jid: string, emoji: string): Promise<void> {
    const lastMsgId = this.lastMessageIds.get(jid);
    if (!lastMsgId) {
      logger.debug({ jid }, 'No last message ID to react to');
      return;
    }
    await this.sendReaction(jid, { id: lastMsgId, remoteJid: jid }, emoji);
  }

  isConnected(): boolean {
    return this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('discord:');
  }

  async disconnect(): Promise<void> {
    // Clear all typing intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    this.client.destroy();
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    // Clear existing interval
    const existing = this.typingIntervals.get(jid);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(jid);
    }

    if (!isTyping) return;

    const sendAction = async () => {
      try {
        const channelId = this.jidToChannelId(jid);
        const channel = await this.client.channels.fetch(channelId);
        if (channel?.isTextBased()) {
          await (channel as TextChannel).sendTyping();
        }
      } catch (err) {
        logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
      }
    };

    // Send immediately, then repeat every 8s (Discord typing expires after ~10s)
    await sendAction();
    this.typingIntervals.set(jid, setInterval(sendAction, 8000));
  }

  async syncGroups(): Promise<void> {
    // Could enumerate guild channels and sync metadata
    // For now, groups are registered manually
  }

  // --- Private helpers ---

  /**
   * Check if a JID is registered for this process's agent type.
   * Uses DB directly to check agent_type column.
   */
  private isRegisteredForMyAgentType(jid: string): boolean {
    const groups = this.opts.registeredGroups();
    const group = groups[jid];
    if (!group) return false;
    // In paired rooms, both agent types are registered — both should process
    // In solo rooms, only the matching agent type should process
    // We check via getRegisteredAgentTypesForJid
    const types = getRegisteredAgentTypesForJid(jid);
    return types.includes(agentType as any);
  }

  private messageToJid(msg: Message): string {
    if (msg.channel.isThread() && msg.channel.parentId) {
      return `discord:${msg.channel.parentId}:thread:${msg.channel.id}`;
    }
    return `discord:${msg.channelId}`;
  }

  private jidToChannelId(jid: string): string {
    const parts = jid.replace('discord:', '').split(':thread:');
    return parts.length > 1 ? parts[1] : parts[0];
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt <= 0) splitAt = maxLen;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
    return chunks;
  }
}
