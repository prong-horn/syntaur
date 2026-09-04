import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router';
import { AgentListRow } from '../AgentListRow';
import type { ChatAgentSummary } from '../../../lib/chat-types';

const builtin: ChatAgentSummary = {
  id: 'claude',
  name: 'Claude',
  color: 'violet',
  harness: 'claude',
  model: 'claude-sonnet-4',
  mode: 'default',
  effort: 'high',
  respondsTo: 'mentions',
  description: 'General agent',
  avatar: 'C',
  default: true,
  source: null,
  builtin: true,
  overridesBuiltin: false,
  missing: null,
};

const override: ChatAgentSummary = {
  ...builtin,
  overridesBuiltin: true,
  source: '/home/.syntaur/agents/claude.md',
};

const missing: ChatAgentSummary = {
  ...builtin,
  id: 'codex',
  name: 'Codex',
  harness: 'codex',
  missing: 'npm i -g @agentclientprotocol/codex-acp',
  builtin: true,
};

describe('AgentListRow', () => {
  it('renders builtin and override badges and install warning', () => {
    const builtinMarkup = renderToStaticMarkup(
      <StaticRouter location="/agents">
        <AgentListRow
          agent={builtin}
          testResult={null}
          onEdit={() => undefined}
          onTest={() => undefined}
          onDelete={() => undefined}
        />
      </StaticRouter>,
    );
    expect(builtinMarkup).toContain('built in');
    expect(builtinMarkup).toContain('disabled=""');

    const overrideMarkup = renderToStaticMarkup(
      <StaticRouter location="/agents">
        <AgentListRow
          agent={override}
          testResult={null}
          onEdit={() => undefined}
          onTest={() => undefined}
          onDelete={() => undefined}
        />
      </StaticRouter>,
    );
    expect(overrideMarkup).toContain('overrides built-in');

    const missingMarkup = renderToStaticMarkup(
      <StaticRouter location="/agents">
        <AgentListRow
          agent={missing}
          testResult={null}
          onEdit={() => undefined}
          onTest={() => undefined}
          onDelete={() => undefined}
        />
      </StaticRouter>,
    );
    expect(missingMarkup).toContain('not on PATH');
    expect(missingMarkup).toContain('npm i -g @agentclientprotocol/codex-acp');
  });
});
