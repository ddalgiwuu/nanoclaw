import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const STATE_FILE = path.join(DATA_DIR, 'restart-state.json');

export interface RestartState {
  shutdownAt: string;
  activeGroups: string[];
  pendingMessages: number;
  reason: string;
}

export function captureRestartState(deps: {
  getActiveGroups: () => string[];
  getPendingCount: () => number;
  reason?: string;
}): RestartState {
  return {
    shutdownAt: new Date().toISOString(),
    activeGroups: deps.getActiveGroups(),
    pendingMessages: deps.getPendingCount(),
    reason: deps.reason || 'shutdown',
  };
}

export function saveRestartState(state: RestartState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    logger.info({ state }, 'Restart state saved');
  } catch (err) {
    logger.error({ err }, 'Failed to save restart state');
  }
}

export function loadRestartState(): RestartState | null {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    return data as RestartState;
  } catch {
    return null;
  }
}

export function clearRestartState(): void {
  try {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  } catch {
    /* ignore */
  }
}

export function formatRestartAnnouncement(state: RestartState): string {
  const lines = ['\u{1F504} NanoClaw \uC7AC\uC2DC\uC791\uB428'];

  const shutdownTime = new Date(state.shutdownAt);
  const elapsed = Math.round((Date.now() - shutdownTime.getTime()) / 1000);
  lines.push(`\u2022 \uB2E4\uC6B4\uD0C0\uC784: ${elapsed}\uCD08`);

  if (state.reason !== 'shutdown') {
    lines.push(`\u2022 \uC0AC\uC720: ${state.reason}`);
  }

  if (state.activeGroups.length > 0) {
    lines.push(
      `\u2022 \uC911\uB2E8\uB41C \uADF8\uB8F9: ${state.activeGroups.join(', ')}`,
    );
  }

  if (state.pendingMessages > 0) {
    lines.push(
      `\u2022 \uB300\uAE30 \uBA54\uC2DC\uC9C0: ${state.pendingMessages}\uAC1C`,
    );
  }

  lines.push(
    '\u2022 \uBAA8\uB4E0 \uC11C\uBE44\uC2A4 \uC815\uC0C1 \uC7AC\uAC1C',
  );
  return lines.join('\n');
}
