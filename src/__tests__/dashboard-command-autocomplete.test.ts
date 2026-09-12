import { describe, it, expect } from 'vitest';
import { detectCommand } from '../chat/commands.js';
import {
  addressedAgentId,
  applyCommand,
  detectActiveCommand,
  rankCommands,
} from '../../dashboard/src/lib/command-autocomplete';
import type { ChatCommand } from '../../dashboard/src/lib/chat-types';

const attached = ['planner', 'codex'];

describe('detectActiveCommand', () => {
  it('opens on / at start', () => {
    expect(detectActiveCommand('/con', 4, attached)).toEqual({ start: 0, end: 4, partial: 'con' });
  });

  it('opens after a leading attached mention', () => {
    expect(detectActiveCommand('@codex /pl', 10, attached)).toEqual({ start: 7, end: 10, partial: 'pl' });
  });

  it('returns null for / mid-text', () => {
    expect(detectActiveCommand('run /context', 12, attached)).toBeNull();
  });
});

describe('addressedAgentId', () => {
  it('uses the first leading attached mention', () => {
    expect(addressedAgentId('@codex /plan', attached, 'planner')).toBe('codex');
  });

  it('falls back to the default agent', () => {
    expect(addressedAgentId('/plan', attached, 'planner')).toBe('planner');
  });
});

describe('rankCommands', () => {
  const commands: ChatCommand[] = [
    { name: 'plan-ticket', description: 'Plan work', inputHint: null, action: { kind: 'prompt' } },
    { name: 'plan', description: 'Turn plan mode on', inputHint: null, action: { kind: 'set-config', configId: 'collaboration_mode', value: 'plan' } },
    { name: 'status', description: 'Show plan status', inputHint: null, action: { kind: 'prompt' } },
  ];

  it('ranks prefix matches first and caps at eight', () => {
    expect(rankCommands('plan', commands).map((c) => c.name)).toEqual(['plan', 'plan-ticket', 'status']);
  });
});

describe('applyCommand', () => {
  it('inserts /name with a trailing space', () => {
    const active = detectActiveCommand('/pla', 4, attached)!;
    expect(applyCommand('/pla', active, 'plan-ticket')).toEqual({
      text: '/plan-ticket ',
      caret: 13,
    });
  });
});

describe('server/SPA parity', () => {
  const samples = [
    '/context',
    '@codex /goal ship it',
    '@unknown /context',
    'please /context',
    '/plugin:cmd arg',
  ];

  it('agrees with detectCommand on whether text is a command', () => {
    for (const text of samples) {
      const server = detectCommand(text, attached);
      if (server) {
        const start = text.indexOf(`/${server.name}`);
        expect(detectActiveCommand(text, start + 1 + server.name.length, attached)).not.toBeNull();
      } else {
        expect(detectActiveCommand(text, text.length, attached)).toBeNull();
      }
    }
  });
});
