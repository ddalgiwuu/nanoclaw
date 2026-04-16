/**
 * Provider Fallback for NanoClaw
 *
 * Manages automatic fallback from the primary provider (Claude) to a
 * fallback provider when 429/rate-limit or network errors are detected.
 *
 * Cooldown-based recovery:
 *   Claude 429 → immediate fallback retry for that turn
 *   Claude enters cooldown (retry-after header or default 10 min)
 *   During cooldown → skip Claude, route directly to fallback
 *   After cooldown → try Claude first again
 *
 * Merges NanoClaw's original helpers (isRateLimitError, getCooldownMs, etc.)
 * with EJClaw's cooldown-based provider routing and rotation loop.
 */

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  markTokenRateLimited,
  markTokenHealthy,
  getTokenCount,
  getCurrentToken,
} from './token-rotation.js';

// ── Types ────────────────────────────────────────────────────────

export type ProviderName = 'claude' | string;

export type FallbackTriggerReason =
  | 'rate-limit'
  | 'overloaded'
  | 'network-error'
  | 'auth-error'
  | 'usage-exhausted'
  | string;

export type FallbackTriggerResult =
  | { shouldFallback: false; reason: '' }
  | {
      shouldFallback: true;
      reason: FallbackTriggerReason;
      retryAfterMs?: number;
    };

export interface FallbackState {
  cooldownUntil: number;
  consecutiveFailures: number;
  lastError: string;
}

interface CooldownState {
  startedAt: number;
  expiresAt: number;
  reason: string;
}

interface FallbackConfig {
  enabled: boolean;
  providerName: string;
  baseUrl: string;
  authToken: string;
  model: string;
  smallModel: string;
  defaultCooldownMs: number;
}

// ── Rate-limit detection (NanoClaw original) ─────────────────────

const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /429/,
  /overloaded/i,
  /capacity/i,
  /too many requests/i,
  /resource.?exhausted/i,
];

const NETWORK_ERROR_PATTERNS = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /socket hang up/i,
  /network.?error/i,
  /fetch failed/i,
];

