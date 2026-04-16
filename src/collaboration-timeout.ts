/**
 * Collaboration Timeout & Message Runtime Rules
 *
 * Prevents infinite bot-only conversation loops by detecting when
 * only bots are talking to each other without human intervention.
 *
 * Also provides:
 * - Implicit continuation window tracking
 * - Looping paired bot message filter
 * - Enhanced trigger allowlist check
 */
import { getLastHumanMessageTimestamp, isPairedRoomJid } from './db.js';
import { isTriggerAllowed, loadSenderAllowlist } from './sender-allowlist.js';
import { logger } from './logger.js';
import type { NewMessage, RegisteredGroup } from './types.js';
import { TRIGGER_PATTERN } from './config.js';

// Maximum number of consecutive bot-only messages before we stop responding
const MAX_BOT_ONLY_MESSAGES = parseInt(
  process.env.NANOCLAW_MAX_BOT_ONLY_MESSAGES || '10',
  10,
);

// Cooldown period after bot-only timeout (ms) - human message resets it
const BOT_ONLY_COOLDOWN_MS = parseInt(
  process.env.NANOCLAW_BOT_ONLY_COOLDOWN_MS || '300000',
  10,
);

// How long after last human message we still respond to bot-only collab
const BOT_COLLABORATION_WINDOW_MS = 12 * 60 * 60 * 1000;

// Track when each room entered cooldown
const cooldownUntil: Record<string, number> = {};

/**
 * Check if we should skip processing because bots are just talking to each other.
 * Returns true if the conversation is bot-only and has exceeded the threshold.
 *
 * A human message in the batch resets the cooldown.
 *
 * For paired rooms, uses a 12-hour window from last human message.
 * For non-paired rooms, uses the consecutive message count + cooldown approach.
 */
export function shouldSkipBotOnlyCollaboration(
  chatJid: string,
  messages: NewMessage[],
): boolean {
  // Paired rooms use the window-based approach
  if (isPairedRoomJid(chatJid)) {
    const allFromBots = messages.every(
      (m) => m.is_from_me || !!m.is_bot_message,
    );
    if (!allFromBots) return false;
    const lastHuman = getLastHumanMessageTimestamp(chatJid);
    if (!lastHuman) return true;
    return (
      Date.now() - new Date(lastHuman).getTime() > BOT_COLLABORATION_WINDOW_MS
    );
  }

  // Non-paired rooms: count-based with cooldown
  const hasHumanMessage = messages.some(
    (m) => !m.is_bot_message && !m.is_from_me,
  );

  if (hasHumanMessage) {
    delete cooldownUntil[chatJid];
    return false;
  }

  // Check if we're in cooldown
  const now = Date.now();
  if (cooldownUntil[chatJid] && now < cooldownUntil[chatJid]) {
    return true;
  }

  // Count consecutive bot-only messages (all messages in batch are from bots)
  const allBotMessages = messages.every(
    (m) => m.is_bot_message || m.is_from_me,
  );

  if (allBotMessages && messages.length >= MAX_BOT_ONLY_MESSAGES) {
    logger.warn(
      {
        chatJid,
        messageCount: messages.length,
        threshold: MAX_BOT_ONLY_MESSAGES,
      },
      'Bot-only collaboration timeout triggered',
    );
    cooldownUntil[chatJid] = now + BOT_ONLY_COOLDOWN_MS;
    return true;
  }

  return false;
}

// ── Implicit Continuation Window ──

/**
 * Tracks per-chat implicit continuation windows.
 * When opened, the bot will continue responding to human messages
 * in non-trigger-required groups for `idleTimeout` ms without needing
 * a trigger keyword.
 */
export function createImplicitContinuationTracker(idleTimeout: number) {
  const implicitContinuationUntil = new Map<string, number>();

  return {
    open(chatJid: string): void {
      if (idleTimeout <= 0) return;
      implicitContinuationUntil.set(chatJid, Date.now() + idleTimeout);
    },

    has(chatJid: string, messages: NewMessage[]): boolean {
      const until = implicitContinuationUntil.get(chatJid);
      if (!until) return false;
      if (Date.now() > until) {
        implicitContinuationUntil.delete(chatJid);
        return false;
      }
      // Only continue if there's a non-bot, non-self message
      return messages.some(
        (message) => message.is_from_me !== true && !message.is_bot_message,
      );
    },
  };
}

// ── Looping Paired Bot Message Filter ──

/**
 * In paired rooms, filters out bot messages that exactly match a known
 * failure text to prevent infinite retry loops between two bots.
 */
export function filterLoopingPairedBotMessages(
  chatJid: string,
  messages: NewMessage[],
  failureText: string,
): NewMessage[] {
  if (!isPairedRoomJid(chatJid)) return messages;

  return messages.filter(
    (message) =>
      !(message.is_bot_message && message.content.trim() === failureText),
  );
}

// ── Enhanced Trigger Allowlist Check ──

/**
 * Checks if any message in the batch contains an allowed trigger.
 * Main groups and groups with requiresTrigger=false always pass.
 * Otherwise checks the trigger pattern + sender allowlist,
 * falling back to implicit continuation window.
 */
export function hasAllowedTrigger(opts: {
  chatJid: string;
  messages: NewMessage[];
  group: RegisteredGroup;
  triggerPattern?: RegExp;
  hasImplicitContinuationWindow: (
    chatJid: string,
    messages: NewMessage[],
  ) => boolean;
}): boolean {
  const {
    chatJid,
    messages,
    group,
    triggerPattern = TRIGGER_PATTERN,
    hasImplicitContinuationWindow,
  } = opts;

  if (group.isMain === true || group.requiresTrigger === false) {
    return true;
  }

  const allowlistCfg = loadSenderAllowlist();
  const hasTrigger = messages.some(
    (message) =>
      triggerPattern.test(message.content.trim()) &&
      (message.is_from_me ||
        isTriggerAllowed(chatJid, message.sender, allowlistCfg)),
  );
  return hasTrigger || hasImplicitContinuationWindow(chatJid, messages);
}
