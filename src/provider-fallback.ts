/**
 * Provider Fallback for NanoClaw
 * Detects rate limit errors and provides exponential backoff logic.
 */

export interface FallbackState {
  cooldownUntil: number; // timestamp
  consecutiveFailures: number;
  lastError: string;
}

const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /429/,
  /overloaded/i,
  /capacity/i,
  /too many requests/i,
  /resource.?exhausted/i,
];

export function isRateLimitError(error: string): boolean {
  return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(error));
}

/**
 * Exponential backoff: 30s, 60s, 120s, max 300s
 */
export function getCooldownMs(failures: number): number {
  const baseMs = 30_000;
  const maxMs = 300_000;
  const ms = baseMs * Math.pow(2, failures - 1);
  return Math.min(ms, maxMs);
}

export function createFallbackState(): FallbackState {
  return {
    cooldownUntil: 0,
    consecutiveFailures: 0,
    lastError: '',
  };
}
