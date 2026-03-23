/**
 * Heartbeat system for NanoClaw
 *
 * Runs in the MAIN session at regular intervals.
 * Reads HEARTBEAT.md and batches multiple checks into a single turn.
 * If nothing needs attention, agent responds HEARTBEAT_OK → no message sent.
 *
 * Token optimization: 1 heartbeat turn replaces N isolated cron jobs.
 */
import fs from 'fs';
import path from 'path';

import { TIMEZONE } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import type { RegisteredGroup } from './types.js';

export interface HeartbeatConfig {
  /** Interval in milliseconds (default: 30 minutes) */
  intervalMs: number;
  /** Active hours — heartbeat only runs during this window */
  activeHours?: { start: number; end: number };
}

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_ACTIVE_HOURS = { start: 8, end: 23 }; // 08:00 ~ 23:00

const HEARTBEAT_PROMPT_PREFIX =
  'HEARTBEAT.md가 있으면 읽고 지시를 따라라. 할 일이 없으면 HEARTBEAT_OK만 응답.';

/**
 * Check if current time is within active hours.
 */
function isWithinActiveHours(hours: { start: number; end: number }): boolean {
  const now = new Date();
  // Use timezone-aware hour
  const currentHour = parseInt(
    now.toLocaleString('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: TIMEZONE,
    }),
    10,
  );
  if (hours.start <= hours.end) {
    return currentHour >= hours.start && currentHour < hours.end;
  }
  // Wraps midnight (e.g., 22:00 ~ 06:00)
  return currentHour >= hours.start || currentHour < hours.end;
}

/**
 * Build the heartbeat prompt by reading HEARTBEAT.md from the group folder.
 */
export function buildHeartbeatPrompt(groupFolder: string): string | null {
  const groupDir = resolveGroupFolderPath(groupFolder);
  const heartbeatPath = path.join(groupDir, 'HEARTBEAT.md');

  if (!fs.existsSync(heartbeatPath)) {
    return null;
  }

  const content = fs.readFileSync(heartbeatPath, 'utf-8').trim();
  if (!content) return null;

  return `${HEARTBEAT_PROMPT_PREFIX}\n\n${content}`;
}

/**
 * Check if agent response is HEARTBEAT_OK (suppress delivery).
 */
export function isHeartbeatOk(result: string | null): boolean {
  if (!result) return true;
  const trimmed = result.trim();
  return trimmed === 'HEARTBEAT_OK' || trimmed.startsWith('HEARTBEAT_OK');
}

/**
 * Start the heartbeat loop for the main group.
 */
export function startHeartbeatLoop(deps: {
  getMainGroup: () => { jid: string; group: RegisteredGroup } | null;
  runAgent: (
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    onOutput?: (output: {
      status: string;
      result: string | null;
    }) => Promise<void>,
  ) => Promise<'success' | 'error'>;
  sendMessage: (jid: string, text: string) => Promise<void>;
  config?: HeartbeatConfig;
}): void {
  const intervalMs = deps.config?.intervalMs || DEFAULT_INTERVAL_MS;
  const activeHours = deps.config?.activeHours || DEFAULT_ACTIVE_HOURS;

  logger.info({ intervalMs, activeHours }, 'Heartbeat loop started');

  const tick = async () => {
    try {
      // Check active hours
      if (!isWithinActiveHours(activeHours)) {
        logger.debug('Heartbeat skipped: outside active hours');
        return;
      }

      const main = deps.getMainGroup();
      if (!main) {
        logger.debug('Heartbeat skipped: no main group');
        return;
      }

      const prompt = buildHeartbeatPrompt(main.group.folder);
      if (!prompt) {
        logger.debug('Heartbeat skipped: no HEARTBEAT.md');
        return;
      }

      logger.info({ group: main.group.name }, 'Heartbeat tick');

      // Collect results — runs in main session (context_mode: group)
      let lastResult: string | null = null;
      const result = await deps.runAgent(
        main.group,
        prompt,
        main.jid,
        async (output) => {
          if (output.result) {
            lastResult = output.result;
          }
        },
      );

      if (result === 'error') {
        logger.warn('Heartbeat agent returned error');
        return;
      }

      // Suppress HEARTBEAT_OK — don't send to user
      if (isHeartbeatOk(lastResult)) {
        logger.debug('Heartbeat: nothing to report (HEARTBEAT_OK)');
        return;
      }

      // Agent has something to report — it will have used send_message already
      // or the result will be delivered by the normal output pipeline
      logger.info('Heartbeat: agent reported activity');
    } catch (err) {
      logger.error({ err }, 'Heartbeat error');
    }
  };

  // First tick after a short delay, then regular interval
  setTimeout(() => {
    tick();
    setInterval(tick, intervalMs);
  }, 60_000); // Wait 1 minute after startup
}
