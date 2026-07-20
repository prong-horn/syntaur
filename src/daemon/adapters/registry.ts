import type { AgentAdapter } from './types.js';

// Task 5 replaces this stub with the generic screen-heuristics adapter.
const fallbackAdapter: AgentAdapter = {
  id: 'generic',
  deriveState: () => ({}),
};

const adapters = new Map<string, AgentAdapter>();
// Task 7: adapters.set('claude', claudeAdapter);
// Task 8: adapters.set('codex', codexAdapter);

/** Resolve the adapter for a free-form agent string; unknown → generic. */
export function resolveAdapter(agent: string): AgentAdapter {
  return adapters.get(agent) ?? fallbackAdapter;
}
