export type ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'adaptive';

const LEVEL_ALIASES: Record<string, ThinkingLevel> = {
  off: 'off',
  none: 'off',
  '0': 'off',
  minimal: 'minimal',
  min: 'minimal',
  '1': 'minimal',
  low: 'low',
  '2': 'low',
  medium: 'medium',
  med: 'medium',
  default: 'medium',
  '3': 'medium',
  high: 'high',
  '4': 'high',
  xhigh: 'xhigh',
  ultra: 'xhigh',
  max: 'xhigh',
  '5': 'xhigh',
  adaptive: 'adaptive',
  auto: 'adaptive',
};

export interface ThinkingDirective {
  level: ThinkingLevel;
  isDirectiveOnly: boolean; // true if the message is ONLY a /think directive
}

/**
 * Parse /think, /think:level, /t level directives from message content
 */
export function parseThinkingDirective(
  content: string,
): ThinkingDirective | null {
  const trimmed = content.replace(/^@\w+\s*/, '').trim();

  // /think:level or /t:level
  const colonMatch = trimmed.match(/^\/(think|t):(\S+)(.*)$/i);
  if (colonMatch) {
    const level = LEVEL_ALIASES[colonMatch[2].toLowerCase()];
    if (level) {
      const rest = colonMatch[3].trim();
      return { level, isDirectiveOnly: rest.length === 0 };
    }
  }

  // /think level or /t level
  const spaceMatch = trimmed.match(/^\/(think|thinking|t)\s+(\S+)(.*)$/i);
  if (spaceMatch) {
    const level = LEVEL_ALIASES[spaceMatch[2].toLowerCase()];
    if (level) {
      const rest = spaceMatch[3].trim();
      return { level, isDirectiveOnly: rest.length === 0 };
    }
  }

  // /think (query current level, no change)
  if (/^\/(think|t)$/i.test(trimmed)) {
    return { level: 'medium', isDirectiveOnly: true };
  }

  return null;
}

/**
 * Map thinking level to environment variables for Agent SDK
 */
export function buildThinkingEnv(level: ThinkingLevel): Record<string, string> {
  switch (level) {
    case 'off':
      return { CLAUDE_CODE_DISABLE_THINKING: '1' };
    case 'minimal':
      return { CLAUDE_CODE_MAX_THINKING_TOKENS: '1024' };
    case 'low':
      return { CLAUDE_CODE_MAX_THINKING_TOKENS: '4096' };
    case 'medium':
      return {}; // Default, no override
    case 'high':
      return { CLAUDE_CODE_MAX_THINKING_TOKENS: '32768' };
    case 'xhigh':
      return { CLAUDE_CODE_MAX_THINKING_TOKENS: '65536' };
    case 'adaptive':
      return {}; // Let the model decide
    default:
      return {};
  }
}

/**
 * Human-readable label for thinking level
 */
export function getThinkingLabel(level: ThinkingLevel): string {
  const labels: Record<ThinkingLevel, string> = {
    off: '🔇 Off',
    minimal: '💭 Minimal',
    low: '🤔 Low',
    medium: '💡 Medium (default)',
    high: '🧠 High',
    xhigh: '🔥 Ultra High',
    adaptive: '🌀 Adaptive',
  };
  return labels[level] || level;
}
