import TestRenderer, { act } from 'react-test-renderer';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { DEFAULT_VIEW_PREFS_FILE } from '@shared/view-prefs-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LegacyRedirect } from '../../components/LegacyRedirect';
import { BoardProjectPanel } from '../../components/board/BoardProjectPanel';
import type { ProjectSummary } from '../../data/types';
import type { BoardFilterActions, BoardFilterState } from '../useBoardFilters';
import { useBoardFilters } from '../useBoardFilters';

const viewPrefsMocks = vi.hoisted(() => ({
  saveGlobalViewPrefs: vi.fn(async () => DEFAULT_VIEW_PREFS_FILE),
  saveScopeViewPrefs: vi.fn(async () => DEFAULT_VIEW_PREFS_FILE),
}));

vi.mock('../useViewPrefs', () => ({
  useViewPrefs: () => DEFAULT_VIEW_PREFS_FILE.global,
  fetchViewPrefs: async () => DEFAULT_VIEW_PREFS_FILE,
  saveGlobalViewPrefs: viewPrefsMocks.saveGlobalViewPrefs,
  saveScopeViewPrefs: viewPrefsMocks.saveScopeViewPrefs,
}));

function BoardState() {
  const location = useLocation();
  const navigate = useNavigate();
  const { state, actions } = useBoardFilters();
  return <><output>{`${location.pathname}${location.search}${location.hash}|${state.projectVisibility}|${state.dialog ?? ''}`}</output>
    <button type="button" onClick={() => navigate(-1)}>History back</button>
    <button type="button" onClick={() => navigate(1)}>History forward</button>
    <button onClick={() => actions.setHistory('all')}>All history</button>
    <button type="button" onClick={() => actions.setProjectVisibility('archived')}>Archived visibility</button>
    <button type="button" onClick={() => actions.setDialog('new-ticket')}>Open dialog</button>
    <button type="button" onClick={() => actions.setStatusFilter(['review'])}>Filter review</button></>;
}

function InboxWithLegacyLink() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <output>{`${location.pathname}${location.search}${location.hash}`}</output>
      <button type="button" onClick={() => navigate('/tickets?status=review#x')}>
        Open legacy tickets
      </button>
    </>
  );
}

async function mountRoute(path: string) {
  vi.stubGlobal('window', { location: { search: new URL(path, 'http://local').search } });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/tickets" element={<LegacyRedirect />} />
          <Route path="/projects/:slug" element={<LegacyRedirect />} />
          <Route path="/board" element={<BoardState />} />
        </Routes>
      </MemoryRouter>,
    );
    await Promise.resolve();
  });
  return renderer;
}

afterEach(() => vi.unstubAllGlobals());

