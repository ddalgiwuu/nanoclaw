---
name: Advanced Block Streaming
description: Detect and format content blocks (code, headers, lists, tables, etc.) for structured output. Automatically identifies content types and applies appropriate formatting.
agent: NanoClaw
domain: Structured Content Output
version: 1.0.0
---

## When to Use

- When output contains mixed content types
- When generating code examples
- When creating structured documentation
- When formatting API responses or logs

## Supported Block Types

| Type | Detection Pattern | Example |
|------|-------------------|---------|
| `text` | Default | Plain text content |
| `code` | Triple backticks | ```typescript\nconst x = 1;\n``` |
| `header` | # ## ### | # Header 1, ## Header 2 |
| `list` | - * + 1. | - Item 1\n- Item 2 |
| `quote` | > | > Quoted text |
| `table` | \| \| | \| Col1 \| Col2 \| |
| `divider` | --- === *** | Horizontal rule |

## Quick Reference

### Start a Block Session

```typescript
import { getAdvancedBlockStreamer } from './index.js';

const streamer = getAdvancedBlockStreamer();
streamer.startSession('my-session');
```

### Auto-Detect and Add Blocks

```typescript
// Start with undefined type for auto-detection
streamer.startBlock('my-session', undefined, '# Header');
streamer.completeBlock('my-session'); // Detects as 'header'

streamer.startBlock('my-session', undefined, '```ts\nconst x = 1;\n```');
const block = streamer.completeBlock('my-session'); // Detects as 'code', language: 'ts'
```

### Manual Block Creation

```typescript
streamer.addBlock('my-session', 'text', 'Plain text content');
streamer.addBlock('my-session', 'code', 'console.log("hi")', { language: 'javascript' });
streamer.addBlock('my-session', 'header', 'Section Title', { level: 2 });
```

### Streaming Blocks

```typescript
// Start a streaming block
streamer.startBlock('my-session', 'code', 'function example() {', { language: 'typescript' });

// Append content
streamer.appendToBlock('my-session', '\n  return 42;\n}');

// Complete the block
const block = streamer.completeBlock('my-session');
```

## Configuration

```typescript
const streamer = getAdvancedBlockStreamer({
  maxBlocksPerSession: 50,
  enableAutoDetection: true,
  onBlockCreated: (block) => {
    logger.debug(`Created ${block.type} block`);
  }
});
```

## Content Detection Rules

### Code Blocks

- Detects language from markdown
- Supported languages: typescript, javascript, python, rust, go, java, cpp, c, csharp, ruby, php, swift, kotlin, sql, bash, json, yaml, markdown

### Headers

- # H1 Header (level: 1)
- ## H2 Header (level: 2)
- ### H3 Header (level: 3)

### Lists

- Unordered: - Item 1, - Item 2
- Ordered: 1. First, 2. Second

## Best Practices

1. Always end sessions to free memory
2. Use auto-detection for user-generated content
3. Specify types manually for known content
4. Set maxBlocksPerSession to prevent memory issues
5. Handle block creation events for real-time UI updates

## Changelog

- v1.0.0 (2026-03-24): Initial skill definition
