/**
 * Task Status Tracker for NanoClaw
 * Tracks currently running agent processes and provides a dashboard summary.
 */

export interface RunningTask {
  processId: string;
  groupFolder: string;
  groupName: string;
  chatJid: string;
  startedAt: number;
  prompt: string; // first 100 chars
  isScheduledTask: boolean;
  status: 'running' | 'completed' | 'error';
}

const runningTasks = new Map<string, RunningTask>();

export function trackTask(task: RunningTask): void {
  runningTasks.set(task.processId, task);
}

export function updateTaskStatus(
  processId: string,
  status: RunningTask['status'],
): void {
  const task = runningTasks.get(processId);
  if (task) {
    task.status = status;
  }
}

export function removeTask(processId: string): void {
  runningTasks.delete(processId);
}

export function getRunningTasks(): RunningTask[] {
  return Array.from(runningTasks.values()).filter(
    (t) => t.status === 'running',
  );
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return `${hours}시간 ${remainMinutes}분`;
}

export function formatDashboard(): string {
  const tasks = getRunningTasks();
  const now = Date.now();

  const lines: string[] = [
    '📊 NanoClaw 상태',
    '━━━━━━━━━━━━━━━',
    `실행 중: ${tasks.length}개`,
  ];

  if (tasks.length > 0) {
    lines.push('');
    for (const task of tasks) {
      const elapsed = formatElapsed(now - task.startedAt);
      const preview = task.prompt.slice(0, 60).replace(/\n/g, ' ');
      const scheduled = task.isScheduledTask ? ' [예약]' : '';
      lines.push(`• ${task.groupName} — ${preview}${scheduled} (${elapsed})`);
    }
  }

  const timestamp = new Date().toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
  });
  lines.push('');
  lines.push(`마지막 업데이트: ${timestamp}`);

  return lines.join('\n');
}
