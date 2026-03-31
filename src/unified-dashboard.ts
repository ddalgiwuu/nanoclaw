/**
 * Unified Dashboard — status + usage combined into one message.
 *
 * Ported from EJClaw's split dashboard (unified-dashboard, dashboard-render,
 * dashboard-status-content, dashboard-usage-rows) into a single NanoClaw module.
 *
 * Shows:
 *   - Room status by category with elapsed time and active/idle status
 *   - Claude usage (5h, 7d buckets) from usage-dashboard.ts
 *   - Server resource info (CPU, memory, disk, uptime)
 *   - Periodic auto-refresh via startDashboard()
 */

import { execSync } from 'child_process';
import os from 'os';

import { logger } from './logger.js';
import { DATA_DIR } from './config.js';
import { getAllChats, getAllRegisteredGroups, getAllTasks } from './db.js';
import { fetchClaudeUsage, type ClaudeUsageData } from './usage-dashboard.js';
import { getCooldownInfo } from './provider-fallback.js';
import { getTokenCount, getTokenStatus } from './token-rotation.js';
import type { RegisteredGroup, ScheduledTask } from './types.js';

// ── Types ────────────────────────────────────────────────────────

export interface UsageRow {
  name: string;
  /** 5-hour utilization percentage (0–100), -1 = unavailable */
  h5pct: number;
  h5reset: string;
  /** 7-day utilization percentage (0–100), -1 = unavailable */
  d7pct: number;
  d7reset: string;
}

export interface DashboardRoomLine {
  category: string;
  categoryPosition: number;
  position: number;
  line: string;
}

export interface RoomStatus {
  jid: string;
  name: string;
  status: '처리 중' | '큐 대기' | '비활성';
  elapsedMs: number | null;
  pendingTasks: number;
}

export interface UnifiedDashboardOptions {
  /** Callback returning current room statuses */
  getRoomStatuses: () => RoomStatus[];
  /** How often to refresh (ms). Default: 30_000 */
  refreshIntervalMs?: number;
  /** Callback to send/edit the dashboard message */
  sendOrEdit: (content: string) => Promise<void>;
}

