import { logger } from './logger.js';

export type BlockType =
  | 'text'
  | 'code'
  | 'header'
  | 'list'
  | 'table'
  | 'quote'
  | 'divider';

export interface ContentBlock {
  type: BlockType;
  content: string;
  language?: string; // for code blocks
  level?: number; // for headers (1-3)
}

/**
 * Detect and split text into typed content blocks.
 */
export function detectBlocks(text: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block (```)
    const codeMatch = line.match(/^```(\w+)?/);
    if (codeMatch) {
      const language = codeMatch[1] || undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      blocks.push({ type: 'code', content: codeLines.join('\n'), language });
      continue;
    }

    // Divider (---, ***, ===)
    if (/^[-*=]{3,}\s*$/.test(line)) {
      blocks.push({ type: 'divider', content: line });
      i++;
      continue;
    }

    // Header (# ## ###)
    const headerMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headerMatch) {
      blocks.push({
        type: 'header',
        content: headerMatch[2],
        level: headerMatch[1].length,
      });
      i++;
      continue;
    }

    // Quote (>)
    if (line.startsWith('> ') || line === '>') {
      const quoteLines: string[] = [];
      while (
        i < lines.length &&
        (lines[i].startsWith('> ') || lines[i] === '>')
      ) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', content: quoteLines.join('\n') });
      continue;
    }

    // List (- * + or 1.)
    if (/^[\s]*[-*+]\s/.test(line) || /^[\s]*\d+\.\s/.test(line)) {
      const listLines: string[] = [];
      while (
        i < lines.length &&
        (/^[\s]*[-*+]\s/.test(lines[i]) ||
          /^[\s]*\d+\.\s/.test(lines[i]) ||
          /^\s{2,}/.test(lines[i]))
      ) {
        listLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'list', content: listLines.join('\n') });
      continue;
    }

    // Table (|)
    if (line.includes('|') && line.trim().startsWith('|')) {
      const tableLines: string[] = [];
      while (
        i < lines.length &&
        lines[i].includes('|') &&
        lines[i].trim().startsWith('|')
      ) {
        tableLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'table', content: tableLines.join('\n') });
      continue;
    }

    // Empty line — skip
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Text (default) — collect consecutive non-special lines
    const textLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('```') &&
      !lines[i].match(/^#{1,3}\s/) &&
      !lines[i].startsWith('> ') &&
      !/^[-*=]{3,}\s*$/.test(lines[i]) &&
      !(lines[i].includes('|') && lines[i].trim().startsWith('|')) &&
      !/^[\s]*[-*+]\s/.test(lines[i]) &&
      !/^[\s]*\d+\.\s/.test(lines[i])
    ) {
      textLines.push(lines[i]);
      i++;
    }
    if (textLines.length > 0) {
      blocks.push({ type: 'text', content: textLines.join('\n') });
    }
  }

  return blocks;
}

/**
 * Format a single block for Telegram HTML output.
 */
export function formatBlockForTelegram(block: ContentBlock): string {
  switch (block.type) {
    case 'code':
      if (block.language) {
        return `<pre><code class="language-${block.language}">${escapeHtml(block.content)}</code></pre>`;
      }
      return `<pre>${escapeHtml(block.content)}</pre>`;
    case 'header':
      return `<b>${escapeHtml(block.content)}</b>`;
    case 'quote':
      return `<blockquote>${escapeHtml(block.content)}</blockquote>`;
    case 'list':
      return escapeHtml(block.content);
    case 'table':
      return `<pre>${escapeHtml(block.content)}</pre>`;
    case 'divider':
      return '\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014';
    case 'text':
    default:
      return escapeHtml(block.content);
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Detect blocks and format all for Telegram.
 */
export function formatAllBlocks(text: string): string {
  const blocks = detectBlocks(text);
  return blocks.map(formatBlockForTelegram).join('\n\n');
}
