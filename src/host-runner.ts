/**
 * Host Runner for NanoClaw
 * Spawns agent execution directly on the host (no containers)
 * Replaces container-runner.ts for host-direct execution
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR, IDLE_TIMEOUT, TIMEZONE } from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { readEnvFile } from './env.js';
import {
  trackTask,
  updateTaskStatus,
  removeTask,
} from './task-status-tracker.js';
import { RegisteredGroup } from './types.js';
import { isRateLimitError, getCooldownMs, getActiveProvider, getFallbackEnvOverrides } from './provider-fallback.js';
import { recordAction, detectLoop, resetLoop } from './loop-detector.js';
import { getCurrentToken, refreshCodexToken } from './token-rotation.js';

const MAX_RATE_LIMIT_RETRIES = 3;

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

const AGENT_TIMEOUT = parseInt(process.env.AGENT_TIMEOUT || '1800000', 10);
const MAX_OUTPUT_SIZE = parseInt(
  process.env.AGENT_MAX_OUTPUT_SIZE || '10485760',
  10,
);

export interface AgentInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  agentType?: 'claude-code' | 'codex';
  thinkingEnv?: Record<string, string>;
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Prepare the host environment for agent execution.
 * Sets up directories, syncs skills, and writes settings.
 */
function prepareGroupEnvironment(
  group: RegisteredGroup,
  isMain: boolean,
): void {
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Per-group Claude sessions directory
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Per-group IPC namespace
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
}

/**
 * Build environment variables for the agent process.
 * Loads secrets from .env and passes them directly (no credential proxy needed).
 */
function buildAgentEnv(
  group: RegisteredGroup,
  isMain: boolean,
): Record<string, string> {
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );

  // Load all secrets from .env
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_API_KEY',
    'BRAVE_API_KEY',
    'NOTION_API_KEY',
    'GROQ_API_KEY',
  ]);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // Agent identity
    TZ: TIMEZONE,
    HOME: process.env.HOME || '',
    // NanoClaw paths
    NANOCLAW_HOME: projectRoot,
    NANOCLAW_GROUP_DIR: groupDir,
    NANOCLAW_IPC_DIR: groupIpcDir,
    NANOCLAW_CHAT_JID: '',
    NANOCLAW_IS_MAIN: isMain ? '1' : '0',
    NANOCLAW_PROJECT_DIR: projectRoot,
    NANOCLAW_GLOBAL_DIR: path.join(GROUPS_DIR, 'global'),
    // Claude settings
    CLAUDE_HOME: groupSessionsDir,
    // Secrets (direct, no proxy)
    ...secrets,
  };

  // Token rotation — use active token if available.
  // If no token, Claude Code SDK will fall back to macOS Keychain auth.
  const activeToken = getCurrentToken();
  if (activeToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = activeToken;
  }

  // Provider fallback — check active provider
  if (getActiveProvider() !== 'claude') {
    const overrides = getFallbackEnvOverrides();
    Object.assign(env, overrides);
  }

  return env;
}

/**
 * Run an agent directly on the host as a child process.
 * No retry — agent sends responses via send_message MCP tool.
 */
export async function runHostAgent(
  group: RegisteredGroup,
  input: AgentInput,
  onProcess: (proc: ChildProcess, processId: string) => void,
  onOutput?: (output: AgentOutput) => Promise<void>,
): Promise<AgentOutput> {
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  prepareGroupEnvironment(group, input.isMain);

  const isCodex = input.agentType === 'codex';
  const runnerSubdir = isCodex ? 'codex-runner' : 'agent-runner';
  const agentRunnerPath = path.join(
    process.cwd(),
    'dist',
    runnerSubdir,
    'index.js',
  );
  if (!fs.existsSync(agentRunnerPath)) {
    return {
      status: 'error',
      result: null,
      error: `Agent runner not found at ${agentRunnerPath}. Run 'npm run build' first.`,
    };
  }

  return spawnAgentOnce(
    group,
    input,
    onProcess,
    onOutput,
    agentRunnerPath,
    groupDir,
  );
}

/**
 * Spawn the agent process once and return its result.
 * Extracted from runHostAgent to enable rate-limit retry logic.
 */
