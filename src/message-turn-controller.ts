/**
 * Message Turn Controller for NanoClaw
 *
 * Sophisticated state machine ported from EJClaw that:
 * - Tracks progress message state with idle timeouts
 * - Maintains a 5-second ticker for periodic progress message edits
 * - Handles subagent tracking with separate activity lists
 * - Renders progress with tree-like connectors for tool activities
 * - Detects poisoned sessions and forces session reset
 * - Manages typing indicator state
 * - Implements sendAndTrack() for message ID tracking
 * - Buffers intermediate messages to avoid duplicates
 */

import { logger } from './logger.js';
import { formatOutbound } from './router.js';
import { shouldResetSessionOnAgentFailure } from './session-recovery.js';
import type { AgentOutput } from './host-runner.js';
import type { RegisteredGroup } from './types.js';

// ── Phase types ─────────────────────────────────────────────────

/**
 * Raw phase values that an agent output may carry.
 * NanoClaw's base AgentOutput doesn't include phase/agentId,
 * so callers map their own streaming events to these phases.
 */
export type AgentOutputPhase =
  | 'intermediate'
  | 'tool-activity'
  | 'progress'
  | 'final';

/**
 * Visible phase tracks what the user has seen so far.
 */
export type VisiblePhase = 'silent' | 'progress' | 'final';

export function toVisiblePhase(
  phase: AgentOutputPhase,
): VisiblePhase {
  switch (phase) {
    case 'intermediate':
    case 'tool-activity':
    case 'progress':
      return 'progress';
    case 'final':
      return 'final';
  }
}

export function normalizeAgentOutputPhase(
  raw: string | undefined,
): AgentOutputPhase {
  switch (raw) {
    case 'intermediate':
    case 'tool-activity':
    case 'progress':
    case 'final':
      return raw;
    default:
      return 'final';
  }
}

// ── Extended output with phase/agent info ────────────────────────

/**
 * Extended AgentOutput that carries streaming phase and optional
 * subagent identification. Callers construct this from raw events.
 */
export interface StreamingAgentOutput extends AgentOutput {
  phase?: string;
  agentId?: string;
  agentLabel?: string;
  agentDone?: boolean;
}

// ── Progress prefix and elapsed formatting ──────────────────────

const PROGRESS_MESSAGE_PREFIX = '⏳ ';

