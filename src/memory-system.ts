import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

export interface MemoryPaths {
  dailyDir: string;
  todayLog: string;
  yesterdayLog: string;
  longTerm: string;
  global: string;
  sharedMemoryDir: string; // Claude Code shared memory directory
  projectMemory: string | null; // Project-level shared memory (e.g., borkd, nanoclaw)
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function getMemoryPaths(groupFolder: string): MemoryPaths {
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  const dailyDir = path.join(groupDir, 'memory', 'daily');
  const today = formatDate(new Date());
  const yesterday = formatDate(new Date(Date.now() - 86400000));

  // Shared memory from Claude Code (user's cross-session memory)
  const home = process.env.HOME || '';
  const sharedMemoryDir = path.join(
    home,
    '.claude',
    'projects',
    `-Users-${path.basename(home)}`,
    'memory',
  );

  // Project-level memory: discord_borkd-* → projects/borkd/MEMORY.md
  // Extract project name from folder pattern: discord_{project}-{channel}
  let projectMemory: string | null = null;
  const projectMatch = groupFolder.match(/^discord_([a-z0-9]+)-/);
  if (projectMatch) {
    const projectName = projectMatch[1];
    const projectMemoryPath = path.join(
      GROUPS_DIR,
      'projects',
      projectName,
      'MEMORY.md',
    );
    projectMemory = projectMemoryPath;
  }

  return {
    dailyDir,
    todayLog: path.join(dailyDir, `${today}.md`),
    yesterdayLog: path.join(dailyDir, `${yesterday}.md`),
    longTerm: path.join(groupDir, 'MEMORY.md'),
    global: path.join(GROUPS_DIR, 'global', 'MEMORY.md'),
    sharedMemoryDir,
    projectMemory,
  };
}

export function appendDailyLog(groupFolder: string, entry: string): void {
  const paths = getMemoryPaths(groupFolder);
  try {
    fs.mkdirSync(paths.dailyDir, { recursive: true });
    const timestamp = new Date().toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
    });
    fs.appendFileSync(paths.todayLog, `\n### ${timestamp}\n${entry}\n`);
  } catch (err) {
    logger.error({ groupFolder, err }, 'Failed to append daily log');
  }
}

export function assembleMemoryContext(groupFolder: string): string | null {
  const paths = getMemoryPaths(groupFolder);
  const parts: string[] = [];

  // Shared memory from Claude Code (cross-session user/project context)
  // Skip for telegram groups (too large for quick responses)
  const isDiscord = groupFolder.startsWith('discord_');
  try {
    if (isDiscord && fs.existsSync(paths.sharedMemoryDir)) {
      const files = fs
        .readdirSync(paths.sharedMemoryDir)
        .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
        .sort();
      const sharedParts: string[] = [];
      for (const file of files) {
        const filePath = path.join(paths.sharedMemoryDir, file);
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        if (content) {
          // Strip frontmatter (---...---)
          const stripped = content.replace(/^---[\s\S]*?---\s*/, '').trim();
          if (stripped) sharedParts.push(stripped);
        }
      }
      if (sharedParts.length > 0) {
        parts.push(
          `## Shared Memory (Cross-Session)\n${sharedParts.join('\n\n')}`,
        );
      }
    }
  } catch {
    /* ignore */
  }

  // Global MEMORY.md
  try {
    if (fs.existsSync(paths.global)) {
      const content = fs.readFileSync(paths.global, 'utf-8').trim();
      if (content) parts.push(`## Global Memory\n${content}`);
    }
  } catch {
    /* ignore */
  }

  // Project MEMORY.md (shared across project channels, e.g., all borkd-* channels)
  try {
    if (paths.projectMemory && fs.existsSync(paths.projectMemory)) {
      const content = fs.readFileSync(paths.projectMemory, 'utf-8').trim();
      if (content) parts.push(`## Project Memory\n${content}`);
    }
  } catch {
    /* ignore */
  }

  // Group MEMORY.md (channel-specific)
  try {
    if (fs.existsSync(paths.longTerm)) {
      const content = fs.readFileSync(paths.longTerm, 'utf-8').trim();
      if (content) parts.push(`## Channel Memory\n${content}`);
    }
  } catch {
    /* ignore */
  }

  // Yesterday's daily log
  try {
    if (fs.existsSync(paths.yesterdayLog)) {
      const content = fs.readFileSync(paths.yesterdayLog, 'utf-8').trim();
      if (content) parts.push(`## Yesterday's Notes\n${content}`);
    }
  } catch {
    /* ignore */
  }

  // Today's daily log
  try {
    if (fs.existsSync(paths.todayLog)) {
      const content = fs.readFileSync(paths.todayLog, 'utf-8').trim();
      if (content) parts.push(`## Today's Notes\n${content}`);
    }
  } catch {
    /* ignore */
  }

  if (parts.length === 0) return null;
  return parts.join('\n\n---\n\n');
}

export function flushMemoryBeforeCompact(groupFolder: string): void {
  // Before compaction, ensure MEMORY.md has critical info
  // This is a hook point — the agent itself decides what to flush
  logger.info({ groupFolder }, 'Memory flush before compact (hook point)');
}

/**
 * Create a ContextPlugin for the context engine (B8).
 * Import type from context-engine.ts
 */
export function createMemoryPlugin() {
  return {
    name: 'memory',
    async ingest(
      messages: Array<{
        content: string;
        sender_name: string;
        timestamp: string;
      }>,
      gf: string,
    ) {
      for (const msg of messages) {
        const summary = `[${msg.sender_name}] ${msg.content.slice(0, 200)}`;
        appendDailyLog(gf, summary);
      }
      logger.info(
        { groupFolder: gf, count: messages.length },
        'Memory ingest: daily log updated',
      );
    },
    async assemble(gf: string) {
      const result = assembleMemoryContext(gf);
      logger.info({ groupFolder: gf, hasMemory: !!result }, 'Memory assemble');
      return result;
    },
    async compact(gf: string) {
      flushMemoryBeforeCompact(gf);
    },
  };
}