describe('Board URL state after legacy navigation', () => {
  it.each([
    ['/tickets?status=review#x', '#x'],
    ['/projects/qa-atlas?tab=archive#keep', '#keep'],
  ])('keeps the hash through redirect and Board preference initialization: %s', async (path, hash) => {
    const renderer = await mountRoute(path);
    expect(renderer.root.findByType('output').children.join('')).toContain(hash);
    await act(async () => renderer.root.findByProps({ children: 'All history' }).props.onClick());
    expect(renderer.root.findByType('output').children.join('')).toContain(hash);
    await act(async () => renderer.unmount());
  });

  it('returns to inbox after legacy redirect when the user goes back', async () => {
    vi.stubGlobal('window', { location: { search: '' } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryRouter initialEntries={['/inbox']}>
          <Routes>
            <Route path="/inbox" element={<InboxWithLegacyLink />} />
            <Route path="/tickets" element={<LegacyRedirect />} />
            <Route path="/board" element={<BoardState />} />
          </Routes>
        </MemoryRouter>,
      );
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root.findByProps({ children: 'Open legacy tickets' }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findByType('output').children.join('')).toContain('/board');
    await act(async () => {
      renderer.root.findByProps({ children: 'History back' }).props.onClick();
      await Promise.resolve();
    });
    expect(renderer.root.findByType('output').children.join('')).toBe('/inbox');
    await act(async () => renderer.unmount());
  });

  it('reads archived visibility from the URL before archived data exists', async () => {
    const renderer = await mountRoute('/board?projectVisibility=archived&panel=projects');
    expect(renderer.root.findByType('output').children.join('')).toContain('|archived');
    await act(async () => renderer.unmount());
  });

  it('keeps archived visibility in hook state after the user changes the facet', async () => {
    const renderer = await mountRoute('/board?panel=projects');
    await act(async () => {
      renderer.root.findByProps({ children: 'Archived visibility' }).props.onClick();
      await Promise.resolve();
    });
    const text = renderer.root.findByType('output').children.join('');
    expect(text).toContain('projectVisibility=archived');
    expect(text).toContain('|archived');
    await act(async () => renderer.unmount());
  });

  it('closes a board dialog on history back and reopens on forward while retaining filters', async () => {
    vi.stubGlobal('window', { location: { search: '' } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryRouter initialEntries={['/inbox', '/board?status=review']}>
          <Routes>
            <Route path="/inbox" element={<output>Inbox</output>} />
            <Route path="/board" element={<BoardState />} />
          </Routes>
        </MemoryRouter>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const out = () => renderer.root.findByType('output').children.join('');
    expect(out()).toContain('status=review');
    expect(out()).not.toContain('dialog=new-ticket');
    await act(async () => {
      renderer.root.findByProps({ children: 'Open dialog' }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(out()).toContain('dialog=new-ticket');
    expect(out()).toContain('status=review');
    await act(async () => {
      renderer.root.findByProps({ children: 'History back' }).props.onClick();
      await Promise.resolve();
    });
    expect(out()).toContain('/board');
    expect(out()).toContain('status=review');
    expect(out()).not.toContain('dialog=new-ticket');
    await act(async () => {
      renderer.root.findByProps({ children: 'History forward' }).props.onClick();
      await Promise.resolve();
    });
    expect(out()).toContain('dialog=new-ticket');
    expect(out()).toContain('status=review');
    await act(async () => renderer.unmount());
  });

  it('does not persist prefs when the user navigates with browser history', async () => {
    vi.stubGlobal('window', { location: { search: '' } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryRouter initialEntries={['/board']}>
          <Routes>
            <Route path="/board" element={<BoardState />} />
          </Routes>
        </MemoryRouter>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const saveCallsBefore =
      viewPrefsMocks.saveGlobalViewPrefs.mock.calls.length
      + viewPrefsMocks.saveScopeViewPrefs.mock.calls.length;
    await act(async () => {
      renderer.root.findByProps({ children: 'Open dialog' }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root.findByProps({ children: 'History back' }).props.onClick();
      await Promise.resolve();
    });
    const saveCallsAfter =
      viewPrefsMocks.saveGlobalViewPrefs.mock.calls.length
      + viewPrefsMocks.saveScopeViewPrefs.mock.calls.length;
    expect(saveCallsAfter).toBe(saveCallsBefore);
    await act(async () => renderer.unmount());
  });

  it('shows the archived control state and empty archive while the active feed has projects', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(
      <MemoryRouter>
        <BoardProjectPanel
          state={{ panel: 'projects', project: [], projectVisibility: 'archived' } as unknown as BoardFilterState}
          actions={{ setDialog: () => {} } as unknown as BoardFilterActions}
          projects={[{ slug: 'active-only', title: 'Active only' } as ProjectSummary]}
          archived={[]}
          projectDetail={undefined}
          projectsLoading={false}
          archivedLoading={false}
          projectLoading={false}
          projectsError={null}
          onRefreshProjects={() => {}}
          onRefreshArchived={() => {}}
          onRefreshProject={() => {}}
          showToast={() => {}}
        />
      </MemoryRouter>,
    ); });
    expect(renderer.root.findByType('select').props.value).toBe('archived');
    const visibleText = JSON.stringify(renderer.toJSON());
    expect(visibleText).toContain('No projects');
    expect(visibleText).not.toContain('Active only');
    await act(async () => renderer.unmount());
  });
});
