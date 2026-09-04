import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentTestResultLine } from '../AgentTestResultLine';

describe('AgentTestResultLine', () => {
  it('renders failed test errors and profile errors inline', () => {
    const markup = renderToStaticMarkup(
      <AgentTestResultLine
        testResult={{
          ok: false,
          reply: null,
          stopReason: null,
          model: null,
          mode: null,
          effort: null,
          durationMs: 120,
          error: 'initialize failed',
          profileErrors: ['model: bad value'],
        }}
      />,
    );
    expect(markup).toContain('initialize failed');
  });

  it('renders a successful test summary', () => {
    const markup = renderToStaticMarkup(
      <AgentTestResultLine
        testResult={{
          ok: true,
          reply: 'OK',
          stopReason: 'end_turn',
          model: 'claude-opus-5',
          mode: 'plan',
          effort: null,
          durationMs: 2100,
          error: null,
          profileErrors: [],
        }}
      />,
    );
    expect(markup).toContain('OK in 2.1 s');
    expect(markup).toContain('model claude-opus-5');
  });
});
