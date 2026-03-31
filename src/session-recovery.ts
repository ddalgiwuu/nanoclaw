import type { AgentOutput } from './host-runner.js';
import { logger } from './logger.js';

const SESSION_RESET_PATTERNS = [
  /no conversation found with session id/i,
  /image.*exceeds.*dimension limit/i,
  /start a new session/i,
  /session.*not found/i,
  /session.*expired/i,
  /An image in the conversation exceeds the dimension limit for many-image requests \(2000px\)\./i,
  /Start a new session with fewer images\./i,
  /No conversation found with session ID/i,
];

const errorCounts = new Map<string, number>();
const MAX_CONSECUTIVE_ERRORS = 3;

export function recordAgentResult(groupFolder: string, success: boolean): void {
  if (success) {
    errorCounts.delete(groupFolder);
    return;
  }
  const count = (errorCounts.get(groupFolder) || 0) + 1;
  errorCounts.set(groupFolder, count);
}

export function shouldResetSession(groupFolder: string, errorText?: string): boolean {
  // Check consecutive error count
  const count = errorCounts.get(groupFolder) || 0;
  if (count >= MAX_CONSECUTIVE_ERRORS) {
    logger.warn({ groupFolder, errorCount: count }, 'Max consecutive errors, recommending session reset');
    return true;
  }

  // Check for known poisoned session patterns
  if (errorText) {
    for (const pattern of SESSION_RESET_PATTERNS) {
      if (pattern.test(errorText)) {
        logger.warn({ groupFolder, pattern: pattern.source }, 'Poisoned session detected');
        return true;
      }
    }
  }

  return false;
}

export function resetErrorCount(groupFolder: string): void {
  errorCounts.delete(groupFolder);
}

// ── Stateless single-output check (ported from EJClaw) ──────────

function toText(value: string | object | null | undefined): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];

  try {
    return [JSON.stringify(value)];
  } catch {
    return [];
  }
}

/**
 * Check a single AgentOutput for session-poisoning patterns.
 * Stateless — does not track consecutive errors.
 * Useful for mid-stream evaluation of individual output chunks.
 */
export function shouldResetSessionOnAgentFailure(
  output: Pick<AgentOutput, 'result' | 'error'>,
): boolean {
  const texts = [...toText(output.result), ...toText(output.error)];
  return texts.some((text) =>
    SESSION_RESET_PATTERNS.some((pattern) => pattern.test(text)),
  );
}
