/**
 * GitHub CI Watch
 *
 * Polls GitHub Actions run status via `gh api` CLI and reports completion.
 * Designed for use with NanoClaw's task scheduler to watch CI pipelines.
 */
import { execFile } from 'child_process';

import { logger } from './logger.js';
import { TIMEZONE } from './config.js';

// ── Types ──

export interface GitHubCiMetadata {
  repo: string;
  run_id: number;
  poll_count?: number;
  consecutive_errors?: number;
  last_checked_at?: string;
}

interface GitHubActionsRunResponse {
  status?: string | null;
  conclusion?: string | null;
  name?: string | null;
  display_title?: string | null;
  html_url?: string | null;
  head_branch?: string | null;
  head_sha?: string | null;
  event?: string | null;
}

interface GitHubActionsJobsResponse {
  jobs?: Array<{
    name?: string | null;
    conclusion?: string | null;
  }>;
}

export interface GitHubRunCheckResult {
  terminal: boolean;
  resultSummary: string;
  completionMessage?: string;
}

// ── Constants ──

export const MAX_GITHUB_CONSECUTIVE_ERRORS = 5;
export const DEFAULT_WATCH_CI_MAX_DURATION_MS = 24 * 60 * 60 * 1000;

/** Backoff steps: after N ms elapsed, use at least delayMs between polls */
export const GITHUB_WATCH_BACKOFF_STEPS = [
  { afterMs: 60 * 60 * 1000, delayMs: 60_000 },
  { afterMs: 10 * 60 * 1000, delayMs: 30_000 },
] as const;

// ── gh CLI wrapper ──

