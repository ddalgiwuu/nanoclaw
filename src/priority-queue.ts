export enum MessagePriority {
  CONTROL = 0,
  HIGH = 1,
  NORMAL = 2,
  LOW = 3,
}

const CONTROL_PATTERNS = [
  /^\/compact/i,
  /^\/status/i,
  /^\/think/i,
  /^\/prune/i,
  /^\/stop/i,
  /^\/reset/i,
];

export function classifyPriority(content: string): MessagePriority {
  const trimmed = content.replace(/^@\w+\s*/, '').trim();
  for (const pattern of CONTROL_PATTERNS) {
    if (pattern.test(trimmed)) return MessagePriority.CONTROL;
  }
  return MessagePriority.NORMAL;
}

interface QueueItem<T> {
  data: T;
  priority: MessagePriority;
  insertedAt: number;
}

export class PriorityQueue<T> {
  private items: QueueItem<T>[] = [];

  enqueue(data: T, priority: MessagePriority = MessagePriority.NORMAL): void {
    const item: QueueItem<T> = { data, priority, insertedAt: Date.now() };
    // Insert in priority order (lower number = higher priority)
    let inserted = false;
    for (let i = 0; i < this.items.length; i++) {
      if (item.priority < this.items[i].priority) {
        this.items.splice(i, 0, item);
        inserted = true;
        break;
      }
    }
    if (!inserted) this.items.push(item);
  }

  dequeue(): T | undefined {
    return this.items.shift()?.data;
  }

  peek(): T | undefined {
    return this.items[0]?.data;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }
}
