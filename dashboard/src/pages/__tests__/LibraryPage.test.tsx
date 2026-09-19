import { MemoryRouter } from 'react-router-dom';
import { renderToString } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApiClient } from '../../data/client';
import { ResourceStore, __resetDefaultResourceStoreForTests } from '../../data/cache';
import { ResourceProvider } from '../../data/useResource';
import { LibraryPage } from '../LibraryPage';
import { createFakeFetch, flush } from '../../data/__tests__/fakeFetch';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  __resetDefaultResourceStoreForTests();
});

function makeStore() {
  const fake = createFakeFetch();
  const store = new ResourceStore({
    client: createApiClient(fake.fetchImpl),
    source: null,
    isVisible: () => true,
  });
  return { fake, store };
}

describe('LibraryPage', () => {
  it('SSR renders templates list shell without fetch', () => {
    const { store } = makeStore();
    const html = renderToString(
      <ResourceProvider store={store}>
        <MemoryRouter initialEntries={['/library/templates']}>
          <LibraryPage />
        </MemoryRouter>
      </ResourceProvider>,
    );
    expect(html).toContain('Library');
    expect(html).toContain('Templates');
  });

  it('template detail shows read-only summary from list lookup', async () => {
    const { fake, store } = makeStore();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ResourceProvider store={store}>
          <MemoryRouter initialEntries={['/library/templates/feature']}>
            <LibraryPage />
          </MemoryRouter>
        </ResourceProvider>,
      );
    });
    const call = fake.last('/api/ticket-templates');
    await act(async () => {
      call.respond({
        templates: [
          {
            id: 'feature',
            description: 'Full dev cycle',
            whenToUse: 'New features',
            stageIds: ['plan', 'build'],
            filePaths: ['plan.md'],
          },
        ],
      });
      await flush();
    });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('feature');
    expect(text).toContain('Full dev cycle');
    expect(text).toContain('plan');
  });

  it('template detail shows not-found for unknown id', async () => {
    const { fake, store } = makeStore();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ResourceProvider store={store}>
          <MemoryRouter initialEntries={['/library/templates/missing']}>
            <LibraryPage />
          </MemoryRouter>
        </ResourceProvider>,
      );
    });
    await act(async () => {
      fake.last('/api/ticket-templates').respond({ templates: [{ id: 'feature', description: 'x' }] });
      await flush();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('not found');
  });
});