function spawnAgentOnce(
  group: RegisteredGroup,
  input: AgentInput,
  onProcess: (proc: ChildProcess, processId: string) => void,
  onOutput: ((output: AgentOutput) => Promise<void>) | undefined,
  agentRunnerPath: string,
  groupDir: string,
): Promise<AgentOutput> {
  const startTime = Date.now();

  const env = buildAgentEnv(group, input.isMain);
  env.NANOCLAW_CHAT_JID = input.chatJid;
  env.NANOCLAW_AGENT_TYPE = input.agentType || 'claude-code';

  // Apply thinking level environment variables
  if (input.thinkingEnv) {
    Object.assign(env, input.thinkingEnv);
  }

  // Codex-specific environment setup
  const isCodex = input.agentType === 'codex';
  if (isCodex) {
    // Refresh codex token before spawning (handles expiry during long-running NanoClaw)
    refreshCodexToken();

    const codexSecrets = readEnvFile([
      'OPENAI_API_KEY',
      'CODEX_MODEL',
      'CODEX_EFFORT',
    ]);
    Object.assign(env, codexSecrets);

    // Set CODEX_HOME to per-group sessions dir
    const groupSessionsDir = path.join(DATA_DIR, 'sessions', group.folder);
    const codexHome = path.join(groupSessionsDir, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    env.CODEX_HOME = codexHome;

    // Copy only essential codex auth/config files (skip .git, vendor_imports, etc.)
    const userCodexDir = path.join(process.env.HOME || '', '.codex');
    if (fs.existsSync(userCodexDir)) {
      for (const file of ['auth.json', 'config.toml']) {
        const src = path.join(userCodexDir, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(codexHome, file));
        }
      }
    }
  }

  const processId = `nanoclaw-${group.folder}-${Date.now()}`;

  logger.info(
    {
      group: group.name,
      processId,
      isMain: input.isMain,
      agentType: input.agentType || 'claude-code',
    },
    'Spawning host agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const agentProc = spawn('node', [agentRunnerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: groupDir,
    });

    onProcess(agentProc, processId);

    trackTask({
      processId,
      groupFolder: group.folder,
      groupName: group.name,
      chatJid: input.chatJid,
      startedAt: Date.now(),
      prompt: input.prompt.slice(0, 100),
      isScheduledTask: input.isScheduledTask === true,
      status: 'running',
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    agentProc.stdin.write(JSON.stringify(input));
    agentProc.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let hadStreamingOutput = false;

    agentProc.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Agent stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: AgentOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    agentProc.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ agent: group.folder }, line);
      }

      // Feed to loop detector
      const stderrLine = chunk.toString().trim();
      if (stderrLine.includes('Tool:') || stderrLine.includes('tool_use')) {
        recordAction(group.folder, stderrLine.slice(0, 200));
        const loopCheck = detectLoop(group.folder);
        if (loopCheck.looping && loopCheck.severity === 'block') {
          logger.error({ group: group.name, pattern: loopCheck.pattern }, 'Loop detected, killing agent');
          agentProc.kill('SIGTERM');
        }
      }

      if (stderrTruncated) return;
      const remaining = MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    const configTimeout = group.containerConfig?.timeout || AGENT_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processId },
        'Agent timeout, killing process',
      );
      agentProc.kill('SIGTERM');
      setTimeout(() => {
        if (!agentProc.killed) agentProc.kill('SIGKILL');
      }, 15000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    agentProc.on('close', (code) => {
      clearTimeout(timeout);
      resetLoop(group.folder);
      const duration = Date.now() - startTime;

      updateTaskStatus(processId, code === 0 ? 'completed' : 'error');
      removeTask(processId);

      if (timedOut) {
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, processId, duration, code },
            'Agent timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }

        resolve({
          status: 'error',
          result: null,
          error: `Agent timed out after ${configTimeout}ms`,
        });
        return;
      }

      // Write log file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `agent-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';
      const isError = code !== 0;

      if (isVerbose || isError) {
        const logLines = [
          `=== Agent Run Log ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `IsMain: ${input.isMain}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          ``,
        ];
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        }
        if (isError) {
          logLines.push(`=== Stderr ===`, stderr, ``, `=== Stdout ===`, stdout);
        }
        fs.writeFileSync(logFile, logLines.join('\n'));
      }

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration, logFile },
          'Agent exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Agent completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Legacy mode: parse last output marker
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);
        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }
        const output: AgentOutput = JSON.parse(jsonLine);
        logger.info(
          { group: group.name, duration, status: output.status },
          'Agent completed',
        );
        resolve(output);
      } catch (err) {
        logger.error(
          { group: group.name, stdout, stderr, error: err },
          'Failed to parse agent output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse agent output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    agentProc.on('error', (err) => {
      clearTimeout(timeout);
      updateTaskStatus(processId, 'error');
      removeTask(processId);
      logger.error(
        { group: group.name, processId, error: err },
        'Agent spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Agent spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];
  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      { groups: visibleGroups, lastSync: new Date().toISOString() },
      null,
      2,
    ),
  );
}
