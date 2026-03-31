import os from 'os';

import { logger } from './logger.js';
import { formatUsageSummary } from './token-tracker.js';
import { getCooldownInfo } from './provider-fallback.js';
import { getTokenStatus, getTokenCount } from './token-rotation.js';

export interface DashboardState {
  uptime: number;
  activeGroups: string[];
  tokenSummary: string;
  providerStatus: string;
  systemInfo: string;
}

const startedAt = Date.now();

export function buildDashboardState(deps: {
  getActiveGroups: () => string[];
}): DashboardState {
  const activeGroups = deps.getActiveGroups();

  // Provider status
  const cooldown = getCooldownInfo();
  let providerStatus = '\u2705 Claude (Active)';
  if (cooldown.active) {
    const remainMin = Math.ceil((cooldown.remainingMs || 0) / 60000);
    providerStatus = `\u26A0\uFE0F Fallback (Claude cooldown: ${remainMin}m \u2014 ${cooldown.reason})`;
  }

  // Token rotation
  const tokenCount = getTokenCount();
  if (tokenCount > 1) {
    const statuses = getTokenStatus();
    const available = statuses.filter(s => s.available).length;
    providerStatus += `\n\u2022 Tokens: ${available}/${tokenCount} available`;
  }

  // System info
  const memUsed = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const loadAvg = os.loadavg()[0].toFixed(2);
  const uptime = Math.round((Date.now() - startedAt) / 1000);
  const systemInfo = `CPU: ${loadAvg} | RAM: ${memUsed}MB | Uptime: ${formatUptime(uptime)}`;

  return {
    uptime,
    activeGroups,
    tokenSummary: formatUsageSummary(),
    providerStatus,
    systemInfo,
  };
}

export function formatDashboardMessage(state: DashboardState): string {
  const lines = [
    '\u{1F4CA} NanoClaw Status Dashboard',
    '\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
    '',
    `\u{1F916} Active: ${state.activeGroups.length > 0 ? state.activeGroups.join(', ') : 'None'}`,
    '',
    state.tokenSummary,
    '',
    `\u{1F50C} Provider: ${state.providerStatus}`,
    '',
    `\u{1F4BB} ${state.systemInfo}`,
  ];
  return lines.join('\n');
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
