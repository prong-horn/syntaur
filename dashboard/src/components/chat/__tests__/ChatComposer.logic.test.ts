import { describe, it, expect } from 'vitest';
import {
  addressedAgentId,
  applyCommand,
  detectActiveCommand,
  emptyCommandsCopy,
  isExactCommand,
  rankCommands,
} from '../../../lib/command-autocomplete';
import type { ChatCommand, ChatCommandsSource } from '../../../lib/chat-types';

const agents = ['planner', 'codex'];
const commands: ChatCommand[] = [
  { name: 'plan-ticket', description: 'Plan the ticket', inputHint: null, action: { kind: 'prompt' } },
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
    const active = detectActiveCommand('/plan-t', 7, agents)!;
    expect(rankCommands(active.partial, commands).map((c) => c.name)).toEqual(['plan-ticket']);
  });

  it('applies /plan-ticket with a trailing space', () => {
    const active = detectActiveCommand('/plan-t', 7, agents)!;
    expect(applyCommand('/plan-t', active, 'plan-ticket').text).toBe('/plan-ticket ');
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

describe('isExactCommand', () => {
  it('is true for /plan with plan listed and caret at the end', () => {
    const active = detectActiveCommand('/plan', 5, agents)!;
    expect(isExactCommand(active, 5, commands)).toBe(true);
  });

  it('is false mid-token', () => {
    const active = detectActiveCommand('/pla', 4, agents)!;
    expect(isExactCommand(active, 4, commands)).toBe(false);
  });

  it('is false when only plan-ticket is listed as a partial match', () => {
    const active = detectActiveCommand('/plan', 5, agents)!;
    const onlyLong = commands.filter((c) => c.name === 'plan-ticket');
    expect(isExactCommand(active, 5, onlyLong)).toBe(false);
  });

  it('is false with the caret before the token end', () => {
    const active = detectActiveCommand('/plan', 5, agents)!;
    expect(isExactCommand(active, 3, commands)).toBe(false);
  });
});

describe('emptyCommandsCopy', () => {
  it('includes the addressed id and the send-as-is note', () => {
    expect(emptyCommandsCopy('codex')).toBe(
      'No commands advertised by @codex yet — a /command you type is still sent as-is',
    );
  });
});
