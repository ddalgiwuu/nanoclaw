import { logger } from './logger.js';

export type PruneMode = 'soft' | 'hard';

export interface PruneResult {
  success: boolean;
  mode: PruneMode;
  error?: string;
}

export function parsePruneCommand(content: string): { mode: PruneMode } | null {
  const trimmed = content.replace(/^@\w+\s*/, '').trim();
  const match = trimmed.match(/^\/prune(?:\s+(soft|hard))?$/i);
  if (!match) return null;
  return { mode: (match[1]?.toLowerCase() as PruneMode) || 'soft' };
}

export async function pruneSession(deps: {
  groupFolder: string;
  sessionId: string;
  mode: PruneMode;
  sendMessage: (text: string) => Promise<void>;
  runAgent: (prompt: string, onOutput: (r: any) => Promise<void>) => Promise<'success' | 'error'>;
}): Promise<PruneResult> {
  const { groupFolder, sessionId, mode, sendMessage, runAgent } = deps;

  if (!sessionId) {
    return { success: false, mode, error: 'No active session' };
  }

  logger.info({ groupFolder, mode }, 'Starting context pruning');

  const prompt = mode === 'hard'
    ? '/compact Remove all old tool results and keep only the last 3 exchanges. Be aggressive about trimming.'
    : '/compact Summarize old tool results briefly, keep recent context intact.';

  await sendMessage(`✂️ Pruning session (${mode} mode)...`);

  const status = await runAgent(prompt, async () => {});

  if (status === 'error') {
    logger.error({ groupFolder, mode }, 'Pruning failed');
    await sendMessage('❌ Pruning failed');
    return { success: false, mode, error: 'Agent returned error' };
  }

  await sendMessage(`✅ Pruning complete (${mode} mode)`);
  logger.info({ groupFolder, mode }, 'Pruning completed');
  return { success: true, mode };
}
