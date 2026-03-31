---
name: Unified Streaming Controller
description: Coordinate Block Streaming and Preview Streaming for optimal UX in NanoClaw. Routes content based on type, size, and usage patterns.
agent: NanoClaw
domain: Message Streaming & Output Optimization
version: 1.0.0
---

## Description

Coordinate Block Streaming and Preview Streaming for optimal UX in NanoClaw. Routes content based on type, size, and usage patterns.

## When to Use

- When generating long responses (>500 tokens)
- When deciding between real-time preview vs structured blocks
- When handling multi-modal outputs (code, lists, tables)
- When optimizing for token efficiency and user experience

## Core Concepts

### Streaming Modes

1. **preview**: Real-time streaming during generation
2. **block**: Structured output after completion
3. **hybrid**: Preview until cutoff, then switch to blocks
4. **off**: No streaming (legacy behavior)

### Usage-Based Routing

```typescript
// High-cost queries (> $0.1) → block mode
// Long outputs (> 500 tokens) → hybrid mode
// Short outputs (< 100 tokens) → preview mode
```

## Quick Reference

### Start a Streaming Session

```typescript
import { getUnifiedStreamingController } from './index.js';

const controller = getUnifiedStreamingController();
const session = controller.startSession('session-id', 'chat-jid', {
  inputTokens: 1000,
  outputTokens: 2000,
  estimatedCost: 0.05,
  model: 'claude-3-sonnet',
  provider: 'anthropic'
});
```

### Stream Content

```typescript
// Stream partial content
controller.streamContent('session-id', 'Partial text...', false);

// Finalize stream
controller.streamContent('session-id', 'Final text', true);
```

### Get Formatted Output

```typescript
const output = controller.getOutput('session-id');
console.log(output.preview);  // Real-time preview
console.log(output.blocks);   // Structured blocks
```

## Configuration

```typescript
const controller = getUnifiedStreamingController({
  mode: 'hybrid',
  previewThreshold: 500,
  blockThreshold: 2000,
  hybridCutoff: 1000,
  enableSmartRouting: true,
  enableBackpressure: true,
  maxConcurrentStreams: 20
});
```

## Best Practices

1. **Always check session existence** before streaming
2. **Use hybrid mode** for unknown content lengths
3. **Enable backpressure** for high-throughput scenarios
4. **Call cleanup()** periodically to free resources
5. **Use usage-based routing** for cost-sensitive applications

## Common Patterns

### Pattern 1: Simple Text Response

```typescript
const session = controller.startSession('simple', chatJid);
controller.streamContent('simple', 'Hello, world!', true);
```

### Pattern 2: Code-Heavy Response

```typescript
const session = controller.startSession('code', chatJid, {
  outputTokens: 1500,
  estimatedCost: 0.08
});
// Automatically selects 'block' mode for structured code output
```

### Pattern 3: Interactive Conversation

```typescript
const session = controller.startSession('chat', chatJid, {
  outputTokens: 200,
  estimatedCost: 0.02
});
// Automatically selects 'preview' mode for quick responses
```

## Integration with Other Systems

- Works with **AdvancedBlockStreamer** for content type detection
- Works with **AdvancedPreviewStreamer** for throttled updates
- Compatible with **ContextCompactor** for long sessions
- Integrates with **TokenTracker** for budget management

## Error Handling

```typescript
const session = controller.startSession('id', 'jid');
if (!session) {
  logger.error('Failed to create streaming session');
  return;
}

try {
  controller.streamContent('id', content, isComplete);
} catch (err) {
  logger.error({ err }, 'Streaming error');
  controller.endSession('id');
}
```

## Performance Tips

1. Set `maxConcurrentStreams` based on memory constraints
2. Use `cleanupIntervalMs` to prevent memory leaks
3. Enable `enableAdaptiveThrottling` for variable network conditions
4. Monitor `backpressureStatus` for queue health

## Related Skills

- block-streaming.md - Content type detection and formatting
- preview-streaming.md - Real-time preview management
- token-tracker.md - Token budget and usage tracking

## Changelog

- v1.0.0 (2026-03-24): Initial skill definition
