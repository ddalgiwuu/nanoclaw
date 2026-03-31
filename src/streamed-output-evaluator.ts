/**
 * Streamed Output Evaluator for NanoClaw
 *
 * State machine for evaluating agent output mid-stream. Detects auth, usage,
 * access, and provider errors before the final result and decides whether to
 * forward or suppress output.
 *
 * Ported from EJClaw/src/streamed-output-evaluator.ts, adapted to NanoClaw
 * import patterns and existing provider-fallback / token-rotation modules.
 */

import type { AgentOutput } from './host-runner.js';
import { isRateLimitError } from './provider-fallback.js';

// ── Error Detection (inlined from EJClaw agent-error-detection) ─────

export type AgentTriggerReason =
  | '429'
  | 'usage-exhausted'
  | 'auth-expired'
  | 'org-access-denied'
  | 'overloaded'
  | 'network-error'
  | 'success-null-result';

export function isClaudeAuthError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('failed to authenticate') &&
    (lower.includes('401') || lower.includes('authentication_error'))
  );
}

export function isClaudeUsageExhaustedMessage(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/['\u2018\u2019`]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/^error:\s*/i, '');
  const looksLikeBanner =
    normalized.startsWith("you're out of extra usage") ||
    normalized.startsWith('you are out of extra usage') ||
    normalized.startsWith("you've hit your limit") ||
    normalized.startsWith('you have hit your limit');
  const hasResetHint =
    normalized.includes('resets ') ||
    normalized.includes('reset at ') ||
    normalized.includes('try again');
  return looksLikeBanner && hasResetHint && normalized.length <= 160;
}

export function isClaudeAuthExpiredMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const looksLikeAuthFailure = normalized.startsWith('failed to authenticate');
  const hasExpiredTokenMarker =
    normalized.includes('oauth token has expired') ||
    normalized.includes('authentication_error') ||
    normalized.includes('obtain a new token') ||
    normalized.includes('refresh your existing token') ||
    normalized.includes('invalid authentication credentials');
  const hasUnauthorizedMarker =
    normalized.includes('401') || normalized.includes('authentication error');
  const hasTerminatedMarker = normalized.includes('terminated');

  return (
    looksLikeAuthFailure &&
    hasUnauthorizedMarker &&
    (hasExpiredTokenMarker || hasTerminatedMarker)
  );
}

export function isClaudeOrgAccessDeniedMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const hasOrgAccessDeniedMarker = normalized.includes(
    'does not have access to claude',
  );
  const hasRecoveryHint =
    normalized.includes('please login again') ||
    normalized.includes('contact your administrator');

  return hasOrgAccessDeniedMarker && hasRecoveryHint;
}

function detectProviderFailureMessage(
  text: string,
): Extract<AgentTriggerReason, '429' | 'overloaded' | 'network-error'> | '' {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const looksLikeProviderError =
    normalized.startsWith('api error:') ||
    normalized.startsWith('error: api error:') ||
    normalized.startsWith('network error') ||
    normalized.startsWith('fetch failed');

  if (!looksLikeProviderError) return '';

  const lower = text.toLowerCase();
  if (
    lower.includes('429') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests') ||
    lower.includes('rate_limit')
  ) {
    return '429';
  }
  if (
    lower.includes('503') ||
    lower.includes('overloaded') ||
    (lower.includes('502') && lower.includes('api error'))
  ) {
    return 'overloaded';
  }
  if (
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('enotfound') ||
    lower.includes('fetch failed') ||
    lower.includes('network error')
  ) {
    return 'network-error';
  }
  return '';
}

// ── Fallback trigger detection (simplified for NanoClaw) ────────

interface FallbackTriggerResult {
  shouldFallback: boolean;
  reason: AgentTriggerReason | '';
  retryAfterMs?: number;
}

function detectFallbackTrigger(error?: string | null): FallbackTriggerResult {
  if (!error) return { shouldFallback: false, reason: '' };

  if (isRateLimitError(error)) {
    const retryMatch = error.match(/retry[\s_-]*after[:\s]*(\d+)/i);
    const retryAfterMs = retryMatch
      ? parseInt(retryMatch[1], 10) * 1000
      : undefined;
    return { shouldFallback: true, reason: '429', retryAfterMs };
  }

  const lower = error.toLowerCase();
  if (lower.includes('503') || lower.includes('overloaded')) {
    return { shouldFallback: true, reason: 'overloaded' };
  }
  if (
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('enotfound') ||
    lower.includes('fetch failed') ||
    lower.includes('network error')
  ) {
    return { shouldFallback: true, reason: 'network-error' };
  }

  return { shouldFallback: false, reason: '' };
}

interface CodexRotationTriggerResult {
  shouldRotate: boolean;
  reason: AgentTriggerReason | '';
}

