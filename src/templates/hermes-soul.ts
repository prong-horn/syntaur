import { renderCodexAgents, type CodexAgentsParams } from './codex-agents.js';

export type HermesSoulParams = CodexAgentsParams;

/**
 * Hermes Agent reads `SOUL.md` (its identity / system-prompt slot) plus context
 * files. We embed the same Syntaur protocol body the Codex `AGENTS.md` adapter
 * emits, framed as a SOUL section so it composes with Hermes' persona file
 * rather than fighting it.
 */
export function renderHermesSoul(params: HermesSoulParams): string {
  const body = renderCodexAgents(params);
  return `# SOUL -- Syntaur Protocol Operator

This agent follows the Syntaur protocol for multi-agent project coordination.
Hermes loads this file as part of its identity / system context; treat the
Write Boundary Rules and Lifecycle sections below as binding.

${body}`;
}