function formatElapsedKorean(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 5) return '방금 시작';
  if (seconds < 60) return `${seconds}초 경과`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 경과`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return `${hours}시간 ${remainMinutes}분 경과`;
}

// ── Subagent tracking ───────────────────────────────────────────

interface SubagentTrack {
  label: string;
  activities: string[];
}

// ── Controller options ──────────────────────────────────────────

export interface MessageTurnControllerOptions {
  chatJid: string;
  group: RegisteredGroup;
  runId: string;
  idleTimeout: number;
  failureFinalText: string;
  isClaudeCodeAgent: boolean;

  /** Clear the agent's persisted session (for poisoned session recovery). */
  clearSession: () => void;

  /** Request the agent process to close (idle timeout, delivered, etc.). */
  requestClose: (reason: string) => void;

  /** Deliver the final text to the user. Returns true if delivery succeeded. */
  deliverFinalText: (text: string) => Promise<boolean>;

  /** Send a message and return immediately (fire-and-forget). */
  sendMessage: (text: string) => Promise<void>;

  /**
   * Send a message and return its ID for later editing.
   * If not provided, progress messages cannot be edited in-place.
   */
  sendAndTrack?: (text: string) => Promise<string | null>;

  /**
   * Edit an existing message by ID.
   * Required for in-place progress updates.
   */
  editMessage?: (messageId: string, text: string) => Promise<void>;

  /** Set typing indicator on/off. */
  setTyping?: (isTyping: boolean) => Promise<void>;
}

// ── Controller ──────────────────────────────────────────────────

export class MessageTurnController {
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private visiblePhase: VisiblePhase = 'silent';
  private hadError = false;
  private producedDeliverySucceeded = true;
  private latestProgressText: string | null = null;
  private previousProgressText: string | null = null;
  private pendingProgressText: string | null = null;
  private toolActivities: string[] = [];
  private progressCreating = false;
  private latestProgressRendered: string | null = null;
  private progressMessageId: string | null = null;
  private progressStartedAt: number | null = null;
  private progressTicker: ReturnType<typeof setInterval> | null = null;
  private progressEditFailCount = 0;
  private latestProgressTextForFinal: string | null = null;
  private subagents = new Map<string, SubagentTrack>();
  private lastIntermediateText: string | null = null;
  private poisonedSessionDetected = false;
  private closeRequested = false;

  constructor(private readonly options: MessageTurnControllerOptions) {}

  // ── Typing helpers ──────────────────────────────────────────

  private async setTyping(
    isTyping: boolean,
    source: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    logger.debug(
      {
        transition: isTyping ? 'typing:on' : 'typing:off',
        source,
        chatJid: this.options.chatJid,
        group: this.options.group.name,
        groupFolder: this.options.group.folder,
        runId: this.options.runId,
        ...extra,
      },
      'Typing indicator transition',
    );
    await this.options.setTyping?.(isTyping);
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async start(): Promise<void> {
    this.resetIdleTimer();
    await this.setTyping(true, 'turn:start');
  }

  async handleOutput(result: StreamingAgentOutput): Promise<void> {
    if (this.terminalObserved()) {
      logger.info(
        {
          chatJid: this.options.chatJid,
          group: this.options.group.name,
          groupFolder: this.options.group.folder,
          runId: this.options.runId,
          resultStatus: result.status,
          resultPhase: result.phase,
        },
        'Discarding late agent output after terminal final',
      );
      return;
    }

    // Poisoned session detection
    if (
      this.options.isClaudeCodeAgent &&
      shouldResetSessionOnAgentFailure(result) &&
      !this.poisonedSessionDetected
    ) {
      this.poisonedSessionDetected = true;
      this.hadError = true;
      this.options.clearSession();
      this.requestAgentClose('poisoned-session-detected');
      logger.warn(
        {
          chatJid: this.options.chatJid,
          group: this.options.group.name,
          groupFolder: this.options.group.folder,
          runId: this.options.runId,
        },
        'Detected poisoned Claude session from streamed output, forcing close',
      );
    }

    // Extract text from result
    const raw =
      result.result === null || result.result === undefined
        ? null
        : typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
    const text = raw ? formatOutbound(raw) : null;

    if (raw) {
      logger.info(
        {
          chatJid: this.options.chatJid,
          group: this.options.group.name,
          groupFolder: this.options.group.folder,
          runId: this.options.runId,
          resultStatus: result.status,
          resultPhase: result.phase,
          progressMessageId: this.progressMessageId,
        },
        `Agent output: ${raw.slice(0, 200)}`,
      );
    }

    const phase: AgentOutputPhase = normalizeAgentOutputPhase(result.phase);

    switch (phase) {
      case 'intermediate':
        if (text) {
          if (this.progressMessageId) {
            this.previousProgressText = this.latestProgressText;
            this.latestProgressText = text;
            this.latestProgressTextForFinal = text;
            this.toolActivities = [];
            void this.syncTrackedProgressMessage();
          } else {
            this.bufferProgress(text);
          }
        }
        if (!this.poisonedSessionDetected) {
          this.resetIdleTimer();
        }
        return;

      case 'tool-activity':
        if (result.agentId) {
          let track = this.subagents.get(result.agentId);
          if (!track) {
            track = { label: '작업 중...', activities: [] };
            this.subagents.set(result.agentId, track);
          }
          if (text) {
            const MAX = 2;
            track.activities.push(text);
            if (track.activities.length > MAX) {
              track.activities = track.activities.slice(-MAX);
            }
          }
          this.ensureProgressMessageExists();
          this.ensureProgressTicker();
          if (!this.poisonedSessionDetected) {
            this.resetIdleTimer();
          }
          return;
        }
        this.ensureProgressMessageExists();
        if (text) {
          this.addToolActivity(text);
        }
        if (!this.poisonedSessionDetected) {
          this.resetIdleTimer();
        }
        return;

      case 'progress':
        if (result.agentId) {
          if (result.agentDone) {
            const done = this.subagents.get(result.agentId);
            if (done) {
              done.label = done.label.replace('\u{1F504}', '\u{2705}');
              done.activities = [];
            }
          } else {
            const label =
              text ||
              (result.agentLabel
                ? `\u{1F504} ${result.agentLabel}`
                : '작업 중...');
            const existing = this.subagents.get(result.agentId);
            if (existing) {
              existing.label = label;
              existing.activities = [];
            } else {
              this.subagents.set(result.agentId, { label, activities: [] });
            }
          }
          if (!this.latestProgressText) {
            this.latestProgressText = '작업 중...';
            this.latestProgressTextForFinal = '작업 중...';
          }
          this.ensureProgressMessageExists();
          this.ensureProgressTicker();
          if (this.progressMessageId) {
            void this.syncTrackedProgressMessage();
          }
          if (!this.poisonedSessionDetected) {
            this.resetIdleTimer();
          }
          if (result.status === 'error') {
            this.hadError = true;
          }
          return;
        }
        // Main agent progress
        if (text) {
          if (this.progressMessageId) {
            this.previousProgressText = this.latestProgressText;
            this.latestProgressText = text;
            this.toolActivities = [];
            void this.syncTrackedProgressMessage();
          } else {
            this.bufferProgress(text);
          }
        }
        if (!this.poisonedSessionDetected) {
          this.resetIdleTimer();
        }
        if (result.status === 'error') {
          this.hadError = true;
        }
        return;

      case 'final':
        break;

      default: {
        const exhaustive: never = phase;
        throw new Error(`Unhandled message turn phase: ${exhaustive}`);
      }
    }

    // Final arrived
    if (text) {
      if (this.lastIntermediateText && text === this.lastIntermediateText) {
        this.lastIntermediateText = null;
        await this.finalizeProgressMessage();
        this.visiblePhase = toVisiblePhase(phase);
        this.latestProgressTextForFinal = null;
      } else {
        this.lastIntermediateText = null;
        await this.flushPendingProgress(text);
        await this.finalizeProgressMessage();
        await this.deliverFinalText(text);
      }
    } else if (raw) {
      logger.info(
        {
          chatJid: this.options.chatJid,
          group: this.options.group.name,
          groupFolder: this.options.group.folder,
          runId: this.options.runId,
          resultStatus: result.status,
          resultPhase: result.phase,
          progressMessageId: this.progressMessageId,
        },
        'Agent output became empty after formatting; resetting tracked progress state',
      );
      await this.finalizeProgressMessage();
      this.latestProgressTextForFinal = null;
    } else {
      await this.finalizeProgressMessage();
    }

    await this.setTyping(false, 'turn:handle-output', {
      outputStatus: result.status,
      phase,
    });
    if (result.status === 'success' && !this.poisonedSessionDetected) {
      this.requestAgentClose('output-delivered-close');
    }

    if (result.status === 'error') {
      this.hadError = true;
    }
  }

  async finish(outputStatus: 'success' | 'error'): Promise<{
    deliverySucceeded: boolean;
    visiblePhase: VisiblePhase;
  }> {
    await this.setTyping(false, 'turn:finish', { outputStatus });

    if (outputStatus === 'error') {
      this.hadError = true;
    }

    if (
      outputStatus === 'success' &&
      this.visiblePhase === 'progress' &&
      !this.hadError &&
      this.latestProgressTextForFinal
    ) {
      logger.info(
        {
          chatJid: this.options.chatJid,
          group: this.options.group.name,
          groupFolder: this.options.group.folder,
          runId: this.options.runId,
        },
        'Sending a separate final message from the last progress output after agent completion',
      );
      await this.finalizeProgressMessage();
      await this.deliverFinalText(this.latestProgressTextForFinal);
    } else if (
      this.visiblePhase === 'progress' &&
      !this.terminalObserved() &&
      this.hadError
    ) {
      await this.publishFailureFinal();
    }

    this.clearProgressTicker();
    if (this.idleTimer) clearTimeout(this.idleTimer);

    return {
      deliverySucceeded: this.producedDeliverySucceeded,
      visiblePhase: this.visiblePhase,
    };
  }

  // ── State queries ─────────────────────────────────────────

  private hasVisibleOutput(): boolean {
    return this.visiblePhase !== 'silent';
  }

  private terminalObserved(): boolean {
    return this.visiblePhase === 'final';
  }

  // ── Progress rendering ────────────────────────────────────

  private renderProgressMessage(text: string): string {
    const elapsedMs =
      this.progressStartedAt === null
        ? 0
        : Math.floor((Date.now() - this.progressStartedAt) / 5_000) * 5000;

    const suffix = `\n\n${formatElapsedKorean(elapsedMs)}`;
    let body: string;

    if (this.subagents.size > 1) {
      // Compact: one line per subagent with latest activity
      const lines: string[] = [];
      for (const [, track] of this.subagents) {
        const latest = track.activities[track.activities.length - 1];
        lines.push(latest ? `${track.label} \u00B7 ${latest}` : track.label);
      }
      body = lines.join('\n');
    } else if (this.subagents.size === 1) {
      // Single subagent: detailed view with activity sub-lines
      const [, track] = this.subagents.entries().next().value!;
      const lines: string[] = [track.label];
      for (let i = 0; i < track.activities.length; i++) {
        const isLast = i === track.activities.length - 1;
        lines.push(`${isLast ? '\u2514' : '\u251C'}  ${track.activities[i]}`);
      }
      body = lines.join('\n');
    } else {
      // Single agent rendering
      const activityLines =
        this.toolActivities.length > 0
          ? '\n' +
            this.toolActivities
              .map((a, i) => {
                const isLast = i === this.toolActivities.length - 1;
                const connector = isLast ? '\u2514' : '\u251C';
                const isSummary = a.startsWith('\u{1F4CB}');
                return isSummary ? `${connector} ${a}` : `${connector}  ${a}`;
              })
              .join('\n')
          : '';
      body = text + activityLines;
    }

    const maxBody = 2000 - PROGRESS_MESSAGE_PREFIX.length - suffix.length;
    const truncated =
      body.length > maxBody ? body.slice(0, maxBody - 1) + '\u2026' : body;
    return `${PROGRESS_MESSAGE_PREFIX}${truncated}${suffix}`;
  }

  // ── Ticker management ─────────────────────────────────────

  private clearProgressTicker(): void {
    if (!this.progressTicker) return;
    clearInterval(this.progressTicker);
    this.progressTicker = null;
  }

  private resetProgressState(): void {
    this.clearProgressTicker();
    this.pendingProgressText = null;
    this.progressCreating = false;
    this.toolActivities = [];
    this.subagents.clear();
    this.latestProgressText = null;
    this.previousProgressText = null;
    this.latestProgressRendered = null;
    this.progressMessageId = null;
    this.progressStartedAt = null;
    this.progressEditFailCount = 0;
  }

  /**
   * Ensure a progress message exists.
   * Creates one if needed, using pending or default text.
   */
  private ensureProgressMessageExists(): void {
    if (this.progressMessageId || this.progressCreating) return;
    this.progressCreating = true;
    const heading =
      this.pendingProgressText || this.latestProgressText || '작업 중...';
    if (!this.latestProgressText) {
      this.latestProgressText = heading;
      this.latestProgressTextForFinal = heading;
    }
    void this.sendProgressMessage(heading).then(() => {
      this.progressCreating = false;
      this.ensureProgressTicker();
      if (
        (this.toolActivities.length > 0 || this.subagents.size > 0) &&
        this.progressMessageId
      ) {
        void this.syncTrackedProgressMessage();
      }
    });
    this.pendingProgressText = null;
  }

  /**
   * Buffer a progress update. The previous pending text gets flushed
   * immediately, and the new text waits until the next event arrives.
   */
  private bufferProgress(text: string): void {
    if (this.pendingProgressText) {
      void this.sendProgressMessage(this.pendingProgressText);
      this.toolActivities = [];
    }
    this.pendingProgressText = text;
  }

  /**
   * Append a tool activity line and update the progress message in-place.
   */
  private addToolActivity(description: string): void {
    const MAX_ACTIVITIES = 2;
    this.toolActivities.push(description);
    if (this.toolActivities.length > MAX_ACTIVITIES) {
      this.toolActivities = this.toolActivities.slice(-MAX_ACTIVITIES);
    }
    // Let the ticker handle periodic updates to avoid flooding edits
    this.ensureProgressTicker();
  }

  /**
   * Flush pending progress before a final result, but only if the
   * pending text differs from the final text.
   */
  private async flushPendingProgress(finalText: string): Promise<void> {
    if (this.pendingProgressText && this.pendingProgressText !== finalText) {
      await this.sendProgressMessage(this.pendingProgressText);
    }
    this.pendingProgressText = null;
  }

  private async syncTrackedProgressMessage(): Promise<void> {
    if (
      !this.progressMessageId ||
      !this.options.editMessage ||
      !this.latestProgressText
    ) {
      return;
    }

    const rendered = this.renderProgressMessage(this.latestProgressText);

    try {
      await this.options.editMessage(this.progressMessageId, rendered);
      this.latestProgressRendered = rendered;
      this.progressEditFailCount = 0;
    } catch (err) {
      this.progressEditFailCount++;
      logger.warn(
        {
          chatJid: this.options.chatJid,
          group: this.options.group.name,
          groupFolder: this.options.group.folder,
          runId: this.options.runId,
          progressMessageId: this.progressMessageId,
          progressEditFailCount: this.progressEditFailCount,
          err,
        },
        'Failed to edit tracked progress message; will retry before recreating',
      );
      this.latestProgressRendered = null;
      if (this.progressEditFailCount >= 3) {
        this.clearProgressTicker();
      }
    }
  }

  private ensureProgressTicker(): void {
    if (this.progressTicker || !this.options.editMessage) {
      return;
    }

    this.progressTicker = setInterval(() => {
      if (
        this.progressMessageId &&
        this.latestProgressText &&
        !this.progressCreating
      ) {
        void this.syncTrackedProgressMessage();
      }
    }, 5_000);
  }

  private async finalizeProgressMessage(): Promise<void> {
    logger.info(
      {
        chatJid: this.options.chatJid,
        group: this.options.group.name,
        groupFolder: this.options.group.folder,
        runId: this.options.runId,
        progressMessageId: this.progressMessageId,
        latestProgressText: this.latestProgressText,
      },
      'Finalizing tracked progress message',
    );
    await this.syncTrackedProgressMessage();
    this.resetProgressState();
  }

  private async deliverFinalText(text: string): Promise<void> {
    this.visiblePhase = toVisiblePhase('final');
    const delivered = await this.options.deliverFinalText(text);
    if (!delivered) {
      this.producedDeliverySucceeded = false;
    }
    this.latestProgressTextForFinal = null;
  }

  private async publishFailureFinal(): Promise<void> {
    if (this.terminalObserved()) {
      return;
    }
    await this.finalizeProgressMessage();
    await this.deliverFinalText(this.options.failureFinalText);
  }

  private requestAgentClose(reason: string): void {
    if (this.closeRequested) return;
    this.closeRequested = true;
    this.options.requestClose(reason);
  }

  private async sendProgressMessage(text: string): Promise<void> {
    if (!text || (text === this.latestProgressText && this.progressMessageId)) {
      return;
    }

    if (this.progressStartedAt === null) {
      this.progressStartedAt = Date.now();
    }
    this.latestProgressTextForFinal = text;
    this.previousProgressText = this.latestProgressText;
    this.latestProgressText = text;
    const rendered = this.renderProgressMessage(text);

    // If we already have a tracked progress message, edit it
    if (this.progressMessageId && this.options.editMessage) {
      logger.info(
        {
          chatJid: this.options.chatJid,
          group: this.options.group.name,
          groupFolder: this.options.group.folder,
          runId: this.options.runId,
          progressMessageId: this.progressMessageId,
          text,
        },
        'Updating tracked progress message',
      );
      await this.syncTrackedProgressMessage();
      this.visiblePhase = toVisiblePhase('progress');
      return;
    }

    // Try sendAndTrack to get a message ID for later editing
    if (!this.options.sendAndTrack) {
      this.latestProgressRendered = rendered;
      await this.options.sendMessage(rendered);
      this.visiblePhase = toVisiblePhase('progress');
      return;
    }

    try {
      this.progressMessageId = await this.options.sendAndTrack(rendered);
    } catch (err) {
      logger.warn(
        {
          chatJid: this.options.chatJid,
          group: this.options.group.name,
          groupFolder: this.options.group.folder,
          runId: this.options.runId,
          err,
        },
        'Failed to send tracked progress message',
      );
      this.latestProgressRendered = rendered;
      await this.options.sendMessage(rendered);
      this.visiblePhase = toVisiblePhase('progress');
      return;
    }

    if (this.progressMessageId) {
      logger.info(
        {
          chatJid: this.options.chatJid,
          group: this.options.group.name,
          groupFolder: this.options.group.folder,
          runId: this.options.runId,
          progressMessageId: this.progressMessageId,
          text,
        },
        'Created tracked progress message',
      );
      this.latestProgressRendered = rendered;
      this.ensureProgressTicker();
      this.visiblePhase = toVisiblePhase('progress');
      return;
    }

    // sendAndTrack returned null — fall back to plain send
    this.latestProgressRendered = rendered;
    await this.options.sendMessage(rendered);
    this.visiblePhase = toVisiblePhase('progress');
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.hasVisibleOutput()) {
      this.idleTimer = null;
      return;
    }

    this.idleTimer = setTimeout(() => {
      logger.debug(
        {
          group: this.options.group.name,
          chatJid: this.options.chatJid,
          runId: this.options.runId,
        },
        'Idle timeout, closing agent stdin',
      );
      this.requestAgentClose('idle-timeout');
    }, this.options.idleTimeout);
  }
}