function detectCodexRotationTrigger(
  error?: string | null,
): CodexRotationTriggerResult {
  if (!error) return { shouldRotate: false, reason: '' };

  if (isRateLimitError(error)) {
    return { shouldRotate: true, reason: '429' };
  }

  const lower = error.toLowerCase();
  if (
    lower.includes('401') ||
    lower.includes('authentication_error') ||
    lower.includes('failed to authenticate') ||
    lower.includes('unauthorized')
  ) {
    return { shouldRotate: true, reason: 'auth-expired' };
  }

  if (lower.includes('503') || lower.includes('overloaded')) {
    return { shouldRotate: true, reason: 'overloaded' };
  }

  if (
    lower.includes('econnrefused') ||
    lower.includes('fetch failed') ||
    lower.includes('network error')
  ) {
    return { shouldRotate: true, reason: 'network-error' };
  }

  return { shouldRotate: false, reason: '' };
}

// ── Streamed Output Evaluator ───────────────────────────────────

export interface StreamedTriggerReason {
  reason: AgentTriggerReason;
  retryAfterMs?: number;
}

export interface StreamedOutputState {
  sawOutput: boolean;
  sawSuccessNullResultWithoutOutput: boolean;
  streamedTriggerReason?: StreamedTriggerReason;
}

export interface EvaluateStreamedOutputOptions {
  agentType: 'claude-code' | 'codex';
  provider: string;
  suppressClaudeAuthErrorOutput?: boolean;
  trackSuccessNullResult?: boolean;
  shortCircuitTriggeredErrors?: boolean;
}

export interface EvaluateStreamedOutputResult {
  state: StreamedOutputState;
  shouldForwardOutput: boolean;
  newTrigger?: StreamedTriggerReason;
  suppressedAuthError?: boolean;
}

export function evaluateStreamedOutput(
  output: AgentOutput,
  state: StreamedOutputState,
  options: EvaluateStreamedOutputOptions,
): EvaluateStreamedOutputResult {
  const nextState: StreamedOutputState = { ...state };
  const isPrimaryClaude =
    options.agentType === 'claude-code' && options.provider === 'claude';
  const isPrimaryCodex =
    options.agentType === 'codex' && options.provider === 'codex';

  // Check success output from primary Claude for auth/usage/access errors
  if (
    isPrimaryClaude &&
    output.status === 'success' &&
    !state.sawOutput &&
    typeof output.result === 'string'
  ) {
    const triggerReason: AgentTriggerReason | undefined =
      isClaudeUsageExhaustedMessage(output.result)
        ? 'usage-exhausted'
        : isClaudeOrgAccessDeniedMessage(output.result)
          ? 'org-access-denied'
          : isClaudeAuthExpiredMessage(output.result)
            ? 'auth-expired'
            : detectProviderFailureMessage(output.result) || undefined;

    if (triggerReason) {
      const newTrigger = nextState.streamedTriggerReason
        ? undefined
        : { reason: triggerReason };
      nextState.streamedTriggerReason =
        nextState.streamedTriggerReason ?? newTrigger;
      return {
        state: nextState,
        shouldForwardOutput: false,
        newTrigger,
      };
    }

    if (
      options.suppressClaudeAuthErrorOutput &&
      isClaudeAuthError(output.result)
    ) {
      return {
        state: nextState,
        shouldForwardOutput: false,
        suppressedAuthError: true,
      };
    }
  }

  // Track whether we have seen real output
  if (output.result !== null && output.result !== undefined) {
    nextState.sawOutput = true;
  } else if (
    options.trackSuccessNullResult &&
    isPrimaryClaude &&
    output.status === 'success' &&
    !state.sawOutput
  ) {
    nextState.sawSuccessNullResultWithoutOutput = true;
  }

  // Check error output for fallback/rotation triggers
  if (
    output.status === 'error' &&
    !nextState.sawOutput &&
    !nextState.streamedTriggerReason
  ) {
    let newTrigger: StreamedTriggerReason | undefined;

    if (isPrimaryClaude) {
      const trigger = detectFallbackTrigger(output.error);
      if (trigger.shouldFallback) {
        newTrigger = {
          reason: trigger.reason as AgentTriggerReason,
          retryAfterMs: trigger.retryAfterMs,
        };
      }
    } else if (isPrimaryCodex) {
      const trigger = detectCodexRotationTrigger(output.error);
      if (trigger.shouldRotate) {
        newTrigger = { reason: trigger.reason as AgentTriggerReason };
      }
    }

    if (newTrigger) {
      nextState.streamedTriggerReason = newTrigger;
      return {
        state: nextState,
        shouldForwardOutput: !options.shortCircuitTriggeredErrors,
        newTrigger,
      };
    }
  }

  return {
    state: nextState,
    shouldForwardOutput: true,
  };
}

/**
 * Create a fresh initial state for a new streaming session.
 */
export function createStreamedOutputState(): StreamedOutputState {
  return {
    sawOutput: false,
    sawSuccessNullResultWithoutOutput: false,
  };
}
