import { logger } from './logger.js';

export interface ContextPlugin {
  name: string;
  ingest?(
    messages: Array<{
      content: string;
      sender_name: string;
      timestamp: string;
    }>,
    groupFolder: string,
  ): Promise<void>;
  assemble?(groupFolder: string): Promise<string | null>;
  compact?(groupFolder: string): Promise<void>;
  afterTurn?(groupFolder: string, result: string): Promise<void>;
}

const plugins: ContextPlugin[] = [];

export function registerPlugin(plugin: ContextPlugin): void {
  plugins.push(plugin);
  logger.info({ plugin: plugin.name }, 'Context plugin registered');
}

export function getPlugins(): ContextPlugin[] {
  return [...plugins];
}

export async function runIngest(
  messages: Array<{ content: string; sender_name: string; timestamp: string }>,
  groupFolder: string,
): Promise<void> {
  for (const plugin of plugins) {
    if (plugin.ingest) {
      try {
        await plugin.ingest(messages, groupFolder);
      } catch (err) {
        logger.error(
          { plugin: plugin.name, err },
          'Context plugin ingest error',
        );
      }
    }
  }
}

export async function runAssemble(groupFolder: string): Promise<string[]> {
  const additions: string[] = [];
  for (const plugin of plugins) {
    if (plugin.assemble) {
      try {
        const result = await plugin.assemble(groupFolder);
        if (result) additions.push(result);
      } catch (err) {
        logger.error(
          { plugin: plugin.name, err },
          'Context plugin assemble error',
        );
      }
    }
  }
  return additions;
}

export async function runCompact(groupFolder: string): Promise<void> {
  for (const plugin of plugins) {
    if (plugin.compact) {
      try {
        await plugin.compact(groupFolder);
      } catch (err) {
        logger.error(
          { plugin: plugin.name, err },
          'Context plugin compact error',
        );
      }
    }
  }
}

export async function runAfterTurn(
  groupFolder: string,
  result: string,
): Promise<void> {
  for (const plugin of plugins) {
    if (plugin.afterTurn) {
      try {
        await plugin.afterTurn(groupFolder, result);
      } catch (err) {
        logger.error(
          { plugin: plugin.name, err },
          'Context plugin afterTurn error',
        );
      }
    }
  }
}
