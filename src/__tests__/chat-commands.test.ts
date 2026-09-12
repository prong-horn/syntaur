import { describe, it, expect } from 'vitest';
import {
  commandsEqual,
  detectCommand,
  latestAdvertisedCommands,
  parseAvailableCommands,
  type ChatCommand,
} from '../chat/commands.js';
import type { ChatEvent, ChatEventKind } from '../chat/types.js';

const claudeEntry = {
  name: 'context',
  description: 'Show context usage',
  input: { hint: '[--json]' },
};

const codexSetConfig = {
  name: 'plan',
  description: 'Turn plan mode on.',
  input: null,
  _meta: {
    commandAction: {
      kind: 'setConfigOption',
      configId: 'collaboration_mode',
      value: 'plan',
      resetValue: 'default',
      presentation: 'state',
    },
  },
};

const codexPrefixPrompt = {
  name: 'goal',
  description: 'Set a goal to keep pursuing.',
  input: { hint: '[<objective>|clear|pause|resume]' },
  _meta: { commandAction: { kind: 'prefixPrompt', presentation: 'state' } },
};

const cursorEntry = {
  name: 'plan-ticket',
  description: 'Create a detailed implementation plan for the current ticket.',
};

describe('parseAvailableCommands', () => {
  it('maps claude entries with input.hint', () => {
    expect(
      parseAvailableCommands({ sessionUpdate: 'available_commands_update', availableCommands: [claudeEntry] }),
    ).toEqual([
      {
        name: 'context',
        description: 'Show context usage',
        inputHint: '[--json]',
        action: { kind: 'prompt' },
      },
    ]);
  });

  it('maps codex setConfigOption to set-config', () => {
    expect(
      parseAvailableCommands({
        sessionUpdate: 'available_commands_update',
        availableCommands: [codexSetConfig],
      }),
    ).toEqual([
      {
        name: 'plan',
        description: 'Turn plan mode on.',
        inputHint: null,
        action: { kind: 'set-config', configId: 'collaboration_mode', value: 'plan' },
      },
    ]);
  });

  it('maps codex prefixPrompt to prompt', () => {
    expect(
      parseAvailableCommands({
        sessionUpdate: 'available_commands_update',
        availableCommands: [codexPrefixPrompt],
      }),
    ).toEqual([
      {
        name: 'goal',
        description: 'Set a goal to keep pursuing.',
        inputHint: '[<objective>|clear|pause|resume]',
        action: { kind: 'prompt' },
      },
    ]);
  });

  it('maps cursor name-and-description-only entries', () => {
    expect(
      parseAvailableCommands({
        sessionUpdate: 'available_commands_update',
        availableCommands: [cursorEntry],
      }),
    ).toEqual([
      {
        name: 'plan-ticket',
        description: 'Create a detailed implementation plan for the current ticket.',
        inputHint: null,
        action: { kind: 'prompt' },
      },
    ]);
  });

  it('drops entries without a string name and ignores malformed _meta', () => {
    expect(
      parseAvailableCommands({
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { description: 'no name' },
          {
            name: 'bad-meta',
            description: 'x',
            _meta: { commandAction: { kind: 'setConfigOption', configId: 1, value: 'y' } },
          },
        ],
      }),
    ).toEqual([
      {
        name: 'bad-meta',
        description: 'x',
        inputHint: null,
        action: { kind: 'prompt' },
      },
    ]);
  });
});

describe('detectCommand', () => {
  const attached = ['claude', 'codex', 'planner'];

  it('detects a bare /command', () => {
    expect(detectCommand('/context', attached)).toEqual({
      name: 'context',
      args: '',
      line: '/context',
      mentions: [],
    });
  });

  it('detects /command with args', () => {
    expect(detectCommand('/goal ship it', attached)).toEqual({
      name: 'goal',
      args: 'ship it',
      line: '/goal ship it',
      mentions: [],
    });
  });

  it('strips one leading attached mention', () => {
    expect(detectCommand('@codex /goal ship it', attached)).toEqual({
      name: 'goal',
      args: 'ship it',
      line: '/goal ship it',
      mentions: ['codex'],
    });
  });

  it('strips two leading attached mentions', () => {
    expect(detectCommand('@planner @codex /context', attached)).toEqual({
      name: 'context',
      args: '',
      line: '/context',
      mentions: ['planner', 'codex'],
    });
  });

  it('does not strip an unattached leading @x', () => {
    expect(detectCommand('@unknown /context', attached)).toBeNull();
  });

  it('returns null for / mid-text', () => {
    expect(detectCommand('please run /context', attached)).toBeNull();
  });

  it('accepts names with colons', () => {
    expect(detectCommand('/plugin:command arg', attached)).toEqual({
      name: 'plugin:command',
      args: 'arg',
      line: '/plugin:command arg',
      mentions: [],
    });
  });
});