// ── Helpers ──────────────────────────────────────────────────────

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m${rem.toString().padStart(2, '0')}s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h < 24) return `${h}h${m.toString().padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return `${d}d${remH}h`;
}

export function getStatusLabel(status: RoomStatus): string {
  if (status.status === '처리 중') {
    return `처리 중 (${formatElapsed(status.elapsedMs || 0)})`;
  }
  if (status.status === '큐 대기') {
    return status.pendingTasks > 0
      ? `큐 대기 (태스크 ${status.pendingTasks}개)`
      : '큐 대기 (메시지)';
  }
  return '비활성';
}

function bar(pct: number): string {
  const filled = Math.max(0, Math.min(5, Math.round(pct / 20)));
  return '\u2588'.repeat(filled) + '\u2591'.repeat(5 - filled);
}

export function formatResetRemaining(value: string | number): string {
  if (value === '' || value == null) return '';
  try {
    const date =
      typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const diffMs = date.getTime() - Date.now();
    if (diffMs <= 0) return ' reset';
    const hours = Math.floor(diffMs / 3_600_000);
    const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      const remH = hours % 24;
      return `${String(days).padStart(2)}d ${String(remH).padStart(2)}h`;
    }
    return `${String(hours).padStart(2)}h ${String(minutes).padStart(2)}m`;
  } catch {
    return String(value).padStart(6);
  }
}

// ── Status Section ───────────────────────────────────────────────

function buildStatusSection(rooms: RoomStatus[]): string {
  if (rooms.length === 0) return '';

  const totalActive = rooms.filter((r) => r.status === '처리 중').length;
  const totalWaiting = rooms.filter((r) => r.status === '큐 대기').length;

  const header = `**에이전트 상태** — 활성 ${totalActive} | 큐대기 ${totalWaiting} | 전체 ${rooms.length}`;

  const roomLines = rooms.map((room) => {
    const icon =
      room.status === '처리 중'
        ? '\uD83D\uDFE1'
        : room.status === '큐 대기'
          ? '\uD83D\uDD35'
          : '\u26AA';
    return `  **${room.name}** — ${icon} ${getStatusLabel(room)}`;
  });

  return `${header}\n\n${roomLines.join('\n')}`;
}

// ── Usage Section ────────────────────────────────────────────────

function buildClaudeUsageRows(usage: ClaudeUsageData): UsageRow[] {
  const normalize = (u: number) =>
    u > 1 ? Math.round(u) : Math.round(u * 100);

  const rows: UsageRow[] = [];

  if (usage.five_hour || usage.seven_day) {
    rows.push({
      name: 'Claude',
      h5pct: usage.five_hour ? normalize(usage.five_hour.utilization) : -1,
      h5reset: usage.five_hour
        ? formatResetRemaining(usage.five_hour.resets_at)
        : '',
      d7pct: usage.seven_day ? normalize(usage.seven_day.utilization) : -1,
      d7reset: usage.seven_day
        ? formatResetRemaining(usage.seven_day.resets_at)
        : '',
    });
  }

  if (usage.seven_day_sonnet) {
    rows.push({
      name: 'Sonnet',
      h5pct: -1,
      h5reset: '',
      d7pct: normalize(usage.seven_day_sonnet.utilization),
      d7reset: formatResetRemaining(usage.seven_day_sonnet.resets_at),
    });
  }

  if (usage.seven_day_opus) {
    rows.push({
      name: 'Opus',
      h5pct: -1,
      h5reset: '',
      d7pct: normalize(usage.seven_day_opus.utilization),
      d7reset: formatResetRemaining(usage.seven_day_opus.resets_at),
    });
  }

  return rows;
}

async function buildUsageSection(): Promise<string> {
  const lines: string[] = ['\uD83D\uDCCA *\uC0AC\uC6A9\uB7C9*']; // 사용량

  const rows: UsageRow[] = [];

  try {
    const usage = await fetchClaudeUsage();
    if (usage) {
      rows.push(...buildClaudeUsageRows(usage));
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch Claude usage for dashboard');
  }

  if (rows.length > 0) {
    const visualWidth = (s: string) =>
      [...s].reduce((w, c) => w + ((c.codePointAt(0) ?? 0) > 0x7f ? 2 : 1), 0);
    const maxNameWidth =
      Math.max(10, ...rows.map((r) => visualWidth(r.name))) + 3;
    const padName = (s: string) =>
      s + ' '.repeat(Math.max(0, maxNameWidth - visualWidth(s)));
    const compactReset = (s: string) =>
      s ? s.replace(/\s+/g, '').replace(/m$/, '') : '';
    const colGap = '   ';

    lines.push('```');
    lines.push(`${' '.repeat(maxNameWidth)}5h${' '.repeat(9)}${colGap}7d`);
    lines.push('');
    for (const row of rows) {
      const h5 =
        row.h5pct >= 0
          ? `${bar(row.h5pct)} ${String(row.h5pct).padStart(3)}%`
          : '  \u2014     ';
      const d7 =
        row.d7pct >= 0
          ? `${bar(row.d7pct)} ${String(row.d7pct).padStart(3)}%`
          : '  \u2014     ';
      lines.push(`${padName(row.name)}${h5}${colGap}${d7}`);
      const r5 = compactReset(row.h5reset);
      const r7 = compactReset(row.d7reset);
      if (r5 || r7) {
        const h5ColWidth = 11; // bar(5) + space + 3digit + %
        const d7ColStart = maxNameWidth + h5ColWidth + colGap.length;
        let resetLine = ' '.repeat(maxNameWidth);
        if (r5) resetLine += r5;
        resetLine = resetLine.padEnd(d7ColStart);
        if (r7) resetLine += r7;
        lines.push(resetLine);
      }
      lines.push('');
    }
    lines.push('```');
  } else {
    lines.push('_\uC870\uD68C \uBD88\uAC00_'); // 조회 불가
  }

  // Provider status
  const cooldown = getCooldownInfo();
  if (cooldown.active) {
    const remainMin = Math.ceil((cooldown.remainingMs || 0) / 60000);
    lines.push(
      `\u26A0\uFE0F Fallback \uD65C\uC131 (${cooldown.reason}, ${remainMin}m \uB0A8\uC74C)`,
    );
  }

  // Token rotation status
  const tokenCount = getTokenCount();
  if (tokenCount > 1) {
    const statuses = getTokenStatus();
    const available = statuses.filter((s) => s.available).length;
    lines.push(
      `\uD83D\uDD11 \uD1A0\uD070: ${available}/${tokenCount} \uC0AC\uC6A9\uAC00\uB2A5`,
    );
  }

  return lines.join('\n');
}

