/**
 * Usage Dashboard
 *
 * Fetches Claude usage data from the Anthropic OAuth API,
 * caches to disk, and formats for display.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

// ── Types ──

export interface ClaudeUsageData {
  five_hour?: { utilization: number; resets_at: string };
  seven_day?: { utilization: number; resets_at: string };
  seven_day_sonnet?: { utilization: number; resets_at: string };
  seven_day_opus?: { utilization: number; resets_at: string };
}

interface UsageApiResponse {
  five_hour?: { utilization: number; resets_at?: string };
  seven_day?: { utilization: number; resets_at?: string };
  seven_day_sonnet?: { utilization: number; resets_at?: string };
  seven_day_opus?: { utilization: number; resets_at?: string };
}

interface UsageCacheEntry {
  usage: ClaudeUsageData;
  fetchedAt: number;
  lastAttemptAt?: number;
}

// ── Constants ──

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const FETCH_TIMEOUT_MS = 10_000;
const MIN_FETCH_INTERVAL_MS = 300_000; // 5 minutes
const USAGE_CACHE_FILE = path.join(DATA_DIR, 'claude-usage-cache.json');

// ── Disk cache ──

let usageDiskCache: Record<string, UsageCacheEntry> = {};
let diskCacheLoaded = false;

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadUsageDiskCache(): void {
  if (diskCacheLoaded) return;
  diskCacheLoaded = true;
  usageDiskCache =
    readJsonFile<Record<string, UsageCacheEntry>>(USAGE_CACHE_FILE) ?? {};
}

function saveUsageDiskCache(): void {
  try {
    writeJsonFile(USAGE_CACHE_FILE, usageDiskCache);
  } catch {
    /* best effort */
  }
}

function tokenCacheKey(token: string): string {
  return token.slice(-8);
}

function mapWindow(w?: {
  utilization: number;
  resets_at?: string;
}): { utilization: number; resets_at: string } | undefined {
  if (!w) return undefined;
  return { utilization: w.utilization, resets_at: w.resets_at || '' };
}

// ── Fetch usage for a single token ──

async function fetchUsageForToken(
  token: string,
): Promise<ClaudeUsageData | null> {
  loadUsageDiskCache();

  const cacheKey = tokenCacheKey(token);
  const cached = usageDiskCache[cacheKey];
  const lastAttempt = cached?.lastAttemptAt ?? cached?.fetchedAt ?? 0;

  if (cached && Date.now() - lastAttempt < MIN_FETCH_INTERVAL_MS) {
    return cached.usage;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(USAGE_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'nanoclaw/1.0',
      },
      signal: controller.signal,
    });

    if (res.status === 401) {
      logger.warn({ cacheKey }, 'Claude usage API: token expired or invalid (401)');
      return null;
    }
    if (res.status === 429) {
      logger.warn({ cacheKey }, 'Claude usage API: rate limited (429), returning cached');
      if (cached) {
        cached.lastAttemptAt = Date.now();
        saveUsageDiskCache();
      }
      return cached?.usage ?? null;
    }
    if (!res.ok) {
      logger.warn({ status: res.status, cacheKey }, `Claude usage API: unexpected status ${res.status}`);
      if (cached) {
        cached.lastAttemptAt = Date.now();
        saveUsageDiskCache();
      }
      return cached?.usage ?? null;
    }

    const data = (await res.json()) as UsageApiResponse;
    const result: ClaudeUsageData = {
      five_hour: mapWindow(data.five_hour),
      seven_day: mapWindow(data.seven_day),
      seven_day_sonnet: mapWindow(data.seven_day_sonnet),
      seven_day_opus: mapWindow(data.seven_day_opus),
    };

    const now = Date.now();
    usageDiskCache[cacheKey] = { usage: result, fetchedAt: now, lastAttemptAt: now };
    saveUsageDiskCache();

    logger.debug(
      { cacheKey, h5: result.five_hour?.utilization, d7: result.seven_day?.utilization },
      'Claude usage API: fetched successfully',
    );

    return result;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      logger.warn({ cacheKey }, 'Claude usage API: request timed out');
    } else {
      logger.warn({ err, cacheKey }, 'Claude usage API: fetch failed');
    }
    if (cached) {
      cached.lastAttemptAt = Date.now();
      saveUsageDiskCache();
    }
    return cached?.usage ?? null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Public API ──

/**
 * Fetch Claude usage data using the CLAUDE_CODE_OAUTH_TOKEN env var.
 */
export async function fetchClaudeUsage(): Promise<ClaudeUsageData | null> {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    logger.debug('No Claude OAuth token available for usage check');
    return null;
  }
  return fetchUsageForToken(token);
}

/**
 * Format a utilization ratio as a percentage bar.
 */
function formatBar(utilization: number): string {
  const pct = Math.round(utilization * 100);
  const filled = Math.round(pct / 5); // 20-char bar
  const bar = '#'.repeat(filled) + '-'.repeat(20 - filled);
  return `[${bar}] ${pct}%`;
}

/**
 * Format a reset timestamp as relative time from now.
 */
function formatResetIn(resetsAt: string): string {
  if (!resetsAt) return '';
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return remainMin > 0 ? `${hours}h ${remainMin}m` : `${hours}h`;
}

/**
 * Fetch usage and return a formatted multi-line string for display.
 * Returns null if no token is configured or fetch fails entirely.
 */
export async function getFormattedUsage(): Promise<string | null> {
  const usage = await fetchClaudeUsage();
  if (!usage) return null;

  const lines: string[] = ['Claude Usage'];

  if (usage.five_hour) {
    lines.push(
      `  5h:  ${formatBar(usage.five_hour.utilization)}  resets in ${formatResetIn(usage.five_hour.resets_at)}`,
    );
  }

  if (usage.seven_day) {
    lines.push(
      `  7d:  ${formatBar(usage.seven_day.utilization)}  resets in ${formatResetIn(usage.seven_day.resets_at)}`,
    );
  }

  if (usage.seven_day_sonnet) {
    lines.push(
      `  7d (Sonnet): ${formatBar(usage.seven_day_sonnet.utilization)}  resets in ${formatResetIn(usage.seven_day_sonnet.resets_at)}`,
    );
  }

  if (usage.seven_day_opus) {
    lines.push(
      `  7d (Opus):   ${formatBar(usage.seven_day_opus.utilization)}  resets in ${formatResetIn(usage.seven_day_opus.resets_at)}`,
    );
  }

  return lines.length > 1 ? lines.join('\n') : null;
}