function execGhApi(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      ['api', ...args],
      {
        maxBuffer: 10 * 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const details = stderr?.trim() || stdout?.trim() || error.message;
          reject(new Error(`gh api failed: ${details}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

// ── Metadata parsing / serialization ──

export function parseGitHubCiMetadata(
  raw: string | null | undefined,
): GitHubCiMetadata | null {
  if (!raw) return null;

  let parsed: Partial<GitHubCiMetadata>;
  try {
    parsed = JSON.parse(raw) as Partial<GitHubCiMetadata>;
  } catch {
    return null;
  }
  if (typeof parsed.repo !== 'string' || parsed.repo.trim() === '') {
    return null;
  }

  const runId = Number(parsed.run_id);
  if (!Number.isInteger(runId) || runId <= 0) {
    return null;
  }

  return {
    repo: parsed.repo,
    run_id: runId,
    poll_count:
      Number.isInteger(parsed.poll_count) && parsed.poll_count! >= 0
        ? parsed.poll_count
        : undefined,
    consecutive_errors:
      Number.isInteger(parsed.consecutive_errors) &&
      parsed.consecutive_errors! >= 0
        ? parsed.consecutive_errors
        : undefined,
    last_checked_at:
      typeof parsed.last_checked_at === 'string' &&
      parsed.last_checked_at.trim() !== ''
        ? parsed.last_checked_at
        : undefined,
  };
}

export function serializeGitHubCiMetadata(metadata: GitHubCiMetadata): string {
  return JSON.stringify(metadata);
}

// ── Watch delay with backoff ──

/**
 * Compute the polling delay for a CI watcher task.
 * Increases the delay as the task ages (backoff).
 */
export function computeGitHubWatcherDelayMs(
  task: { schedule_value: string; created_at: string },
  nowMs: number,
): number {
  const baseDelayMs = Number.parseInt(task.schedule_value, 10);
  const normalizedBaseDelayMs =
    Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? baseDelayMs : 15_000;

  const createdAtMs = new Date(task.created_at).getTime();
  const elapsedMs = Number.isFinite(createdAtMs)
    ? Math.max(0, nowMs - createdAtMs)
    : 0;

  for (const step of GITHUB_WATCH_BACKOFF_STEPS) {
    if (elapsedMs >= step.afterMs) {
      return Math.max(normalizedBaseDelayMs, step.delayMs);
    }
  }

  return normalizedBaseDelayMs;
}

// ── Conclusion label formatting ──

function formatConclusionLabel(conclusion: string | null | undefined): string {
  switch (conclusion) {
    case 'success':
      return 'Success';
    case 'failure':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'timed_out':
      return 'Timed out';
    case 'action_required':
      return 'Action required';
    case 'neutral':
      return 'Neutral';
    case 'skipped':
      return 'Skipped';
    case 'stale':
      return 'Stale';
    default:
      return conclusion || 'Completed';
  }
}

// ── Fetch failed jobs ──

async function fetchFailedJobs(metadata: GitHubCiMetadata): Promise<string[]> {
  const stdout = await execGhApi([
    `repos/${metadata.repo}/actions/runs/${metadata.run_id}/jobs?per_page=100`,
  ]);
  const parsed = JSON.parse(stdout) as GitHubActionsJobsResponse;
  return (parsed.jobs || [])
    .filter(
      (job) =>
        job.conclusion &&
        ['failure', 'cancelled', 'timed_out', 'startup_failure'].includes(
          job.conclusion,
        ),
    )
    .map((job) => job.name?.trim())
    .filter((name): name is string => Boolean(name))
    .slice(0, 3);
}

// ── Status message rendering ──

export type WatcherStatusPhase =
  | 'checking'
  | 'waiting'
  | 'retrying'
  | 'completed';

function formatTimeLabel(timestampIso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: TIMEZONE,
  }).format(new Date(timestampIso));
}

function formatElapsedLabel(
  startedAtIso: string,
  checkedAtIso: string,
): string {
  const elapsedMs = Math.max(
    0,
    new Date(checkedAtIso).getTime() - new Date(startedAtIso).getTime(),
  );
  const totalSeconds = Math.floor(elapsedMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * Render a human-readable status message for a CI watcher.
 */
export function renderWatchCiStatusMessage(args: {
  target: string;
  phase: WatcherStatusPhase;
  checkedAt: string;
  statusStartedAt?: string | null;
  intervalMs?: number | null;
  nextRun?: string | null;
}): string {
  const title =
    args.phase === 'completed'
      ? `CI watch done: ${args.target}`
      : `Watching CI: ${args.target}`;
  const statusLabel =
    args.phase === 'checking'
      ? 'Checking'
      : args.phase === 'retrying'
        ? 'Retrying'
        : args.phase === 'completed'
          ? 'Completed'
          : 'Waiting';

  const lines = [
    title,
    `- Status: ${statusLabel}`,
    `- Last check: ${formatTimeLabel(args.checkedAt)}`,
  ];
  if (args.statusStartedAt) {
    lines.push(
      `- Elapsed: ${formatElapsedLabel(args.statusStartedAt, args.checkedAt)}`,
    );
  }
  if (args.intervalMs && args.intervalMs > 0) {
    const sec = Math.floor(args.intervalMs / 1000);
    lines.push(
      `- Interval: ${sec >= 60 ? `${Math.floor(sec / 60)}m` : `${sec}s`}`,
    );
  }
  if (args.nextRun) {
    lines.push(`- Next check: ${formatTimeLabel(args.nextRun)}`);
  }
  return lines.join('\n');
}

// ── Main check function ──

/**
 * Check the status of a GitHub Actions run.
 * Returns whether the run is terminal and a formatted completion message.
 */
export async function checkGitHubActionsRun(
  metadata: GitHubCiMetadata,
  targetLabel?: string,
): Promise<GitHubRunCheckResult> {
  const stdout = await execGhApi([
    `repos/${metadata.repo}/actions/runs/${metadata.run_id}`,
  ]);
  const run = JSON.parse(stdout) as GitHubActionsRunResponse;
  const status = run.status || 'unknown';

  if (status !== 'completed') {
    return {
      terminal: false,
      resultSummary: `GitHub Actions run ${metadata.run_id} is ${status}`,
    };
  }

  let failedJobs: string[] = [];
  try {
    failedJobs = await fetchFailedJobs(metadata);
  } catch {
    failedJobs = [];
  }

  const target = targetLabel || `GitHub Actions run ${metadata.run_id}`;
  const conclusionLabel = formatConclusionLabel(run.conclusion);

  const lines = [
    `CI completed: ${target}`,
    `Result: ${conclusionLabel}`,
    `- Repo: ${metadata.repo}`,
  ];

  if (run.name) {
    lines.push(`- Workflow: ${run.name}`);
  }
  if (run.head_branch) {
    lines.push(`- Branch: ${run.head_branch}`);
  }
  if (failedJobs.length > 0) {
    lines.push(`- Failed jobs: ${failedJobs.join(', ')}`);
  }
  if (run.html_url) {
    lines.push(`- Link: ${run.html_url}`);
  }

  logger.info(
    { repo: metadata.repo, runId: metadata.run_id, conclusion: run.conclusion },
    `CI watch completed: ${conclusionLabel}`,
  );

  return {
    terminal: true,
    resultSummary: `${conclusionLabel}: ${metadata.repo} run ${metadata.run_id}`,
    completionMessage: lines.join('\n'),
  };
}
