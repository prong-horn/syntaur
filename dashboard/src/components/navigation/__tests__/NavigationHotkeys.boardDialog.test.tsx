// @vitest-environment happy-dom

import { useMemo, useRef, useState } from 'react';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { BoardDialogs } from '../../board/BoardDialogs';
import { NavigationHotkeys } from '../NavigationHotkeys';
import { ResourceProvider } from '../../../data/useResource';
import { createApiClient } from '../../../data/client';
import { ResourceStore, __resetDefaultResourceStoreForTests } from '../../../data/cache';
import { createFakeFetch, flush } from '../../../data/__tests__/fakeFetch';
import type { BoardFilterActions, BoardFilterState } from '../../../hooks/useBoardFilters';
import { createDomTestRoot } from '../../board/__tests__/domTestRoot';
import { minimalBoardState, stubBoardFilterActions } from '../../board/__tests__/boardDialogTestHelpers';

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  navigateMock.mockReset();
  __resetDefaultResourceStoreForTests();
});

function makeStore(fake: ReturnType<typeof createFakeFetch>) {
  return new ResourceStore({
    client: createApiClient(fake.fetchImpl),
    source: null,
    isVisible: () => true,
  });
}

function keydown(key: string, target: EventTarget | null = document.body) {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, 'target', { value: target });
  window.dispatchEvent(event);
}

function BoardWithHotkeys() {
  const [state, setState] = useState<BoardFilterState>(() => minimalBoardState({ dialog: null }));
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const actions = useMemo((): BoardFilterActions => {
    const base = stubBoardFilterActions();
    return {
      ...base,
      setDialog: (dialog) => {
        base.setDialog(dialog);
        setState((s) => ({ ...s, dialog }));
      },
    };
  }, []);

  return (
    <>
      <button
        type="button"
        id="board-opener"
        onClick={(event) => {
          restoreFocusRef.current = event.currentTarget;
          actions.setDialog('new-ticket');
        }}
      >
        Board opener
      </button>
      <NavigationHotkeys />
      <BoardDialogs
        state={state}
        actions={actions}
        restoreFocusRef={restoreFocusRef}
        showToast={() => {}}
      />
    </>
  );
}

describe('NavigationHotkeys with mounted Board dialog', () => {
  it('blocks n and g b from the close control, then resumes navigation and focus after close', async () => {
    const fake = createFakeFetch();
    const store = makeStore(fake);
    const dom = createDomTestRoot();
    const opener = () => document.getElementById('board-opener') as HTMLButtonElement;

    await dom.render(
      <MemoryRouter>
        <ResourceProvider store={store}>
          <BoardWithHotkeys />
        </ResourceProvider>
      </MemoryRouter>,
    );

    await flush();
    await act(async () => {
      opener().focus();
    });
    expect(document.activeElement).toBe(opener());

    await act(async () => {
      opener().click();
      await flush();
    });

    await flush();
    fake.callsTo('/api/projects')[0]?.respond([]);
    await flush();
    const template = fake.callsTo('/api/templates/ticket')[0];
    template?.respond({ content: '---\ntitle: Demo\n---\n\nBody' });
    await flush();

    const close = document.querySelector('[aria-label="Close dialog"]') as HTMLButtonElement;
    expect(close).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      close.focus();
    });
    expect(document.activeElement).toBe(close);

    keydown('n', close);
    keydown('g', close);
    keydown('b', close);
    expect(navigateMock).not.toHaveBeenCalled();

    const focusSpy = vi.spyOn(opener(), 'focus');
    await act(async () => {
      close.click();
      await flush();
    });

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(focusSpy).toHaveBeenCalled();
    focusSpy.mockRestore();
    await act(async () => {
      opener().focus();
    });

    keydown('g', opener());
    keydown('b', opener());
    expect(navigateMock).toHaveBeenCalledWith('/board');

    navigateMock.mockReset();
    keydown('n', opener());
    expect(navigateMock).toHaveBeenCalledWith('/board?dialog=new-ticket');

    dom.unmount();
  });
});