// ── Server Section ───────────────────────────────────────────────

function buildServerSection(): string {
  const lines: string[] = ['\uD83D\uDDA5\uFE0F *\uC11C\uBC84*']; // 서버

  const loadAvg = os.loadavg();
  const cpuCount = os.cpus().length;
  const cpuPct = Math.round((loadAvg[1] / cpuCount) * 100);
  const totalMem = os.totalmem();
  const usedMem = totalMem - os.freemem();
  const memPct = Math.round((usedMem / totalMem) * 100);
  const memUsedGB = (usedMem / 1073741824).toFixed(1);
  const memTotalGB = (totalMem / 1073741824).toFixed(1);

  let diskPct = 0;
  let diskUsedGB = '?';
  let diskTotalGB = '?';
  try {
    const df = execSync('df -g / | tail -1', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const parts = df.split(/\s+/);
    // macOS df -g: filesystem blocks used available capacity
    const diskTotal = parseInt(parts[1], 10);
    const diskUsed = parseInt(parts[2], 10);
    if (diskTotal > 0) {
      diskPct = Math.round((diskUsed / diskTotal) * 100);
      diskUsedGB = String(diskUsed);
      diskTotalGB = String(diskTotal);
    }
  } catch {
    /* ignore */
  }

  lines.push('```');
  lines.push(`${'CPU'.padEnd(8)}${bar(cpuPct)} ${String(cpuPct).padStart(3)}%`);
  lines.push(
    `${'Memory'.padEnd(8)}${bar(memPct)} ${String(memPct).padStart(3)}%  ${memUsedGB}/${memTotalGB}GB`,
  );
  lines.push(
    `${'Disk'.padEnd(8)}${bar(diskPct)} ${String(diskPct).padStart(3)}%  ${diskUsedGB}/${diskTotalGB}GB`,
  );
  lines.push(`${'Uptime'.padEnd(8)}${formatElapsed(os.uptime() * 1000)}`);
  lines.push('```');

  return lines.join('\n');
}

// ── Compose ──────────────────────────────────────────────────────

let cachedUsageContent = '';
let usageUpdateInProgress = false;

async function refreshUsageCache(): Promise<void> {
  if (usageUpdateInProgress) return;
  usageUpdateInProgress = true;
  try {
    cachedUsageContent = await buildUsageSection();
  } catch (err) {
    logger.warn({ err }, 'Failed to build usage content');
  } finally {
    usageUpdateInProgress = false;
  }
}

/**
 * Build the full unified dashboard content string.
 */
export function buildUnifiedDashboard(rooms: RoomStatus[]): string {
  const sections: string[] = [];

  // Status section
  const statusContent = buildStatusSection(rooms);
  if (statusContent) sections.push(statusContent);

  // Usage section (cached)
  if (cachedUsageContent) sections.push(cachedUsageContent);

  // Server section
  sections.push(buildServerSection());

  // Timestamp
  const now = new Date();
  sections.push(
    `_${now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}_`,
  );

  return sections.filter(Boolean).join('\n\n');
}

/**
 * Start the unified dashboard with periodic refresh.
 *
 * @returns cleanup function to stop the intervals
 */
export async function startDashboard(
  opts: UnifiedDashboardOptions,
): Promise<() => void> {
  const refreshMs = opts.refreshIntervalMs ?? 30_000;

  // Initial usage cache fill
  await refreshUsageCache();

  const update = async () => {
    try {
      const rooms = opts.getRoomStatuses();
      const content = buildUnifiedDashboard(rooms);
      await opts.sendOrEdit(content);
    } catch (err) {
      logger.warn({ err }, 'Dashboard update failed');
    }
  };

  // Run immediately then on interval
  await update();

  const statusInterval = setInterval(update, refreshMs);
  const usageInterval = setInterval(refreshUsageCache, 300_000); // 5 min usage refresh

  logger.info({ refreshMs }, 'Unified dashboard started');

  return () => {
    clearInterval(statusInterval);
    clearInterval(usageInterval);
  };
}
