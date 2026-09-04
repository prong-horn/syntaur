import { describe, expect, it } from 'vitest';
import {
  agentBadges,
  applyHarnessToDraft,
  BASE_SYSTEM_PROMPT,
  draftFromDefinition,
  emptyDraft,
  inputFromDraft,
  modeChoices,
  pickerChoices,
  staleNote,
  validateDraft,
  type AgentDraft,
} from '../agent-editor';
import type { AgentDefinition, ChatAgentSummary, ChatHarnessSummary, ChatSessionSummary } from '../chat-types';

function claudeHarness(overrides: Partial<ChatHarnessSummary> = {}): ChatHarnessSummary {
  return {
    id: 'claude',
    label: 'Claude',
    command: 'claude-agent-acp',
    args: [],
    installed: '/usr/local/bin/claude-agent-acp',
    installHint: 'npm i -g @agentclientprotocol/claude-agent-acp',
    modelConfigId: 'model',
    effortConfigId: 'effort',
    roleModes: { edits: 'acceptEdits', ask: 'default', plan: 'plan' },
    systemPromptTransport: 'meta',
    options: {
      harness: 'claude',
      adapterVersion: '1.0.0',
      capturedAt: '2026-09-04T00:00:00.000Z',
      options: [
        {
          id: 'model',
          name: 'Model',
          category: null,
          currentValue: 'claude-sonnet-4',
          choices: [
            { value: 'claude-sonnet-4', name: 'Sonnet 4', description: null },
            { value: 'claude-opus-4', name: 'Opus 4', description: null },
          ],
        },
        {
          id: 'effort',
          name: 'Effort',
          category: null,
          currentValue: 'high',
          choices: [{ value: 'high', name: 'High', description: null }],
        },
      ],
      modes: null,
    },
    auth: { state: 'ok', detail: null, at: '2026-09-04T00:00:00.000Z' },
    ...overrides,
  };
}

function cursorHarness(overrides: Partial<ChatHarnessSummary> = {}): ChatHarnessSummary {
  return {
    id: 'cursor',
    label: 'Cursor',
    command: 'cursor-agent',
    args: ['acp'],
    installed: '/usr/local/bin/cursor-agent',
    installHint: 'curl https://cursor.com/install -fsS | bash',
    modelConfigId: 'model',
    effortConfigId: null,
    roleModes: { edits: 'agent', ask: 'ask', plan: 'plan' },
    systemPromptTransport: 'prompt',
    options: {
      harness: 'cursor',
      adapterVersion: '1.0.0',
      capturedAt: '2026-09-04T00:00:00.000Z',
      options: [
        {
          id: 'model',
          name: 'Model',
          category: null,
          currentValue: 'gpt-5',
          choices: [{ value: 'gpt-5', name: 'GPT-5', description: null }],
        },
      ],
      modes: null,
    },
    auth: { state: 'ok', detail: null, at: null },
    ...overrides,
  };
}

const fullDefinition: AgentDefinition = {
  id: 'planner',
  name: 'Planner',
  color: 'violet',
  harness: 'claude',
  model: 'claude-opus-4',
  mode: 'plan',
  effort: 'high',
  mcpServers: ['syntaur'],
  env: { FOO: 'bar' },
  respondsTo: 'mentions',
  default: true,
  description: 'Plans work',
  avatar: '📋',
  systemPrompt: 'Custom prompt',
  promptIsDefault: false,
  source: '/home/.syntaur/agents/planner.md',
};

describe('draft ↔ input round trip', () => {
  it('preserves every field through draftFromDefinition and inputFromDraft', () => {
    const draft = draftFromDefinition(fullDefinition);
    const input = inputFromDraft(draft);
    expect(input).toEqual({
      id: 'planner',
      name: 'Planner',
      color: 'violet',
      harness: 'claude',
      model: 'claude-opus-4',
      mode: 'plan',
      effort: 'high',
      mcpServers: ['syntaur'],
      env: { FOO: 'bar' },
      respondsTo: 'mentions',
      default: true,
      description: 'Plans work',
      avatar: '📋',
      systemPrompt: 'Custom prompt',
    });
  });

  it('uses an empty systemPrompt when promptIsDefault', () => {
    const draft = draftFromDefinition({
      ...fullDefinition,
      systemPrompt: BASE_SYSTEM_PROMPT,
      promptIsDefault: true,
    });
    expect(draft.systemPrompt).toBe('');
    expect(inputFromDraft(draft).systemPrompt).toBe('');
  });
});

