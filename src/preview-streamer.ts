import { logger } from './logger.js';

export interface PreviewSession {
  chatJid: string;
  messageId: string | null;
  content: string;
  lastUpdateAt: number;
  finalized: boolean;
}

export interface PreviewDeps {
  sendMessage: (chatJid: string, text: string) => Promise<string | null>;
  editMessage?: (chatJid: string, messageId: string, text: string) => Promise<void>;
  minUpdateIntervalMs?: number;
}

const activePreviews = new Map<string, PreviewSession>();

const DEFAULT_MIN_INTERVAL = 1500; // 1.5s between edits (Telegram rate limit)

export function startPreview(chatJid: string): PreviewSession {
  const session: PreviewSession = {
    chatJid,
    messageId: null,
    content: '',
    lastUpdateAt: 0,
    finalized: false,
  };
  activePreviews.set(chatJid, session);
  return session;
}

export async function updatePreview(
  session: PreviewSession,
  newContent: string,
  deps: PreviewDeps,
): Promise<void> {
  if (session.finalized) return;

  const minInterval = deps.minUpdateIntervalMs || DEFAULT_MIN_INTERVAL;
  const now = Date.now();
  session.content = newContent;

  // Throttle updates
  if (session.messageId && now - session.lastUpdateAt < minInterval) {
    return; // Skip this update, will be caught by next one
  }

  if (!session.messageId) {
    // First message — send new
    const msgId = await deps.sendMessage(session.chatJid, newContent);
    session.messageId = msgId;
    session.lastUpdateAt = now;
  } else if (deps.editMessage) {
    // Update existing message
    try {
      await deps.editMessage(session.chatJid, session.messageId, newContent);
      session.lastUpdateAt = now;
    } catch (err) {
      logger.debug({ chatJid: session.chatJid, err }, 'Preview edit failed, will retry');
    }
  }
}

export async function finalizePreview(
  session: PreviewSession,
  finalContent: string,
  deps: PreviewDeps,
): Promise<void> {
  session.finalized = true;
  session.content = finalContent;

  if (session.messageId && deps.editMessage) {
    try {
      await deps.editMessage(session.chatJid, session.messageId, finalContent);
    } catch {
      // If edit fails, send as new message
      await deps.sendMessage(session.chatJid, finalContent);
    }
  } else if (!session.messageId) {
    await deps.sendMessage(session.chatJid, finalContent);
  }

  activePreviews.delete(session.chatJid);
}

export function getActivePreview(chatJid: string): PreviewSession | undefined {
  return activePreviews.get(chatJid);
}

export function clearPreview(chatJid: string): void {
  activePreviews.delete(chatJid);
}
