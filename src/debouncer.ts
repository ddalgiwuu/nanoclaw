import { createHash } from 'crypto';

interface DebouncedEntry {
  hash: string;
  expiresAt: number;
}

export class MessageDebouncer {
  private entries = new Map<string, DebouncedEntry>();
  private windowMs: number;

  constructor(windowMs = 5000) {
    this.windowMs = windowMs;
  }

  shouldProcess(chatJid: string, content: string): boolean {
    this.cleanup();
    const hash = createHash('sha256').update(`${chatJid}:${content}`).digest('hex').slice(0, 16);
    const key = `${chatJid}:${hash}`;
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > Date.now()) {
      return false; // duplicate within window
    }
    this.entries.set(key, { hash, expiresAt: Date.now() + this.windowMs });
    return true;
  }

  reset(chatJid: string): void {
    for (const [key] of this.entries) {
      if (key.startsWith(`${chatJid}:`)) {
        this.entries.delete(key);
      }
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}
