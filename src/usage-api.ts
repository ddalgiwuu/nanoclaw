import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const CACHE_FILE = path.join(DATA_DIR, 'usage-cache.json');
const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE_ENDPOINT = 'https://api.anthropic.com/api/oauth/profile';
const FETCH_TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 300000; // 5 minutes

export interface UsageWindow {
  utilization: number;
  resets_at: string;
}

export interface ClaudeUsageData {
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
  seven_day_sonnet?: UsageWindow;
  seven_day_opus?: UsageWindow;
  fetchedAt: number;
}

export interface ClaudeProfile {
  email: string;
  plan?: string;
}

let usageCache: ClaudeUsageData | null = null;
let profileCache: ClaudeProfile | null = null;

function loadCache(): void {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      if (data.fetchedAt && Date.now() - data.fetchedAt < CACHE_TTL_MS * 12) {
        // 1 hour max stale
        usageCache = data;
      }
    }
  } catch {
    /* start fresh */
  }
}

function saveCache(data: ClaudeUsageData): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
  } catch {
    /* best effort */
  }
}

export async function fetchClaudeUsage(
  oauthToken: string,
): Promise<ClaudeUsageData | null> {
  // Check cache
  if (usageCache && Date.now() - usageCache.fetchedAt < CACHE_TTL_MS) {
    return usageCache;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(USAGE_ENDPOINT, {
      headers: { Authorization: `Bearer ${oauthToken}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      logger.warn({ status: res.status }, 'Usage API request failed');
      return usageCache; // Return stale cache
    }

    const body = (await res.json()) as Record<string, any>;
    const data: ClaudeUsageData = {
      five_hour: body.five_hour
        ? {
            utilization: body.five_hour.utilization,
            resets_at: body.five_hour.resets_at || '',
          }
        : undefined,
      seven_day: body.seven_day
        ? {
            utilization: body.seven_day.utilization,
            resets_at: body.seven_day.resets_at || '',
          }
        : undefined,
      seven_day_sonnet: body.seven_day_sonnet
        ? {
            utilization: body.seven_day_sonnet.utilization,
            resets_at: body.seven_day_sonnet.resets_at || '',
          }
        : undefined,
      seven_day_opus: body.seven_day_opus
        ? {
            utilization: body.seven_day_opus.utilization,
            resets_at: body.seven_day_opus.resets_at || '',
          }
        : undefined,
      fetchedAt: Date.now(),
    };

    usageCache = data;
    saveCache(data);
    return data;
  } catch (err) {
    logger.error({ err }, 'Failed to fetch Claude usage');
    loadCache(); // Try stale cache
    return usageCache;
  }
}

export async function fetchClaudeProfile(
  oauthToken: string,
): Promise<ClaudeProfile | null> {
  if (profileCache) return profileCache;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(PROFILE_ENDPOINT, {
      headers: { Authorization: `Bearer ${oauthToken}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const body = (await res.json()) as Record<string, any>;
    profileCache = { email: body.email || '', plan: body.plan };
    return profileCache;
  } catch {
    return null;
  }
}

export function formatUsageReport(data: ClaudeUsageData): string {
  const lines: string[] = ['\u{1F4CA} Claude Usage'];

  if (data.five_hour) {
    const pct = Math.round(data.five_hour.utilization * 100);
    const bar = progressBar(pct);
    lines.push(
      `\u2022 5h: ${bar} ${pct}%${data.five_hour.resets_at ? ` (resets ${formatTime(data.five_hour.resets_at)})` : ''}`,
    );
  }
  if (data.seven_day) {
    const pct = Math.round(data.seven_day.utilization * 100);
    lines.push(`\u2022 7d: ${progressBar(pct)} ${pct}%`);
  }
  if (data.seven_day_sonnet) {
    const pct = Math.round(data.seven_day_sonnet.utilization * 100);
    lines.push(`\u2022 7d Sonnet: ${progressBar(pct)} ${pct}%`);
  }
  if (data.seven_day_opus) {
    const pct = Math.round(data.seven_day_opus.utilization * 100);
    lines.push(`\u2022 7d Opus: ${progressBar(pct)} ${pct}%`);
  }

  return lines.join('\n');
}

function progressBar(pct: number): string {
  const filled = Math.round(pct / 10);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);
}

function formatTime(isoStr: string): string {
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoStr;
  }
}

export function getCachedUsage(): ClaudeUsageData | null {
  if (!usageCache) loadCache();
  return usageCache;
}
