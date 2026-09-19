import { StrictMode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeAll, describe, expect, it } from 'vitest';
import { ResourceProvider } from '../../../data/useResource';
import { createApiClient } from '../../../data/client';
import { ResourceStore } from '../../../data/cache';
import { createFakeFetch, flush } from '../../../data/__tests__/fakeFetch';
import { JournalTab } from '../JournalTab';
import type { TicketTemplateFileDetail } from '../../../hooks/useProjects';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const file: TicketTemplateFileDetail = {
  path: 'journal.md',
  role: 'log',
  writer: 'cli',
  description: 'Append-only log',
  state: '0 entries',
  exists: true,
  createOn: 'ticket-creation',
  body: null,
  entryTypes: ['progress', 'note'],
  logEntries: [],
};

describe('JournalTab mounted append', () => {
  it('appends through mutate and refetches the log resource', async () => {
    const fake = createFakeFetch();
    const store = new ResourceStore({ client: createApiClient(fake.fetchImpl), source: null, isVisible: () => true });
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <StrictMode>
          <ResourceProvider store={store}>
            <JournalTab ticketId="T-1" file={file} />
          </ResourceProvider>
        </StrictMode>,
      );
    });

    await act(async () => {
      await flush();
    });
    const initial = fake.callsTo('/api/tickets/T-1/log');
    expect(initial).toHaveLength(1);
    await act(async () => {
      initial[0]!.respond({ path: 'journal.md', entries: [] });
      await flush();
    });

    const textarea = renderer.root.findByType('textarea');
    await act(async () => {
      textarea.props.onChange({ target: { value: 'Shipped fix' } });
    });
    const form = renderer.root.findByType('form');
    const submit = renderer.root.find(
      (node) => node.type === 'button' && node.props.type === 'submit',
    );
    expect(submit).toBeDefined();
    await act(async () => {
      form.props.onSubmit({ preventDefault: () => {} });
      await flush();
    });

    const post = fake.callsTo('/api/tickets/T-1/log').find((c) => c.init?.method === 'POST');
    expect(post).toBeDefined();
    await act(async () => {
      post!.respond({ path: 'journal.md', entries: [{ timestamp: 't', type: 'progress', author: 'human', firstLine: 'Shipped fix', body: 'Shipped fix' }] });
      await flush();
    });

    const reload = fake.callsTo('/api/tickets/T-1/log').filter((c) => c.init?.method !== 'POST');
    expect(reload.length).toBeGreaterThanOrEqual(2);
    renderer.unmount();
  });
});
