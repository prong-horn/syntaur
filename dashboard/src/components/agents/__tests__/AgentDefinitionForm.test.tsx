import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router';
import { AgentDefinitionForm } from '../AgentDefinitionForm';
import { BASE_SYSTEM_PROMPT, draftFromDefinition, emptyDraft } from '../../../lib/agent-editor';
import type { AgentDefinition, ChatHarnessSummary } from '../../../lib/chat-types';

const claudeHarness: ChatHarnessSummary = {
  id: 'claude',
  label: 'Claude',
  command: 'claude-agent-acp',
  args: [],
  installed: '/usr/local/bin/claude-agent-acp',
  installHint: 'npm i -g @agentclientprotocol/claude-agent-acp',
  modelConfigId: 'model',
  effortConfigId: 'effort',
  roleModes: { edits: 'acceptEdits', ask: 'default', plan: 'plan', bypass: 'bypassPermissions' },
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
        choices: [{ value: 'claude-sonnet-4', name: 'Sonnet 4', description: null }],
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
  auth: { state: 'ok', detail: null, at: null },
};

const cursorHarness: ChatHarnessSummary = {
  ...claudeHarness,
  id: 'cursor',
  label: 'Cursor',
  command: 'cursor-agent',
  effortConfigId: null,
  options: {
    ...claudeHarness.options!,
    harness: 'cursor',
    options: claudeHarness.options!.options.filter((o) => o.id === 'model'),
  },
};

const definition: AgentDefinition = {
  id: 'planner',
  name: 'Planner',
  color: 'slate',
  harness: 'claude',
  model: 'secret-model',
  mode: 'plan',
  effort: 'high',
  respondsTo: 'mentions',
  default: false,
  systemPrompt: BASE_SYSTEM_PROMPT,
  promptIsDefault: true,
  source: '/tmp/planner.md',
};

describe('AgentDefinitionForm', () => {
  it('hides effort for cursor and shows custom model input when needed', () => {
    const cursorDraft = { ...draftFromDefinition(definition), harness: 'cursor' as const, modelCustom: true };
    const cursorMarkup = renderToStaticMarkup(
      <StaticRouter location="/agents/planner/edit">
        <AgentDefinitionForm
          draft={cursorDraft}
          errors={{}}
          harnesses={[cursorHarness]}
          mode="edit"
          refreshing={false}
          onChange={() => undefined}
          onRefresh={() => undefined}
          onSave={() => undefined}
          dirty={false}
          saving={false}
        />
      </StaticRouter>,
    );
    expect(cursorMarkup).toContain('cursor folds effort into the model value');
    expect(cursorMarkup).not.toContain('>Custom…<');
    expect(cursorMarkup).not.toMatch(/<select[^>]*>[\s\S]*High[\s\S]*<\/select>/);

    const customMarkup = renderToStaticMarkup(
      <StaticRouter location="/agents/planner/edit">
        <AgentDefinitionForm
          draft={{ ...draftFromDefinition(definition), modelCustom: true }}
          errors={{}}
          harnesses={[claudeHarness]}
          mode="edit"
          refreshing={false}
          onChange={() => undefined}
          onRefresh={() => undefined}
          onSave={() => undefined}
          dirty={false}
          saving={false}
        />
      </StaticRouter>,
    );
    expect(customMarkup).toContain('value="secret-model"');
  });

  it('locks the id on edit, shows default prompt placeholder, and disables Test while dirty', () => {
    const draft = draftFromDefinition(definition);
    const markup = renderToStaticMarkup(
      <StaticRouter location="/agents/planner/edit">
        <AgentDefinitionForm
          draft={draft}
          errors={{}}
          harnesses={[claudeHarness]}
          mode="edit"
          refreshing={false}
          onChange={() => undefined}
          onRefresh={() => undefined}
          onSave={() => undefined}
          onTest={() => undefined}
          dirty
          saving={false}
        />
      </StaticRouter>,
    );
    expect(markup).toContain('id="agent-id"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain(`placeholder="${BASE_SYSTEM_PROMPT.split('\n')[0]}`);
    expect(markup).toContain('Save to test');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('>Test<');
  });

  it('allows editing the id on create', () => {
    const markup = renderToStaticMarkup(
      <StaticRouter location="/agents/new">
        <AgentDefinitionForm
          draft={emptyDraft()}
          errors={{}}
          harnesses={[claudeHarness]}
          mode="create"
          refreshing={false}
          onChange={() => undefined}
          onRefresh={() => undefined}
          onSave={() => undefined}
          dirty={false}
          saving={false}
        />
      </StaticRouter>,
    );
    expect(markup).not.toMatch(/id="agent-id"[\s\S]*disabled=""/);
  });
});
