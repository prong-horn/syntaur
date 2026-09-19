import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ResourceProvider } from '../../data/useResource';
import { ResourceStore } from '../../data/cache';
import { createApiClient } from '../../data/client';
import { BoardPage } from '../BoardPage';

describe('BoardPage SSR', () => {
  it('renders loading shell without fetching', () => {
    const store = new ResourceStore({
      client: createApiClient(() => Promise.reject(new Error('no fetch in SSR'))),
      source: null,
    });
    const html = renderToString(
      <ResourceProvider store={store}>
        <MemoryRouter initialEntries={['/board']}>
          <BoardPage />
        </MemoryRouter>
      </ResourceProvider>,
    );
    expect(html).toContain('Loading board');
    store.dispose();
  });
});
