import { logger } from './logger.js';

export interface CompactionResult {
  success: boolean;
  error?: string;
}

/**
 * Compact a session by asking the agent to summarize and compress context.
 * Uses the Agent SDK's built-in compaction via a structured prompt.
 */
export async function compactSession(deps: {
  groupFolder: string;
  sessionId: string;
  instructions?: string;
  sendMessage: (text: string) => Promise<void>;
  runAgent: (prompt: string, onOutput: (r: any) => Promise<void>) => Promise<'success' | 'error'>;
}): Promise<CompactionResult> {
  const { groupFolder, sessionId, instructions, sendMessage, runAgent } = deps;

  if (!sessionId) {
    return { success: false, error: 'No active session' };
  }

  logger.info({ groupFolder, sessionId }, 'Starting context compaction');
  await sendMessage('🧹 Compacting session...');

  const compactPrompt = instructions
    ? `/compact ${instructions}`
    : '/compact';

  let resultText: string | null = null;
  const status = await runAgent(compactPrompt, async (output) => {
    if (output.result) {
      resultText = typeof output.result === 'string' ? output.result : JSON.stringify(output.result);
    }
  });

  if (status === 'error') {
    logger.error({ groupFolder }, 'Compaction failed');
    await sendMessage('❌ Compaction failed');
    return { success: false, error: 'Agent returned error' };
  }

  logger.info({ groupFolder }, 'Compaction completed');
  return { success: true };
}
