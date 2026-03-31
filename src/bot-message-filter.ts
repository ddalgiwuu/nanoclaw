/**
 * Bot Message Filter for paired-room dual-agent dispatch.
 * Filters messages for a specific agent, removing its own messages
 * while keeping the other bot's messages as context.
 */
import { NewMessage } from './types.js';

/**
 * Filter messages for processing by a specific agent in a paired room.
 *
 * @param messages - All messages since the last cursor
 * @param allowBotMessages - Whether to include bot messages (true for paired rooms)
 * @param isOwnMessage - Predicate that returns true if the message was sent by the current agent
 * @returns Filtered messages suitable for the agent's prompt
 */
export function filterProcessableMessages(
  messages: NewMessage[],
  allowBotMessages: boolean,
  isOwnMessage: (msg: NewMessage) => boolean,
): NewMessage[] {
  return messages.filter((msg) => {
    // Always remove the agent's own messages from its prompt
    if (isOwnMessage(msg)) return false;

    // If bot messages aren't allowed, filter them out
    if (!allowBotMessages && msg.is_bot_message) return false;

    return true;
  });
}
