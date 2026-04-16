export interface ChunkOptions {
  maxLength?: number;
}

const DEFAULT_MAX = 4096; // Telegram limit

export function chunkMessage(text: string, opts?: ChunkOptions): string[] {
  const maxLen = opts?.maxLength || DEFAULT_MAX;
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    const segment = remaining.slice(0, maxLen);
    let breakAt = -1;

    // Try paragraph break
    breakAt = segment.lastIndexOf('\n\n');
    if (breakAt > maxLen * 0.3) {
      chunks.push(remaining.slice(0, breakAt).trimEnd());
      remaining = remaining.slice(breakAt + 2).trimStart();
      continue;
    }

    // Try newline break
    breakAt = segment.lastIndexOf('\n');
    if (breakAt > maxLen * 0.3) {
      chunks.push(remaining.slice(0, breakAt).trimEnd());
      remaining = remaining.slice(breakAt + 1).trimStart();
      continue;
    }

    // Try sentence break
    breakAt = segment.lastIndexOf('. ');
    if (breakAt > maxLen * 0.3) {
      chunks.push(remaining.slice(0, breakAt + 1).trimEnd());
      remaining = remaining.slice(breakAt + 2).trimStart();
      continue;
    }

    // Try word break
    breakAt = segment.lastIndexOf(' ');
    if (breakAt > maxLen * 0.3) {
      chunks.push(remaining.slice(0, breakAt).trimEnd());
      remaining = remaining.slice(breakAt + 1).trimStart();
      continue;
    }

    // Hard break
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }

  return chunks.filter((c) => c.length > 0);
}
