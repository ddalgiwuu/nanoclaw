---
name: Memory Systems
description: Multi-layer memory architecture for NanoClaw - working memory for active context, episodic memory for conversation history, and semantic memory for knowledge retrieval.
agent: NanoClaw
domain: Persistent Knowledge & Context
version: 1.0.0
---

## Memory Layers

### Working Memory
- Active conversation context
- Current task state
- Temporary variables

### Episodic Memory
- Past conversation summaries
- User preferences and patterns
- Historical decisions

### Semantic Memory
- Knowledge base entries
- Learned facts and concepts
- Cross-conversation insights

## Quick Reference

```typescript
import { getMemoryManager } from './index.js';

const memory = getMemoryManager();

// Store fact
await memory.store('user_preference', { key: 'theme', value: 'dark' });

// Retrieve
const pref = await memory.retrieve('user_preference', { key: 'theme' });

// Search
const results = await memory.semanticSearch('authentication methods');
```

## Changelog

- v1.0.0 (2026-03-24): Initial skill definition
