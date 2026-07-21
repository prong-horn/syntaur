import type { AgentAdapter } from './types.js';
import { genericAdapter } from './generic.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';

const adapters = new Map<string, AgentAdapter>();
adapters.set('claude', claudeAdapter);
adapters.set('codex', codexAdapter);

/** Resolve the adapter for a free-form agent string; unknown → generic. */
export function resolveAdapter(agent: string): AgentAdapter {
  return adapters.get(agent) ?? genericAdapter;
}
