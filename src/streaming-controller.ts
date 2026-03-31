import { logger } from './logger.js';

export type StreamMode = 'direct' | 'block' | 'preview';

const SHORT_THRESHOLD = 500;
const LONG_THRESHOLD = 2000;

/**
 * Select streaming mode based on content characteristics.
 */
export function selectStreamMode(content: string): StreamMode {
  if (content.length <= SHORT_THRESHOLD) return 'direct';
  if (content.length > LONG_THRESHOLD) return 'block';
  // Medium — check if it has code blocks or structured content
  if (content.includes('```') || content.includes('| ')) return 'block';
  return 'direct';
}

export interface StreamingControllerDeps {
  sendMessage: (chatJid: string, text: string) => Promise<string | null>;
  editMessage?: (chatJid: string, messageId: string, text: string) => Promise<void>;
  chunkMessage: (text: string) => string[];
  formatBlocks: (text: string) => string;
}

/**
 * Send a message using the appropriate streaming strategy.
 */
export async function sendWithStreaming(
  chatJid: string,
  text: string,
  deps: StreamingControllerDeps,
): Promise<void> {
  const mode = selectStreamMode(text);

  switch (mode) {
    case 'direct':
      await deps.sendMessage(chatJid, text);
      break;

    case 'block': {
      // Format into blocks, then chunk for Telegram limit
      const formatted = deps.formatBlocks(text);
      const chunks = deps.chunkMessage(formatted);
      for (const chunk of chunks) {
        await deps.sendMessage(chatJid, chunk);
      }
      break;
    }

    case 'preview':
      // Preview mode is handled at IPC level, not here
      await deps.sendMessage(chatJid, text);
      break;
  }
}
