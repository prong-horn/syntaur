import { describe, it, expect } from 'vitest';
import {
  commandsEqual,
  detectCommand,
  parseAvailableCommands,
  type ChatCommand,
} from '../chat/commands.js';

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
  name: 'plan-assignment',
  description: 'Create a detailed implementation plan for the current assignment.',
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
        name: 'plan-assignment',
        description: 'Create a detailed implementation plan for the current assignment.',
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
