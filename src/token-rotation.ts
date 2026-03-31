import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const STATE_FILE = path.join(DATA_DIR, 'token-rotation-state.json');

/**
 * Read Claude OAuth token from macOS Keychain.
 * Falls back to null if not available (non-macOS, keychain locked, etc.)
 */
function readKeychainOAuthToken(): string | null {
  try {
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    if (!raw) {
      logger.debug('Keychain returned empty value');
      return null;
    }
    const data = JSON.parse(raw);
    const token = data?.claudeAiOauth?.accessToken;
    if (token && typeof token === 'string') {
      return token;
    }
    logger.debug('Keychain entry found but no accessToken in claudeAiOauth');
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'Keychain read failed');
  }
  return null;
}

/**
 * Refresh Codex CLI auth token if expired.
 * Reads ~/.codex/auth.json and runs `codex auth refresh` if needed.
 */
export function refreshCodexToken(): void {
  const authFile = path.join(process.env.HOME || '', '.codex', 'auth.json');
  try {
    if (!fs.existsSync(authFile)) return;
    const data = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
    const idToken = data?.tokens?.id_token;
    if (!idToken) return;

    // Decode JWT to check expiry
    const parts = idToken.split('.');
    if (parts.length < 2) return;
    const payload = JSON.parse(
      Buffer.from(parts[1] + '='.repeat(4 - (parts[1].length % 4)), 'base64').toString(),
    );
    const exp = payload?.exp;
    if (!exp || Date.now() / 1000 < exp - 300) return; // 5 min buffer

    logger.info('Codex token expired or expiring soon, attempting refresh');
    execSync('codex auth refresh 2>/dev/null || true', {
      timeout: 15000,
      encoding: 'utf-8',
    });
    logger.info('Codex token refresh attempted');
  } catch (err) {
    logger.debug({ err }, 'Codex token refresh skipped');
  }
}

interface TokenState {
  token: string;
  cooldownUntil: number;
  failures: number;
}

const tokens: TokenState[] = [];
let currentIndex = 0;
let initialized = false;

export function initTokenRotation(): void {
  if (initialized) return;
  initialized = true;

  const envFile = readEnvFile(['CLAUDE_CODE_OAUTH_TOKENS', 'CLAUDE_CODE_OAUTH_TOKEN']);
  const multi = (process.env.CLAUDE_CODE_OAUTH_TOKENS || envFile.CLAUDE_CODE_OAUTH_TOKENS || '').trim() || undefined;
  let single = (process.env.CLAUDE_CODE_OAUTH_TOKEN || envFile.CLAUDE_CODE_OAUTH_TOKEN || '').trim() || undefined;

  // Auto-read from macOS Keychain if no token in .env/environment
  if (!multi && !single) {
    logger.info('No OAuth token in env/file, trying macOS Keychain...');
    const keychainToken = readKeychainOAuthToken();
    if (keychainToken) {
      single = keychainToken;
      logger.info({ tokenPrefix: keychainToken.slice(0, 20) }, 'OAuth token loaded from macOS Keychain');
    } else {
      logger.warn('Failed to load OAuth token from macOS Keychain');
    }
  }

  const raw = multi
    ? multi.split(',').map(t => t.trim()).filter(Boolean)
    : single ? [single] : [];

  for (const token of raw) {
    tokens.push({ token, cooldownUntil: 0, failures: 0 });
  }

  if (tokens.length > 1) {
    loadState();
    logger.info({ count: tokens.length, activeIndex: currentIndex }, 'Token rotation initialized');
  } else if (tokens.length === 1) {
    logger.info('Single token mode (no rotation)');
  } else {
    logger.warn('No OAuth tokens configured');
  }

  // Refresh Codex token if expired
  refreshCodexToken();
}

function loadState(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      if (typeof data.currentIndex === 'number' && data.currentIndex < tokens.length) {
        currentIndex = data.currentIndex;
      }
      if (Array.isArray(data.cooldowns)) {
        for (let i = 0; i < Math.min(data.cooldowns.length, tokens.length); i++) {
          tokens[i].cooldownUntil = data.cooldowns[i] || 0;
        }
      }
    }
  } catch { /* start fresh */ }
}

function saveState(): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      currentIndex,
      cooldowns: tokens.map(t => t.cooldownUntil),
    }));
  } catch { /* best effort */ }
}

/**
 * Try to refresh the token from Keychain when current token fails.
 * Returns true if a new token was loaded.
 */
function tryRefreshFromKeychain(): boolean {
  const fresh = readKeychainOAuthToken();
  if (!fresh) return false;

  if (tokens.length > 0 && tokens[currentIndex].token === fresh) return false;

  if (tokens.length === 0) {
    tokens.push({ token: fresh, cooldownUntil: 0, failures: 0 });
  } else {
    tokens[currentIndex].token = fresh;
    tokens[currentIndex].cooldownUntil = 0;
    tokens[currentIndex].failures = 0;
  }
  logger.info('OAuth token refreshed from macOS Keychain');
  return true;
}

export function getCurrentToken(): string | null {
  if (tokens.length === 0) {
    // Try Keychain as last resort
    tryRefreshFromKeychain();
    if (tokens.length === 0) return null;
  }
  const now = Date.now();

  // Try current token first
  if (tokens[currentIndex].cooldownUntil <= now) {
    return tokens[currentIndex].token;
  }

  // Find any available token
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].cooldownUntil <= now) {
      currentIndex = i;
      saveState();
      return tokens[i].token;
    }
  }

  // All in cooldown — return the one that expires soonest
  let soonest = 0;
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].cooldownUntil < tokens[soonest].cooldownUntil) {
      soonest = i;
    }
  }
  currentIndex = soonest;
  saveState();
  return tokens[soonest].token;
}

export function markTokenRateLimited(retryAfterMs?: number): void {
  if (tokens.length === 0) return;
  const cooldownMs = retryAfterMs || 3600000; // Default 1 hour
  tokens[currentIndex].cooldownUntil = Date.now() + cooldownMs;
  tokens[currentIndex].failures++;
  logger.warn({
    index: currentIndex,
    cooldownMs,
    failures: tokens[currentIndex].failures,
  }, 'Token marked rate-limited');

  // Try refreshing from Keychain before rotating
  if (tryRefreshFromKeychain()) {
    logger.info('Token refreshed from Keychain after rate limit');
    saveState();
    return;
  }

  // Rotate to next available
  const oldIndex = currentIndex;
  for (let i = 1; i < tokens.length; i++) {
    const nextIndex = (currentIndex + i) % tokens.length;
    if (tokens[nextIndex].cooldownUntil <= Date.now()) {
      currentIndex = nextIndex;
      logger.info({ from: oldIndex, to: currentIndex }, 'Rotated to next token');
      break;
    }
  }
  saveState();
}

export function markTokenHealthy(): void {
  if (tokens.length === 0) return;
  tokens[currentIndex].cooldownUntil = 0;
  tokens[currentIndex].failures = 0;
  saveState();
}

export function getTokenCount(): number {
  return tokens.length;
}

export function getTokenStatus(): Array<{ index: number; available: boolean; cooldownUntil: number; failures: number }> {
  return tokens.map((t, i) => ({
    index: i,
    available: t.cooldownUntil <= Date.now(),
    cooldownUntil: t.cooldownUntil,
    failures: t.failures,
  }));
}