describe('validateDraft', () => {
  it('requires a slug id and name', () => {
    const draft = emptyDraft();
    const emptyErrors = validateDraft(draft);
    expect(emptyErrors.id).toMatch(/required/i);
    expect(emptyErrors.name).toMatch(/required/i);

    const badSlug: AgentDraft = { ...emptyDraft(), id: 'My Agent', name: 'Planner' };
    expect(validateDraft(badSlug).id).toMatch(/slug/i);
  });

  it('rejects invalid env lines', () => {
    const draft: AgentDraft = {
      ...emptyDraft(),
      id: 'planner',
      name: 'Planner',
      envText: 'NOTVALID',
    };
    expect(validateDraft(draft).envText).toMatch(/KEY=value/);
  });

  it('rejects avatars with whitespace or too many code points', () => {
    const tooLong: AgentDraft = {
      ...emptyDraft(),
      id: 'planner',
      name: 'Planner',
      avatar: 'abcde',
    };
    expect(validateDraft(tooLong).avatar).toMatch(/4 characters/);

    const spaced: AgentDraft = {
      ...tooLong,
      avatar: 'a b',
    };
    expect(validateDraft(spaced).avatar).toMatch(/whitespace/);
  });
});

describe('pickerChoices', () => {
  it('marks a saved model custom when it is not advertised', () => {
    const result = pickerChoices('model', claudeHarness(), 'unknown-model');
    expect(result.custom).toBe(true);
    expect(result.choices.length).toBeGreaterThan(0);
  });

  it('hides effort for cursor with the cursor note', () => {
    const result = pickerChoices('effort', cursorHarness(), null);
    expect(result.hidden).toBe(true);
    expect(result.reason).toMatch(/cursor folds effort/);
  });

  it('explains missing cache and install state', () => {
    expect(pickerChoices('model', null, null).reason).toBe('not fetched yet');
    expect(
      pickerChoices('model', claudeHarness({ installed: null, options: null }), null).reason,
    ).toBe('adapter not installed');
    expect(
      pickerChoices(
        'model',
        claudeHarness({
          options: null,
          auth: { state: 'failed', detail: 'auth failed', at: null },
        }),
        null,
      ).reason,
    ).toBe('auth failed');
  });
});

describe('modeChoices and badges', () => {
  it('labels role modes from the harness catalog', () => {
    const choices = modeChoices(claudeHarness());
    expect(choices.find((c) => c.value === 'edits')?.label).toBe('edits (acceptEdits)');
  });

  it('badges builtin, file, and override summaries', () => {
    const builtin: ChatAgentSummary = {
      id: 'claude',
      name: 'Claude',
      color: 'violet',
      harness: 'claude',
      model: null,
      mode: null,
      effort: null,
      respondsTo: 'mentions',
      description: null,
      avatar: 'C',
      default: true,
      source: null,
      builtin: true,
      overridesBuiltin: false,
      missing: null,
    };
    expect(agentBadges(builtin)).toEqual(['built in', 'default', 'claude']);

    const file: ChatAgentSummary = { ...builtin, id: 'planner', source: '/tmp/planner.md', builtin: false, default: false };
    expect(agentBadges(file)[0]).toBe('file');

    const override: ChatAgentSummary = { ...builtin, overridesBuiltin: true, source: '/tmp/claude.md' };
    expect(agentBadges(override)[0]).toBe('overrides built-in');
  });
});

describe('staleNote', () => {
  it('returns the thin-row text when staleDefinition is set', () => {
    const session: ChatSessionSummary = {
      assignmentId: 'a1',
      agentId: 'planner',
      harness: 'claude',
      acpSessionId: 's1',
      adapterVersion: null,
      state: 'idle',
      model: 'claude-sonnet-4',
      mode: 'plan',
      effort: null,
      lastTurnAt: null,
      cumulative: null,
      queued: [],
      lastDeliveredSeq: 0,
      commands: [],
      commandsSource: null,
      staleDefinition: true,
    };
    expect(staleNote(session)).toBe(
      "@planner's definition changed — this session keeps model claude-sonnet-4 and mode plan until it is re-attached.",
    );
    expect(staleNote({ ...session, staleDefinition: false })).toBeNull();
  });
});

describe('applyHarnessToDraft', () => {
  it('starts custom model mode when the saved value is not advertised', () => {
    const draft: AgentDraft = {
      ...draftFromDefinition({ ...fullDefinition, model: 'secret-model' }),
      modelCustom: false,
    };
    const next = applyHarnessToDraft(draft, claudeHarness());
    expect(next.modelCustom).toBe(true);
  });
});
