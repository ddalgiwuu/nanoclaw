import { logger } from './logger.js';

export interface LoopConfig {
  windowSize: number;
  warnThreshold: number;
  blockThreshold: number;
}

const DEFAULT_CONFIG: LoopConfig = {
  windowSize: 30,
  warnThreshold: 10,
  blockThreshold: 20,
};

interface ActionRecord {
  action: string;
  timestamp: number;
}

const actionHistory = new Map<string, ActionRecord[]>();

export function configureLoopDetector(config: Partial<LoopConfig>): LoopConfig {
  return { ...DEFAULT_CONFIG, ...config };
}

export function recordAction(
  groupFolder: string,
  action: string,
  config?: LoopConfig,
): void {
  const cfg = config || DEFAULT_CONFIG;
  let history = actionHistory.get(groupFolder);
  if (!history) {
    history = [];
    actionHistory.set(groupFolder, history);
  }
  history.push({ action, timestamp: Date.now() });
  // Trim to window size
  if (history.length > cfg.windowSize) {
    history.splice(0, history.length - cfg.windowSize);
  }
}

export function detectLoop(
  groupFolder: string,
  config?: LoopConfig,
): {
  looping: boolean;
  pattern?: string;
  count?: number;
  severity?: 'warn' | 'block';
} {
  const cfg = config || DEFAULT_CONFIG;
  const history = actionHistory.get(groupFolder);
  if (!history || history.length < 3) return { looping: false };

  // Check for direct repetition (same action N times in a row)
  const actions = history.map((h) => h.action);
  let repeatCount = 1;
  const lastAction = actions[actions.length - 1];
  for (let i = actions.length - 2; i >= 0; i--) {
    if (actions[i] === lastAction) repeatCount++;
    else break;
  }

  if (repeatCount >= cfg.blockThreshold) {
    logger.warn(
      { groupFolder, action: lastAction, count: repeatCount },
      'Loop detected (block threshold)',
    );
    return {
      looping: true,
      pattern: lastAction,
      count: repeatCount,
      severity: 'block',
    };
  }
  if (repeatCount >= cfg.warnThreshold) {
    logger.warn(
      { groupFolder, action: lastAction, count: repeatCount },
      'Loop detected (warn threshold)',
    );
    return {
      looping: true,
      pattern: lastAction,
      count: repeatCount,
      severity: 'warn',
    };
  }

  // Check for ping-pong pattern (A→B→A→B)
  if (actions.length >= 4) {
    const last4 = actions.slice(-4);
    if (
      last4[0] === last4[2] &&
      last4[1] === last4[3] &&
      last4[0] !== last4[1]
    ) {
      // Count how long this ping-pong has been going
      let ppCount = 2;
      for (let i = actions.length - 5; i >= 0; i -= 2) {
        if (
          actions[i] === last4[0] &&
          i + 1 < actions.length &&
          actions[i + 1] === last4[1]
        ) {
          ppCount++;
        } else break;
      }
      if (ppCount * 2 >= cfg.blockThreshold) {
        return {
          looping: true,
          pattern: `${last4[0]} ↔ ${last4[1]}`,
          count: ppCount * 2,
          severity: 'block',
        };
      }
      if (ppCount * 2 >= cfg.warnThreshold) {
        return {
          looping: true,
          pattern: `${last4[0]} ↔ ${last4[1]}`,
          count: ppCount * 2,
          severity: 'warn',
        };
      }
    }
  }

  return { looping: false };
}

export function resetLoop(groupFolder: string): void {
  actionHistory.delete(groupFolder);
}

export function resetAllLoops(): void {
  actionHistory.clear();
}
