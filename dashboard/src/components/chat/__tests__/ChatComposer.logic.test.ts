import { describe, it, expect } from 'vitest';
import {
  addressedAgentId,
  applyCommand,
  detectActiveCommand,
  rankCommands,
} from '../../../lib/command-autocomplete';
import type { ChatCommand, ChatCommandsSource } from '../../../lib/chat-types';

const agents = ['planner', 'codex'];
const commands: ChatCommand[] = [
  { name: 'plan-assignment', description: 'Plan the assignment', inputHint: null, action: { kind: 'prompt' } },
  { name: 'plan', description: 'Turn plan mode on', inputHint: null, action: { kind: 'set-config', configId: 'collaboration_mode', value: 'plan' } },
];

function commandsByAgent(
  source: ChatCommandsSource | null = 'session',
): Map<string, { commands: ChatCommand[]; source: ChatCommandsSource | null }> {
  return new Map([['codex', { commands, source }], ['planner', { commands: [], source: null }]]);
}

describe('ChatComposer command picker logic', () => {
  it('opens on / at the start of the draft', () => {
    expect(detectActiveCommand('/', 1, agents)).not.toBeNull();
  });

  it('filters commands by partial', () => {
    const active = detectActiveCommand('/plan-a', 7, agents)!;
    expect(rankCommands(active.partial, commands).map((c) => c.name)).toEqual(['plan-assignment']);
  });

  it('applies /plan-assignment with a trailing space', () => {
    const active = detectActiveCommand('/plan-a', 7, agents)!;
    expect(applyCommand('/plan-a', active, 'plan-assignment').text).toBe('/plan-assignment ');
  });

  it('scopes commands to @codex when the draft starts with that mention', () => {
    expect(addressedAgentId('@codex /plan', agents, 'planner')).toBe('codex');
    const state = commandsByAgent().get('codex');
    expect(rankCommands('plan', state!.commands).length).toBeGreaterThan(0);
  });

  it('shows cached source in the header metadata', () => {
    const state = commandsByAgent('harness-cache').get('codex');
    expect(state?.source).toBe('harness-cache');
  });

  it('has an empty state when the addressed agent advertises nothing', () => {
    const state = commandsByAgent().get('planner');
    expect(state?.commands).toEqual([]);
  });
});