const AUTH_ERROR_PATTERNS = [
  /401/,
  /403/,
  /unauthorized/i,
  /invalid.?token/i,
  /expired.?token/i,
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

// ── Fallback config (FALLBACK_BASE_URL, FALLBACK_MODEL env vars) ─

let _config: FallbackConfig | null = null;

function loadConfig(): FallbackConfig {
  if (_config) return _config;

  const env = readEnvFile([
    'FALLBACK_BASE_URL',
    'FALLBACK_AUTH_TOKEN',
    'FALLBACK_MODEL',
    'FALLBACK_SMALL_MODEL',
    'FALLBACK_PROVIDER_NAME',
    'FALLBACK_COOLDOWN_MS',
    'FALLBACK_ENABLED',
  ]);

  const baseUrl = process.env.FALLBACK_BASE_URL || env.FALLBACK_BASE_URL || '';
  const authToken =
    process.env.FALLBACK_AUTH_TOKEN || env.FALLBACK_AUTH_TOKEN || '';
  const model = process.env.FALLBACK_MODEL || env.FALLBACK_MODEL || '';
  const explicitlyDisabled =
    (
      process.env.FALLBACK_ENABLED ||
      env.FALLBACK_ENABLED ||
      ''
    ).toLowerCase() === 'false';

  _config = {
    enabled: !explicitlyDisabled && Boolean(baseUrl && authToken && model),
    providerName:
      process.env.FALLBACK_PROVIDER_NAME ||
      env.FALLBACK_PROVIDER_NAME ||
      'fallback',
    baseUrl,
    authToken,
    model,
    smallModel:
      process.env.FALLBACK_SMALL_MODEL || env.FALLBACK_SMALL_MODEL || model,
    defaultCooldownMs: parseInt(
      process.env.FALLBACK_COOLDOWN_MS || env.FALLBACK_COOLDOWN_MS || '600000',
      10,
    ),
  };

  if (_config.enabled) {
    logger.info(
      {
        provider: _config.providerName,
        model: _config.model,
        cooldownMs: _config.defaultCooldownMs,
      },
      'Provider fallback configured',
    );
  }

  return _config;
}

/** Force re-read of config (useful after .env changes). */
export function resetFallbackConfig(): void {
  _config = null;
}

// ── Cooldown state ───────────────────────────────────────────────

let cooldown: CooldownState | null = null;

// ── Public API ───────────────────────────────────────────────────

/** Check whether the fallback system is configured and available. */
export function isFallbackEnabled(): boolean {
  return loadConfig().enabled;
}

/** Get the display name of the fallback provider. */
export function getFallbackProviderName(): string {
  return loadConfig().providerName;
}

/**
 * Determine which provider should be used for the next request.
 * Returns 'claude' when Claude is healthy or cooldown has expired,
 * or the fallback provider name during an active cooldown.
 */
export function getActiveProvider(): string {
  const config = loadConfig();
  if (!config.enabled) return 'claude';

  if (cooldown) {
    if (Date.now() < cooldown.expiresAt) {
      logger.debug(
        {
          reason: cooldown.reason,
          remainingMs: cooldown.expiresAt - Date.now(),
          fallbackProvider: config.providerName,
        },
        'Claude cooldown still active, routing to fallback',
      );
      return config.providerName;
    }
    // Cooldown expired
    logger.info(
      {
        cooldownDurationMs: cooldown.expiresAt - cooldown.startedAt,
        reason: cooldown.reason,
      },
      'Claude cooldown expired, retrying primary provider',
    );
    cooldown = null;
  }

  return 'claude';
}

/**
 * Mark Claude as rate-limited. All subsequent requests will route to
 * the fallback provider until the cooldown expires.
 */
export function markPrimaryCooldown(
  reason: string,
  retryAfterMs?: number,
): void {
  const config = loadConfig();
  const durationMs = retryAfterMs || config.defaultCooldownMs;
  const now = Date.now();

  cooldown = {
    startedAt: now,
    expiresAt: now + durationMs,
    reason,
  };

  logger.info(
    {
      reason,
      cooldownMs: durationMs,
      expiresAt: new Date(cooldown.expiresAt).toISOString(),
      fallbackProvider: config.providerName,
    },
    `Falling back to provider: ${config.providerName} (reason: ${reason}, cooldownMs: ${durationMs})`,
  );
}

/** Manually clear cooldown (e.g. after a successful Claude response). */
export function clearCooldown(): void {
  if (cooldown) {
    logger.info(
      { reason: cooldown.reason },
      'Claude cooldown cleared manually',
    );
    cooldown = null;
  }
}

/** Get current cooldown info (for diagnostics / status dashboard). */
export function getCooldownInfo(): {
  active: boolean;
  reason?: string;
  expiresAt?: string;
  remainingMs?: number;
} {
  if (!cooldown) return { active: false };
  const remainingMs = Math.max(cooldown.expiresAt - Date.now(), 0);
  if (remainingMs === 0) return { active: false };
  return {
    active: true,
    reason: cooldown.reason,
    expiresAt: new Date(cooldown.expiresAt).toISOString(),
    remainingMs,
  };
}

/**
 * Build the env-var overrides that make Claude Code SDK talk to
 * the fallback provider instead of Claude.
 */
export function getFallbackEnvOverrides(): Record<string, string> {
  const config = loadConfig();
  if (!config.enabled || !config.baseUrl || !config.authToken) return {};

  return {
    ANTHROPIC_BASE_URL: config.baseUrl,
    ANTHROPIC_API_KEY: config.authToken,
    ANTHROPIC_MODEL: config.model,
    ...(config.smallModel !== config.model
      ? { ANTHROPIC_SMALL_FAST_MODEL: config.smallModel }
      : {}),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    API_TIMEOUT_MS: '3000000',
  };
}

/**
 * Inspect an agent error string and decide whether it warrants
 * a provider fallback.
 */
export function detectFallbackTrigger(
  error?: string | null,
): FallbackTriggerResult {
  if (!error) return { shouldFallback: false, reason: '' };

  // 429 / rate limit (highest priority)
  if (isRateLimitError(error)) {
    // Try to extract retry-after from error text
    const retryMatch = error.match(/retry.?after[:\s]*(\d+)/i);
    const retryAfterMs = retryMatch
      ? parseInt(retryMatch[1], 10) * 1000
      : undefined;
    return { shouldFallback: true, reason: 'rate-limit', retryAfterMs };
  }

  // Auth errors
  if (AUTH_ERROR_PATTERNS.some((p) => p.test(error))) {
    return { shouldFallback: true, reason: 'auth-error' };
  }

  // Network errors
  if (NETWORK_ERROR_PATTERNS.some((p) => p.test(error))) {
    return { shouldFallback: true, reason: 'network-error' };
  }

  return { shouldFallback: false, reason: '' };
}

// ── Rotation loop (ported from EJClaw provider-retry.ts) ─────────

export interface RotationAttemptResult {
  output?: { status: string; result?: string | null; error?: string | null };
  thrownError?: unknown;
  sawOutput: boolean;
}

export type RotationOutcome =
  | { type: 'success' }
  | { type: 'error'; message?: string }
  | { type: 'needs-fallback'; reason: string; retryAfterMs?: number };

/**
 * Retry a Claude request by rotating through available tokens.
 *
 * On each rate-limit error, marks the current token as rate-limited,
 * rotates to the next token, and retries. If all tokens are exhausted,
 * returns 'needs-fallback' so the caller can use the fallback provider.
 */
export async function runClaudeRotationLoop(
  initialReason: string,
  runAttempt: () => Promise<RotationAttemptResult>,
  logContext: Record<string, unknown> = {},
): Promise<RotationOutcome> {
  let reason = initialReason;
  let retryAfterMs: number | undefined;

  // Mark current token and try rotation
  while (getTokenCount() > 1) {
    markTokenRateLimited(retryAfterMs);

    // getCurrentToken() internally rotates to next available
    const nextToken = getCurrentToken();
    if (!nextToken) break; // All tokens exhausted

    logger.info(
      { ...logContext, reason },
      'Claude account unavailable, retrying with rotated token',
    );

    const attempt = await runAttempt();

    // Thrown error
    if (attempt.thrownError) {
      if (!attempt.sawOutput) {
        const errMsg =
          attempt.thrownError instanceof Error
            ? attempt.thrownError.message
            : String(attempt.thrownError);
        const trigger = detectFallbackTrigger(errMsg);
        if (trigger.shouldFallback) {
          reason = trigger.reason;
          retryAfterMs = trigger.retryAfterMs;
          continue;
        }
      }
      return { type: 'error', message: String(attempt.thrownError) };
    }

    const output = attempt.output;
    if (!output) {
      return { type: 'error', message: 'No output from rotated token' };
    }

    // Error status
    if (output.status === 'error') {
      if (!attempt.sawOutput) {
        const trigger = detectFallbackTrigger(output.error);
        if (trigger.shouldFallback) {
          reason = trigger.reason;
          retryAfterMs = trigger.retryAfterMs;
          continue;
        }
      }
      return { type: 'error', message: output.error ?? undefined };
    }

    // Success
    markTokenHealthy();
    return { type: 'success' };
  }

  // All tokens exhausted — fall back
  markPrimaryCooldown(reason, retryAfterMs);
  return { type: 'needs-fallback', reason, retryAfterMs };
}
