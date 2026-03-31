# SKILL.md - Advanced Preview Streaming
# Agent: NanoClaw
# Domain: Real-time Output Streaming
# Version: 1.0.0

## Description

Provide real-time preview updates during LLM generation with intelligent throttling, chunking, and smart breaks. Optimizes for both responsiveness and token efficiency.

## When to Use

- When users need immediate visual feedback
- When generating long responses incrementally
- When network conditions are variable
- When balancing update frequency with API costs

## Core Features

1. **Throttling**: Limit update frequency to prevent spam
2. **Chunking**: Split large outputs into manageable pieces
3. **Smart Breaks**: Break at sentence boundaries when possible
4. **Burst Control**: Handle temporary high-frequency updates

## Quick Reference

### Start a Preview

```typescript
import { getAdvancedPreviewStreamer } from './index.js';

const streamer = getAdvancedPreviewStreamer();
const preview = streamer.startPreview('session-1', 'message-1', 'Loading...');
```

### Add Content

```typescript
// Content is automatically throttled and chunked
streamer.addContent('message-1', 'First sentence. ');
streamer.addContent('message-1', 'Second sentence. ');
streamer.addContent('message-1', 'Third sentence.');
```

### Finalize

```typescript
const final = streamer.finalizePreview('message-1', ' Done!');
console.log(final.content); // 'Loading... First sentence. Second sentence. Third sentence. Done!'
console.log(final.isGenerating); // false
```

## Configuration

```typescript
const streamer = getAdvancedPreviewStreamer({
  throttleMs: 150,          // Minimum time between updates
  burstLimit: 5,            // Max updates per burst window
  burstWindowMs: 1000,      // Burst window duration
  
  enableChunking: true,     // Enable content chunking
  chunkSize: 100,           // Target chunk size
  smartBreaks: true,        // Break at sentence boundaries
  
  minUpdateChars: 10,       // Minimum characters to trigger update
  previewPrefix: '⏳ ',      // Prefix for preview messages
  previewSuffix: '...',     // Suffix for incomplete previews
});
```

## Throttling Mechanism

### Standard Throttling

```typescript
// Updates are rate-limited to prevent API spam
// Default: 150ms minimum between updates
streamer.addContent('msg-1', 'A'); // Immediate
streamer.addContent('msg-1', 'B'); // Delayed if < 150ms
streamer.addContent('msg-1', 'C'); // Delayed if < 150ms
```

### Burst Handling

```typescript
// Temporary high-frequency updates are allowed
// Default: 5 updates per 1-second window
for (let i = 0; i < 10; i++) {
  streamer.addContent('msg-1', `Part ${i} `); // First 5 immediate, rest throttled
}
```

## Smart Chunking

### Sentence Boundary Detection

```typescript
// Smart breaks try to end chunks at sentence boundaries
const text = 'First sentence. Second sentence. Third sentence.';
// Chunks: ['First sentence. ', 'Second sentence. ', 'Third sentence.']
```

### Minimum Update Size

```typescript
// Small additions are buffered until threshold
streamer.addContent('msg-1', 'Hi');      // Buffered (2 < 10 chars)
streamer.addContent('msg-1', ' there');  // Buffered (9 < 10 chars)
streamer.addContent('msg-1', '!');       // Sent: 'Hi there!' (10 chars)
```

## Preview Formatting

### Get Formatted Preview

```typescript
const formatted = streamer.formatPreview('message-1');
// Output: "⏳ Loading... First sentence. Second sentence..."
```

### Custom Prefix/Suffix

```typescript
const streamer = getAdvancedPreviewStreamer({
  previewPrefix: '🤔 ',
  previewSuffix: ' (thinking...)'
});

const formatted = streamer.formatPreview('msg-1');
// Output: "🤔 Partial content (thinking...)"
```

## Completion Handlers

```typescript
streamer.startPreview('session', 'msg');

// Register completion callback
streamer.onComplete('msg', (finalState) => {
  console.log('Preview complete:', finalState.content);
  console.log('Total time:', finalState.totalTime, 'ms');
  console.log('Update count:', finalState.updateCount);
});

// Finalize triggers callback
streamer.finalizePreview('msg', ' Final text');
```

## Session Management

```typescript
// Get preview state
const state = streamer.getPreview('message-1');
console.log(state.content);        // Current content
console.log(state.isGenerating);   // Still generating?
console.log(state.updateCount);    // Number of updates

// Get all active previews
const active = streamer.getActivePreviews();
console.log(active.length);        // Number of active previews

// Check global stats
const stats = streamer.getStats();
console.log(stats.totalPreviews);  // Total previews created
console.log(stats.totalUpdates);   // Total update calls
```

## Best Practices

1. **Set appropriate throttleMs** for your API rate limits
2. **Enable smartBreaks** for better readability
3. **Use completion handlers** for cleanup
4. **Monitor burstLimit** to prevent sudden spikes
5. **Call cleanup()** periodically to free old previews

## Error Handling

```typescript
try {
  const state = streamer.startPreview('session', 'msg', 'Initial');
  if (!state) {
    throw new Error('Failed to create preview');
  }
  
  streamer.addContent('msg', content);
  streamer.finalizePreview('msg');
} catch (err) {
  logger.error({ err }, 'Preview streaming error');
}
```

## Performance Optimization

### For Low-Latency APIs

```typescript
const streamer = getAdvancedPreviewStreamer({
  throttleMs: 50,      // Faster updates
  burstLimit: 10,      // More burst capacity
  minUpdateChars: 5,   // Smaller updates
});
```

### For High-Cost APIs

```typescript
const streamer = getAdvancedPreviewStreamer({
  throttleMs: 500,     // Slower, cheaper updates
  burstLimit: 2,       // Strict burst limit
  minUpdateChars: 50,  // Larger batches
});
```

## Integration with Unified Streaming

```typescript
const controller = getUnifiedStreamingController();

// Preview streamer is used when mode is 'preview' or 'hybrid'
const session = controller.startSession('id', 'jid');
controller.streamContent('id', 'Streaming...', false);
// → Internally uses AdvancedPreviewStreamer
```

## Monitoring

```typescript
// Monitor for backpressure
const stats = streamer.getStats();
if (stats.throttledUpdates > stats.totalUpdates * 0.5) {
  logger.warn('High throttling rate - consider adjusting throttleMs');
}
```

## Changelog

- v1.0.0 (2026-03-24): Initial skill definition
