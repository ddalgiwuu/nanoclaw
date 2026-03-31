import { logger } from './logger.js';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'adaptive';

interface SessionState {
  sessionId: string;
  thinkingLevel: ThinkingLevel;
  activeAt: number;
}

const sessions = new Map<string, SessionState>();

export function initSessions(loaded: Record<string, string>): void {
  for (const [folder, sessionId] of Object.entries(loaded)) {
    sessions.set(folder, { sessionId, thinkingLevel: 'medium', activeAt: 0 });
  }
}

export function getSessionId(groupFolder: string): string | undefined {
  return sessions.get(groupFolder)?.sessionId;
}

export function setSessionId(groupFolder: string, sessionId: string): void {
  const existing = sessions.get(groupFolder);
  if (existing) {
    existing.sessionId = sessionId;
  } else {
    sessions.set(groupFolder, { sessionId, thinkingLevel: 'medium', activeAt: 0 });
  }
}

export function clearSessionId(groupFolder: string): void {
  sessions.delete(groupFolder);
}

export function getSessionThinkingLevel(groupFolder: string): ThinkingLevel {
  const saved = sessions.get(groupFolder)?.thinkingLevel;
  if (saved) return saved;
  // Discord channels get high thinking, Telegram gets medium (faster)
  return 'high'; // High thinking for deep work
}

export function setSessionThinkingLevel(groupFolder: string, level: ThinkingLevel): void {
  const existing = sessions.get(groupFolder);
  if (existing) {
    existing.thinkingLevel = level;
  } else {
    sessions.set(groupFolder, { sessionId: '', thinkingLevel: level, activeAt: 0 });
  }
}

export function markActive(groupFolder: string): void {
  const s = sessions.get(groupFolder);
  if (s) s.activeAt = Date.now();
}

export function markInactive(groupFolder: string): void {
  const s = sessions.get(groupFolder);
  if (s) s.activeAt = 0;
}

export function getActiveCount(): number {
  let count = 0;
  for (const s of sessions.values()) {
    if (s.activeAt > 0) count++;
  }
  return count;
}

export function getAllSessionEntries(): Array<{ groupFolder: string; sessionId: string; thinkingLevel: ThinkingLevel }> {
  const result: Array<{ groupFolder: string; sessionId: string; thinkingLevel: ThinkingLevel }> = [];
  for (const [folder, state] of sessions) {
    if (state.sessionId) {
      result.push({ groupFolder: folder, sessionId: state.sessionId, thinkingLevel: state.thinkingLevel });
    }
  }
  return result;
}

export function getSessionsDict(): Record<string, string> {
  const dict: Record<string, string> = {};
  for (const [folder, state] of sessions) {
    if (state.sessionId) dict[folder] = state.sessionId;
  }
  return dict;
}