function evt(kind: ChatEventKind, payload: unknown, seq: number): ChatEvent {
  return {
    seq,
    ts: '2026-09-03T12:00:00.000Z',
    ticketId: 'a1',
    agentId: 'codex',
    sessionKey: 'a1:codex',
    turnId: null,
    kind,
    payload,
  };
}

const cmdUpdate = (name: string) => ({
  sessionUpdate: 'available_commands_update',
  availableCommands: [{ name, description: 'desc', input: null }],
});

const emptyCmdUpdate = () => ({
  sessionUpdate: 'available_commands_update',
  availableCommands: [],
});

describe('latestAdvertisedCommands', () => {
  it('returns the newest update when the marker harness matches', () => {
    const events = [
      evt('session.created', { harness: 'codex', acpSessionId: 's1' }, 1),
      evt('acp.update', cmdUpdate('old'), 2),
      evt('acp.update', cmdUpdate('new'), 3),
    ];
    const result = latestAdvertisedCommands(events, 'codex');
    expect(result?.map((c) => c.name)).toEqual(['new']);
  });

  it('returns the list across a same-harness resume', () => {
    const events = [
      evt('session.created', { harness: 'claude', acpSessionId: 's1' }, 1),
      evt('acp.update', cmdUpdate('plan'), 2),
      evt('session.resumed', { harness: 'claude', acpSessionId: 's1' }, 3),
    ];
    expect(latestAdvertisedCommands(events, 'claude')?.map((c) => c.name)).toEqual(['plan']);
  });

  it('returns null when a newer marker names a different harness', () => {
    const events = [
      evt('session.created', { harness: 'claude', acpSessionId: 's1' }, 1),
      evt('acp.update', cmdUpdate('plan'), 2),
      evt('session.created', { harness: 'codex', acpSessionId: 's2' }, 3),
    ];
    expect(latestAdvertisedCommands(events, 'claude')).toBeNull();
  });

  it('returns null when the current harness marker follows an older harness list', () => {
    const events = [
      evt('session.created', { harness: 'codex', acpSessionId: 's1' }, 1),
      evt('acp.update', cmdUpdate('codex-cmd'), 2),
      evt('session.created', { harness: 'claude', acpSessionId: 's2' }, 3),
      evt('acp.update', emptyCmdUpdate(), 4),
    ];
    expect(latestAdvertisedCommands(events, 'claude')).toBeNull();
  });

  it('skips an empty newest update and returns the older same-harness list', () => {
    const events = [
      evt('session.created', { harness: 'claude', acpSessionId: 's1' }, 1),
      evt('acp.update', cmdUpdate('plan'), 2),
      evt('session.resumed', { harness: 'claude', acpSessionId: 's1' }, 3),
      evt('acp.update', emptyCmdUpdate(), 4),
    ];
    expect(latestAdvertisedCommands(events, 'claude')?.map((c) => c.name)).toEqual(['plan']);
  });

  it('returns null when only empty updates exist for the current harness', () => {
    const events = [
      evt('session.created', { harness: 'claude', acpSessionId: 's1' }, 1),
      evt('acp.update', emptyCmdUpdate(), 2),
      evt('session.resumed', { harness: 'claude', acpSessionId: 's1' }, 3),
    ];
    expect(latestAdvertisedCommands(events, 'claude')).toBeNull();
  });

  it('returns null when the marker lacks a harness field', () => {
    const events = [
      evt('acp.update', cmdUpdate('plan'), 1),
      evt('session.rotated', { acpSessionId: 's1', text: 'rotated' }, 2),
    ];
    expect(latestAdvertisedCommands(events, 'codex')).toBeNull();
  });

  it('returns null when a marker appears before any update', () => {
    const events = [
      evt('session.created', { harness: 'codex', acpSessionId: 's1' }, 1),
      evt('acp.update', cmdUpdate('plan'), 2),
    ];
    expect(latestAdvertisedCommands(events.slice(0, 1), 'codex')).toBeNull();
  });

  it('returns the candidate when no harness marker exists', () => {
    const events = [evt('acp.update', cmdUpdate('plan'), 1)];
    expect(latestAdvertisedCommands(events, 'codex')?.[0]?.name).toBe('plan');
  });
});

describe('commandsEqual', () => {
  const sample: ChatCommand[] = [
    {
      name: 'plan',
      description: 'Turn plan mode on.',
      inputHint: null,
      action: { kind: 'set-config', configId: 'collaboration_mode', value: 'plan' },
    },
  ];

  it('compares lists by value', () => {
    expect(commandsEqual(sample, [...sample])).toBe(true);
    expect(
      commandsEqual(sample, [
        { ...sample[0], action: { kind: 'prompt' } },
      ]),
    ).toBe(false);
  });
});
