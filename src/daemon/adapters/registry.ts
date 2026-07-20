import type { AgentAdapter } from './types.js';
import { genericAdapter } from './generic.js';

const adapters = new Map<string, AgentAdapter>();
// Task 7: adapters.set('claude', claudeAdapter);
// Task 8: adapters.set('codex', codexAdapter);

/** Resolve the adapter for a free-form agent string; unknown → generic. */
export function resolveAdapter(agent: string): AgentAdapter {
  return adapters.get(agent) ?? genericAdapter;
}
