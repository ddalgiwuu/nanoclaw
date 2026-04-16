import {
  insertTokenUsage,
  queryTokenUsageSince,
  aggregateTokenUsageSince,
  TokenUsageRow,
} from './db.js';
import { logger } from './logger.js';

export interface TokenUsage {
  groupFolder: string;
  sessionId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  estimatedCostUsd: number;
}

export function recordUsage(usage: TokenUsage): void {
  try {
    insertTokenUsage({
      group_folder: usage.groupFolder,
      session_id: usage.sessionId || null,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read: usage.cacheRead,
      cache_write: usage.cacheWrite,
      estimated_cost_usd: usage.estimatedCostUsd,
      recorded_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err, usage }, 'Failed to record token usage');
  }
}

export function getUsageSince(
  since: string,
  groupFolder?: string,
): TokenUsage[] {
  const rows = queryTokenUsageSince(since, groupFolder);
  return rows.map((r) => ({
    groupFolder: r.group_folder,
    sessionId: r.session_id || undefined,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheRead: r.cache_read,
    cacheWrite: r.cache_write,
    estimatedCostUsd: r.estimated_cost_usd,
  }));
}

export function getTodayUsage(groupFolder?: string): {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
} {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const agg = aggregateTokenUsageSince(todayStart.toISOString(), groupFolder);
  return {
    inputTokens: agg.input_tokens,
    outputTokens: agg.output_tokens,
    costUsd: agg.cost_usd,
  };
}

export function formatUsageSummary(): string {
  const today = getTodayUsage();
  return [
    '\u{1F4CA} Token Usage (Today)',
    `\u2022 Input: ${today.inputTokens.toLocaleString()}`,
    `\u2022 Output: ${today.outputTokens.toLocaleString()}`,
    `\u2022 Est. Cost: $${today.costUsd.toFixed(4)}`,
  ].join('\n');
}
