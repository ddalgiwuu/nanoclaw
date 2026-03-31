---
name: Context Compaction
description: Prevent context window exhaustion in long-running sessions by intelligently compressing conversation history. Uses Anthropic's context API for optimal cache control.
agent: NanoClaw
domain: Long Session Memory Management
version: 1.0.0
---

## When to Use

- When conversation exceeds 80% of context window
- When token usage approaches model limits
- When response quality degrades due to long history
- When you need to preserve important context while freeing space

## Quick Reference

### Compact a Session

```typescript
import { getContextCompactor } from './index.js';

const compactor = getContextCompactor();
const summary = await compactor.compact(sessionId);
```

### Configuration

```typescript
const compactor = getContextCompactor({
  minMessages: 6,
  maxMessagesToSummarize: 50,
  preserveRecent: 4,
  summaryMaxTokens: 500
});
```

## How It Works

1. Identifies oldest messages that can be summarized
2. Generates structured summary preserving key information
3. Replaces old messages with summary + recent context
4. Maintains conversation coherence

## Output Format

```xml
<context_summary>
  <overview>Brief summary of the conversation</overview>
  <key_facts>
    <fact>Important fact 1</fact>
    <fact>Important fact 2</fact>
  </key_facts>
  <decisions>
    <decision>Decision made during conversation</decision>
  </decisions>
  <action_items>
    <item>Outstanding action item</item>
  </action_items>
</context_summary>
```

## Changelog

- v1.0.0 (2026-03-24): Initial skill definition
