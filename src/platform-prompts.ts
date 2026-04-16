/**
 * Platform Prompts for paired-room and collab dual-agent dispatch.
 * Reads agent-type-specific system prompts based on channel type.
 */
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const PROMPTS_DIR = path.resolve(process.cwd(), 'prompts');

/**
 * Read the appropriate system prompt for a paired room agent.
 * - Tribunal channels (folder contains "collab") → collab-owner/reviewer prompts
 * - Other paired channels → paired-room prompts
 */
export function readPairedRoomPrompt(
  agentType: string,
  groupFolder?: string,
): string | undefined {
  // Determine prompt type based on channel
  const isTribunal = groupFolder?.includes('collab');
  const isDesign =
    groupFolder?.includes('design') && !groupFolder?.includes('design-qa');
  const isDesignQa = groupFolder?.includes('design-qa');

  if (isTribunal) {
    const filename =
      agentType === 'codex' ? 'collab-reviewer.md' : 'collab-owner.md';
    const content = readPromptFile(filename);
    if (content) return content;
  }

  if (isDesign) {
    return readPromptFile('design-implementer.md');
  }

  if (isDesignQa) {
    const filename =
      agentType === 'codex' ? 'design-qa.md' : 'design-implementer.md';
    return readPromptFile(filename);
  }

  // All other paired channels: full harness (collab-owner/reviewer)
  // This applies Eval Rubric, Stagnation Detection, Security Baseline,
  // Mention Protocol to ALL paired rooms (tasks, review, collab, etc.)
  const filename =
    agentType === 'codex' ? 'collab-reviewer.md' : 'collab-owner.md';
  return readPromptFile(filename);
}

function readPromptFile(filename: string): string | undefined {
  const filePath = path.join(PROMPTS_DIR, filename);
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      if (content) {
        logger.debug({ filename }, 'Loaded prompt');
        return content;
      }
    }
  } catch (err) {
    logger.error({ filename, err }, 'Failed to read prompt');
  }
  return undefined;
}
