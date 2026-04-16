import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  MONITORING_CHANNEL_JID,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
  getTriggerPattern,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  AgentOutput,
  runHostAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './host-runner.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getMessageFromMe,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getMessagesSincePaired,
  getNewMessages,
  getRegisteredAgentTypesForJid,
  getRouterState,
  initDatabase,
  isPairedRoomJid,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { filterProcessableMessages } from './bot-message-filter.js';
import { shouldSkipBotOnlyCollaboration } from './collaboration-timeout.js';
import { readPairedRoomPrompt } from './platform-prompts.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { formatDashboard } from './task-status-tracker.js';
import { startHeartbeatLoop } from './heartbeat.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { compactSession } from './context-compaction.js';
import { parsePruneCommand, pruneSession } from './context-pruning.js';
import { logger } from './logger.js';
import {
  parseThinkingDirective,
  getThinkingLabel,
  buildThinkingEnv,
} from './thinking-levels.js';
import {
  getSessionThinkingLevel,
  setSessionThinkingLevel,
} from './session-manager.js';
import {
  recordAgentResult,
  shouldResetSession,
  resetErrorCount,
} from './session-recovery.js';
import {
  loadRestartState,
  clearRestartState,
  formatRestartAnnouncement,
  captureRestartState,
  saveRestartState,
} from './restart-context.js';
import { buildDashboardState, formatDashboardMessage } from './dashboard.js';
import { initTokenRotation } from './token-rotation.js';
import {
  registerPlugin,
  runAssemble,
  runIngest,
  runAfterTurn,
} from './context-engine.js';
import { createMemoryPlugin } from './memory-system.js';
import {
  createStreamedOutputState,
  evaluateStreamedOutput,
} from './streamed-output-evaluator.js';
import { classifyAgentError } from './agent-error-detection.js';
import { evaluateTaskSuspension } from './task-suspension.js';
import { getFormattedUsage } from './usage-dashboard.js';
import { filterLoopingPairedBotMessages } from './collaboration-timeout.js';
import { startDashboard, type RoomStatus } from './unified-dashboard.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
// Tracks cursor value before messages were piped to an active container.
// Used to roll back if the container dies after piping.
let cursorBeforePipe: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  const pipeCursor = getRouterState('cursor_before_pipe');
  try {
    cursorBeforePipe = pipeCursor ? JSON.parse(pipeCursor) : {};
  } catch {
    logger.warn('Corrupted cursor_before_pipe in DB, resetting');
    cursorBeforePipe = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
  setRouterState('cursor_before_pipe', JSON.stringify(cursorBeforePipe));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./host-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = getOrRecoverCursor(chatJid);
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  logger.info(
    {
      chatJid,
      group: group.name,
      sinceTimestamp,
      messageCount: missedMessages.length,
      messageIds: missedMessages.map((m) => m.id),
      firstContent: missedMessages[0]?.content?.slice(0, 50),
    },
    '>>> TRACE: processGroupMessages called',
  );

  // --- Session command interception (before trigger check) ---
  const cmdResult = await handleSessionCommand({
    missedMessages,
    isMainGroup,
    groupName: group.name,
    triggerPattern: TRIGGER_PATTERN,
    timezone: TIMEZONE,
    deps: {
      sendMessage: (text) => channel.sendMessage(chatJid, text),
      setTyping: (typing) =>
        channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
      runAgent: (prompt, onOutput) =>
        runAgent(group, prompt, chatJid, onOutput),
      closeStdin: () => queue.closeStdin(chatJid),
      advanceCursor: (ts) => {
        lastAgentTimestamp[chatJid] = ts;
        saveState();
      },
      formatMessages,
      canSenderInteract: (msg) => {
        const hasTrigger = TRIGGER_PATTERN.test(msg.content.trim());
        const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
        return (
          isMainGroup ||
          !reqTrigger ||
          (hasTrigger &&
            (msg.is_from_me ||
              isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist())))
        );
      },
    },
  });
  if (cmdResult.handled) return cmdResult.success;
  // --- End session command interception ---

  // Check if this is a paired room (dual-agent collaboration)
  // Paired rooms skip trigger check — both agents always respond
  const isPaired = isPairedRoomJid(chatJid);

  // For non-main, non-paired groups, check if trigger is required and present
  if (!isPaired && !isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const triggerPattern = getTriggerPattern(group.trigger);
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) {
      return true;
    }
  }

  if (isPaired) {
    logger.info(
      { group: group.name, chatJid },
      'Entering paired room dispatch',
    );
    // Paired room: fetch messages INCLUDING bot messages
    const allMessages = getMessagesSincePaired(
      chatJid,
      lastAgentTimestamp[chatJid] || '',
    );

    if (allMessages.length === 0) return true;

    // Check bot-only collaboration timeout
    if (shouldSkipBotOnlyCollaboration(chatJid, allMessages)) {
      logger.info(
        { group: group.name },
        'Skipping bot-only collaboration (timeout)',
      );
      // Still advance cursor
      lastAgentTimestamp[chatJid] =
        allMessages[allMessages.length - 1].timestamp;
      saveState();
      return true;
    }

    // Advance cursor
    const previousCursor = lastAgentTimestamp[chatJid] || '';
    lastAgentTimestamp[chatJid] = allMessages[allMessages.length - 1].timestamp;
    saveState();

    // Get registered agent types for this room
    const allAgentTypes = getRegisteredAgentTypesForJid(chatJid);

    // In dedicated processes (NANOCLAW_AGENT_TYPE set), only run OUR agent type.
    // This prevents double execution when Claude and Codex run as separate processes.
    const processAgentType = process.env.NANOCLAW_AGENT_TYPE as
      | string
      | undefined;
    const agentTypes = processAgentType
      ? allAgentTypes.filter((t) => t === processAgentType)
      : allAgentTypes;

    if (agentTypes.length === 0) {
      logger.debug(
        { group: group.name, processAgentType },
        'No matching agent type for this process in paired room',
      );
      return true;
    }

    logger.info(
      {
        group: group.name,
        agentTypes,
        processAgentType,
        messageCount: allMessages.length,
      },
      'Paired room dispatch',
    );

    for (const currentAgentType of agentTypes) {
      // Filter: keep other bot's messages, remove own
      const filtered = filterProcessableMessages(
        allMessages,
        true, // allowBotMessages
        (msg) => msg.sender === `nanoclaw-${currentAgentType}`,
      );

      if (filtered.length === 0) continue;

      // Build prompt with paired-room system prompt
      const pairedPrompt = readPairedRoomPrompt(currentAgentType, group.folder);

      // Memory assembly
      await runIngest(
        filtered
          .filter((m) => !m.is_bot_message)
          .map((m) => ({
            content: m.content,
            sender_name: m.sender_name || m.sender || 'unknown',
            timestamp: m.timestamp,
          })),
        group.folder,
      );
      const memoryParts = await runAssemble(group.folder);
      const memoryContext =
        memoryParts.length > 0
          ? `<memory>\n${memoryParts.join('\n\n---\n\n')}\n</memory>\n\n`
          : '';

      const pairedContext = pairedPrompt
        ? `<paired-room-rules>\n${pairedPrompt}\n</paired-room-rules>\n\n`
        : '';

      const prompt =
        pairedContext + memoryContext + formatMessages(filtered, TIMEZONE);

      logger.info(
        {
          group: group.name,
          agentType: currentAgentType,
          promptLength: prompt.length,
        },
        'Running paired agent',
      );

      await channel.setTyping?.(chatJid, true);

      // Use agent-type-specific session key
      const sessionKey = `${group.folder}:${currentAgentType}`;

      let lastResultText: string | null = null;
      const output = await runAgent(
        group,
        prompt,
        chatJid,
        async (result) => {
          if (result.result) {
            const raw =
              typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result);
            const text = raw
              .replace(/<internal>[\s\S]*?<\/internal>/g, '')
              .trim();
            if (text) lastResultText = text;
          }
          if (result.status === 'success') queue.notifyIdle(chatJid);
        },
        currentAgentType as 'claude-code' | 'codex',
        sessionKey,
      );

      await channel.setTyping?.(chatJid, false);

      // Codex doesn't use IPC send_message — send result directly
      if (currentAgentType === 'codex' && lastResultText) {
        await channel.sendMessage(chatJid, lastResultText);
      }

      if (lastResultText) {
        await runAfterTurn(group.folder, lastResultText);
      }
    }

    // All agents done — turn off typing
    await channel.setTyping?.(chatJid, false);
    return true;
  }

  // --- Single-agent path (non-paired rooms) ---

  // Ingest messages into context plugins (memory daily log)
  await runIngest(
    missedMessages.map((m) => ({
      content: m.content,
      sender_name: m.sender_name || m.sender || 'unknown',
      timestamp: m.timestamp,
    })),
    group.folder,
  );

  // Assemble memory context and prepend to prompt
  const memoryParts = await runAssemble(group.folder);
  logger.info(
    {
      group: group.name,
      folder: group.folder,
      memoryPartCount: memoryParts.length,
      memoryLength: memoryParts.join('').length,
    },
    'Memory assembly result',
  );
  const memoryContext =
    memoryParts.length > 0
      ? `<memory>\n${memoryParts.join('\n\n---\n\n')}\n</memory>\n\n`
      : '';
  const prompt = memoryContext + formatMessages(missedMessages, TIMEZONE);
  logger.info(
    {
      group: group.name,
      promptLength: prompt.length,
      hasMemory: memoryParts.length > 0,
    },
    'Prompt built with memory context',
  );

  // Determine agent type:
  // 1. NANOCLAW_AGENT_TYPE env var (dedicated process, e.g., Discord Codex)
  // 2. /plan prefix in message → codex
  // 3. Default: claude-code
  const envAgentType = process.env.NANOCLAW_AGENT_TYPE as
    | 'claude-code'
    | 'codex'
    | undefined;
  let agentType: 'claude-code' | 'codex' | undefined = envAgentType;
  const lastMsg = missedMessages[missedMessages.length - 1];
  if (!agentType && lastMsg && /^\/plan\b/i.test(lastMsg.content.trim())) {
    agentType = 'codex';
  }

  // Handle /status command
  if (lastMsg && /^\/status$/i.test(lastMsg.content.trim())) {
    const dashboard = formatDashboard();
    const dashState = buildDashboardState({
      getActiveGroups: () => {
        const active: string[] = [];
        for (const [jid, g] of Object.entries(registeredGroups)) {
          if (queue.isActive(jid)) active.push(g.name);
        }
        return active;
      },
    });
    const fullDashboard =
      dashboard + '\n\n' + formatDashboardMessage(dashState);
    await channel.sendMessage(chatJid, fullDashboard);
    return true;
  }

  // Handle /usage command
  if (lastMsg && /^\/usage$/i.test(lastMsg.content.trim())) {
    try {
      const usage = await getFormattedUsage();
      await channel.sendMessage(chatJid, usage || '사용량 데이터 없음');
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        '사용량 조회 실패. 다시 시도해주세요.',
      );
      logger.error({ err }, 'Usage dashboard error');
    }
    return true;
  }

  // Handle /compact command
  if (lastMsg && /^\/compact/i.test(lastMsg.content.trim())) {
    const match = lastMsg.content.trim().match(/^\/compact(?:\s+(.*))?$/i);
    const instructions = match?.[1]?.trim();

    await compactSession({
      groupFolder: group.folder,
      sessionId: sessions[group.folder] || '',
      instructions,
      sendMessage: (text) => channel.sendMessage(chatJid, text),
      runAgent: (prompt, onOutput) =>
        runAgent(group, prompt, chatJid, onOutput),
    });
    return true;
  }

  // Handle /prune command
  if (lastMsg && /^\/prune/i.test(lastMsg.content.trim())) {
    const parsed = parsePruneCommand(lastMsg.content.trim());
    if (parsed) {
      await pruneSession({
        groupFolder: group.folder,
        sessionId: sessions[group.folder] || '',
        mode: parsed.mode,
        sendMessage: (text) => channel.sendMessage(chatJid, text),
        runAgent: (prompt, onOutput) =>
          runAgent(group, prompt, chatJid, onOutput),
      });
    }
    return true;
  }

  // Handle /think directive
  if (lastMsg) {
    const directive = parseThinkingDirective(lastMsg.content.trim());
    if (directive) {
      setSessionThinkingLevel(group.folder, directive.level);
      if (directive.isDirectiveOnly) {
        const label = getThinkingLabel(directive.level);
        await channel.sendMessage(chatJid, `Thinking: ${label}`);
        return true;
      }
    }
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.info({ group: group.name }, 'Idle timeout, killing agent process');
      queue.closeStdin(chatJid);
      // Also kill the process directly — closeStdin writes _close sentinel
      // but agent may not check it promptly
      queue.killProcess(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  // Collect the last result text — only send ONCE after agent completes
  let lastResultText: string | null = null;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      // Streaming callback: DON'T send results directly.
      // The agent uses send_message MCP tool for immediate delivery.
      // This callback only tracks session IDs (handled by wrappedOnOutput in runAgent)
      // and collects the final result text.
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        if (text) {
          lastResultText = text;
          outputSentToUser = true;
        }
        resetIdleTimer();
      }

      if (result.status === 'success') {
        // EJClaw pattern: typing off immediately, then close agent gracefully
        channel.setTyping?.(chatJid, false).catch(() => {});
        queue.notifyIdle(chatJid);
        queue.closeStdin(chatJid);
        // Grace period: SIGTERM after 10s, SIGKILL after 15s
        setTimeout(() => {
          queue.killProcess(chatJid);
          setTimeout(() => {
            try {
              const s = (queue as any).getGroup(chatJid);
              if (s?.process && !s.process.killed) s.process.kill('SIGKILL');
            } catch {}
          }, 5000);
        }, 10000);
      }

      if (result.status === 'error') {
        hadError = true;
        // Classify the error for better handling
        if (result.error) {
          const classification = classifyAgentError(result.error);
          if (classification) {
            logger.warn(
              { group: group.name, classification: classification.reason },
              'Agent error classified',
            );
          }
        }
        // Check if session should be reset
        recordAgentResult(group.folder, false);
      }
    },
    agentType,
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  // Track success for session recovery
  if (!hadError) {
    recordAgentResult(group.folder, true);
  }

  // Run afterTurn for context plugins (memory updates)
  if (lastResultText) {
    await runAfterTurn(group.folder, lastResultText);
  }

  // Claude Code agents send responses via send_message MCP tool (IPC path).
  // Codex agents do NOT have IPC MCP — they return results via stdout only.
  // For Codex: send the final result text directly to the user.
  if (agentType === 'codex' && lastResultText && !hadError) {
    await channel.sendMessage(chatJid, lastResultText);
    // Re-enable typing if still processing (paired room sequential dispatch)
    if (queue.isActive(chatJid) && channel.setTyping) {
      channel.setTyping(chatJid, true).catch(() => {});
    }
  }

  if (output === 'error' || hadError) {
    // Do NOT retry on error — the agent may have already sent a response via IPC.
    // Retrying would spawn a new agent that responds again = duplicate messages.
    logger.warn(
      { group: group.name },
      'Agent error, NOT retrying to prevent duplicate messages',
    );
    delete cursorBeforePipe[chatJid];
    saveState();
    return true; // true = don't retry
  }

  // Success — clear pipe tracking (markAllDone already fired in streaming callback)
  delete cursorBeforePipe[chatJid];
  saveState();
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: AgentOutput) => Promise<void>,
  agentType?: 'claude-code' | 'codex',
  sessionKeyOverride?: string,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionKey = sessionKeyOverride || group.folder;
  const sessionId = sessions[sessionKey];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: AgentOutput) => {
        if (output.newSessionId) {
          sessions[sessionKey] = output.newSessionId;
          setSession(sessionKey, output.newSessionId, agentType);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runHostAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        agentType,
        thinkingEnv: buildThinkingEnv(getSessionThinkingLevel(group.folder)),
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[sessionKey] = output.newSessionId;
      setSession(sessionKey, output.newSessionId, agentType);
    }

    recordAgentResult(group.folder, output.status === 'success');

    // Check if session needs reset
    if (
      output.status === 'error' &&
      shouldResetSession(group.folder, output.error)
    ) {
      sessions[sessionKey] = '';
      setSession(sessionKey, '', agentType);
      resetErrorCount(group.folder);
      logger.warn(
        { group: group.name },
        'Session auto-reset due to repeated errors',
      );
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      // Only poll JIDs owned by connected channels (prevents telegram process from querying discord JIDs)
      const jids = Object.keys(registeredGroups).filter((jid) =>
        findChannel(channels, jid),
      );
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;

          // --- Session command interception (message loop) ---
          // Scan ALL messages in the batch for a session command.
          const loopCmdMsg = groupMessages.find(
            (m) => extractSessionCommand(m.content, TRIGGER_PATTERN) !== null,
          );

          if (loopCmdMsg) {
            // Only close active container if the sender is authorized — otherwise an
            // untrusted user could kill in-flight work by sending /compact (DoS).
            // closeStdin no-ops internally when no container is active.
            if (
              isSessionCommandAllowed(
                isMainGroup,
                loopCmdMsg.is_from_me === true,
              )
            ) {
              queue.closeStdin(chatJid);
            }
            // Enqueue so processGroupMessages handles auth + cursor advancement.
            // Don't pipe via IPC — slash commands need a fresh container with
            // string prompt (not MessageStream) for SDK recognition.
            queue.enqueueMessageCheck(chatJid);
            continue;
          }
          // --- End session command interception ---

          const isPairedLoop = isPairedRoomJid(chatJid);
          const needsTrigger =
            !isPairedLoop && !isMainGroup && group.requiresTrigger !== false;

          // For non-main, non-paired groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Mark each user message as received (status emoji)
          for (const msg of groupMessages) {
            if (!msg.is_from_me && !msg.is_bot_message) {
            }
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            // Mark new user messages as thinking (only groupMessages were markReceived'd;
            // accumulated allPending context messages are untracked and would no-op)
            for (const msg of groupMessages) {
              if (!msg.is_from_me && !msg.is_bot_message) {
              }
            }
            // Save cursor before first pipe so we can roll back if container dies
            if (!cursorBeforePipe[chatJid]) {
              cursorBeforePipe[chatJid] = lastAgentTimestamp[chatJid] || '';
            }
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  // Roll back any piped-message cursors that were persisted before a crash.
  // This ensures messages piped to a now-dead container are re-fetched.
  // IMPORTANT: Only roll back if the container is no longer running — rolling
  // back while the container is alive causes duplicate processing.
  let rolledBack = false;
  for (const [chatJid, savedCursor] of Object.entries(cursorBeforePipe)) {
    if (queue.isActive(chatJid)) {
      logger.debug(
        { chatJid },
        'Recovery: skipping piped-cursor rollback, container still active',
      );
      continue;
    }
    logger.info(
      { chatJid, rolledBackTo: savedCursor },
      'Recovery: rolling back piped-message cursor',
    );
    lastAgentTimestamp[chatJid] = savedCursor;
    delete cursorBeforePipe[chatJid];
    rolledBack = true;
  }
  if (rolledBack) {
    saveState();
  }

  const myAgentType = process.env.NANOCLAW_AGENT_TYPE || 'claude-code';
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    // Only recover messages for JIDs owned by a connected channel
    const channel = findChannel(channels, chatJid);
    if (!channel) continue;

    // Only recover for channels registered for THIS agent type
    const registeredTypes = getRegisteredAgentTypesForJid(chatJid);
    if (registeredTypes.length > 0 && !registeredTypes.includes(myAgentType as any)) {
      continue;
    }

    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

async function main(): Promise<void> {
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Initialize token rotation
  initTokenRotation();

  // Register context engine plugins
  registerPlugin(createMemoryPlugin());

  // Check for restart state and announce
  const restartState = loadRestartState();
  if (restartState) {
    clearRestartState();
    // Will announce after channels connect
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');

    // Capture restart state
    const state = captureRestartState({
      getActiveGroups: () => {
        const active: string[] = [];
        for (const [jid, g] of Object.entries(registeredGroups)) {
          if (queue.isActive(jid)) active.push(g.name);
        }
        return active;
      },
      getPendingCount: () => 0,
      reason: signal,
    });
    saveRestartState(state);

    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Initialize status tracker (uses channels via callbacks, channels don't need to be connected yet)

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Send restart announcement if we have restart state
  if (restartState) {
    const announcement = formatRestartAnnouncement(restartState);
    for (const [jid, group] of Object.entries(registeredGroups)) {
      if (group.isMain) {
        const ch = findChannel(channels, jid);
        if (ch) {
          ch.sendMessage(jid, announcement).catch(() => {});
        }
        break;
      }
    }
  }

  // Start subsystems (independently of connection handler)
  // Scheduler only runs on claude-code process to avoid duplicate task execution
  if (process.env.NANOCLAW_AGENT_TYPE === 'codex') {
    logger.info('Scheduler skipped (codex process)');
  } else
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.debug({ jid }, 'IPC sendMessage: no channel owns JID, skipping');
        return;
      }
      await channel.sendMessage(jid, text);
      // Re-enable typing indicator after sending — Telegram auto-clears it on message send.
      // Only re-enable if the agent is still running (more responses coming).
      // Skip typing for scheduled tasks — cron jobs don't need typing indicators.
      if (queue.isActive(jid) && !queue.isTask(jid) && channel.setTyping) {
        channel.setTyping(jid, true).catch(() => {});
      }
    },
    sendReaction: async (jid, emoji, messageId) => {
      const channel = findChannel(channels, jid);
      if (!channel) return;
      if (messageId) {
        if (!channel.sendReaction)
          throw new Error('Channel does not support sendReaction');
        const messageKey = {
          id: messageId,
          remoteJid: jid,
          fromMe: getMessageFromMe(messageId, jid),
        };
        await channel.sendReaction(jid, messageKey, emoji);
      } else {
        if (!channel.reactToLatestMessage)
          throw new Error('Channel does not support reactions');
        await channel.reactToLatestMessage(jid, emoji);
      }
    },
    telegramActions: {
      deleteMessage: async (chatId, messageId) => {
        const channel = findChannel(channels, chatId);
        if (!channel) return;
        if (!channel.deleteMessage) return;
        await channel.deleteMessage(chatId, messageId);
      },
      editMessage: async (chatId, messageId, newText) => {
        const channel = findChannel(channels, chatId);
        if (!channel) return;
        if (!channel.editMessage)
          throw new Error('Channel does not support editMessage');
        await channel.editMessage(chatId, messageId, newText);
      },
      createForumTopic: async (chatId, name, iconColor, iconEmoji) => {
        const channel = findChannel(channels, chatId);
        if (!channel) throw new Error(`No channel for JID: ${chatId}`);
        if (!channel.createForumTopic)
          throw new Error('Channel does not support createForumTopic');
        await channel.createForumTopic(chatId, name, iconColor, iconEmoji);
      },
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  // Recover status tracker AFTER channels connect, so recovery reactions
  // can actually be sent via the WhatsApp channel.
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();

  // Start heartbeat loop for the main group (batched checks, token-efficient)
  startHeartbeatLoop({
    getMainGroup: () => {
      for (const [jid, group] of Object.entries(registeredGroups)) {
        if (group.isMain) return { jid, group };
      }
      return null;
    },
    runAgent,
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (channel) await channel.sendMessage(jid, text);
    },
  });

  // Start monitoring dashboard (claude-code process only, avoid codex duplicate)
  if (
    MONITORING_CHANNEL_JID &&
    (process.env.NANOCLAW_AGENT_TYPE === 'claude-code' ||
      !process.env.NANOCLAW_AGENT_TYPE)
  ) {
    const monChannel = findChannel(channels, MONITORING_CHANNEL_JID);
    if (monChannel?.sendAndTrack && monChannel?.editMessageById) {
      let dashMsgId: string | null = null;

      const getRoomStatuses = (): RoomStatus[] =>
        Object.entries(registeredGroups).map(([jid, group]) => ({
          jid,
          name: group.name,
          status: queue.isActive(jid)
            ? ('처리 중' as const)
            : ('비활성' as const),
          elapsedMs: null,
          pendingTasks: 0,
        }));

      startDashboard({
        getRoomStatuses,
        sendOrEdit: async (content) => {
          if (dashMsgId) {
            try {
              await monChannel.editMessageById!(
                MONITORING_CHANNEL_JID,
                dashMsgId,
                content,
              );
              return;
            } catch {
              dashMsgId = null;
            }
          }
          dashMsgId = await monChannel.sendAndTrack!(
            MONITORING_CHANNEL_JID,
            content,
          );
        },
      }).catch((err) =>
        logger.warn({ err }, 'Monitoring dashboard start failed'),
      );
    } else {
      logger.warn('Monitoring channel not found, dashboard disabled');
    }
  }

  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
