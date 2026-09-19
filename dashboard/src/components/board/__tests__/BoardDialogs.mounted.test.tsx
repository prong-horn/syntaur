// @vitest-environment happy-dom

import { StrictMode, useState } from 'react';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { BoardDialogs } from '../BoardDialogs';
import { ResourceProvider } from '../../../data/useResource';
import { createApiClient } from '../../../data/client';
import { ResourceStore, __resetDefaultResourceStoreForTests } from '../../../data/cache';
import { createFakeFetch, flush } from '../../../data/__tests__/fakeFetch';
import type { BoardFilterActions, BoardFilterState } from '../../../hooks/useBoardFilters';
import { bodyText, createDomTestRoot } from './domTestRoot';
import { minimalBoardState, stubBoardFilterActions } from './boardDialogTestHelpers';

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

function Harness({
  state: initialState,
  actions,
  onDialogChange,
}: {
  state: BoardFilterState;
  actions: BoardFilterActions;
  onDialogChange?: (dialog: BoardFilterState['dialog']) => void;
}) {
  const [state, setState] = useState(initialState);
  const mergedActions: BoardFilterActions = {
    ...actions,
    setDialog: (dialog) => {
      actions.setDialog(dialog);
      onDialogChange?.(dialog);
      setState((s) => ({ ...s, dialog }));
    },
  };
  return (
    <MemoryRouter>
      <BoardDialogs state={state} actions={mergedActions} showToast={() => {}} />
    </MemoryRouter>
  );
}

describe('BoardDialogs new-ticket template load', () => {
  it('shows error and Retry after failed template GET, then loads the create form', async () => {
    const fake = createFakeFetch();
    const store = makeStore(fake);
    const actions = stubBoardFilterActions();
    const dom = createDomTestRoot();

    await dom.render(
      <StrictMode>
        <ResourceProvider store={store}>
          <Harness state={minimalBoardState()} actions={actions} />
        </ResourceProvider>
      </StrictMode>,
    );

    await flush();
    await flush();
    fake.callsTo('/api/projects')[0]?.respond([]);
    await flush();

    const templateCalls = fake.callsTo('/api/templates/ticket');
    expect(templateCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of templateCalls) {
      if (!call.settled) call.respondRaw('{"error":"template offline"}', 503);
    }
    await flush();

    expect(bodyText()).toContain('Something went wrong');
    expect(bodyText()).not.toContain('Loading ticket template');

    const retry = document.querySelector('button.shell-action');
    expect(retry).not.toBeNull();
    await act(async () => {
      retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });

    const retryCalls = fake.callsTo('/api/templates/ticket');
    expect(retryCalls.length).toBeGreaterThanOrEqual(2);
    retryCalls[retryCalls.length - 1]!.respond({
      content: '---\ntitle: Demo ticket\n---\n\nBody',
    });
    await flush();

    expect(bodyText()).toContain('Select project');
    expect(document.querySelector('textarea')).not.toBeNull();
    dom.unmount();
  });
});

const TICKET_TEMPLATE = '---\ntitle: Draft ticket\n---\n\nBody';
const PROJECT_TEMPLATE = '---\ntitle: New project\nslug: new-proj\n---\n\nOverview';
const DRAFT_MARKER = 'SV12-MOUNTED-DRAFT-RETURN';

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function ticketTitleInput(): HTMLInputElement {
  const input = document.querySelector('[role="dialog"] input.editor-input');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`ticket title input not found (${bodyText().slice(0, 120)})`);
  }
  return input;
}

async function clickDialogButton(label: 'Back' | 'Close') {
  const button =
    label === 'Close'
      ? document.querySelector('[role="dialog"] [aria-label="Close dialog"]')
      : document.querySelector('[role="dialog"] button.shell-action');
  if (!(button instanceof HTMLElement)) throw new Error(`dialog button not found: ${label}`);
  await act(async () => {
    button.click();
    await flush();
  });
}

async function settleBoardDialogFetches(fake: ReturnType<typeof createFakeFetch>) {
  await flush();
  await flush();
  fake.callsTo('/api/projects')[0]?.respond([]);
  await flush();
  for (let i = 0; i < 40 && fake.callsTo('/api/templates/ticket').length === 0; i += 1) {
    await flush();
  }
  for (const call of fake.callsTo('/api/ticket-templates')) {
    if (!call.settled) call.respond({ templates: [{ id: 'feature', description: 'Full development cycle' }] });
  }
  for (const call of fake.callsTo('/api/templates/ticket')) {
    if (!call.settled) call.respond({ content: TICKET_TEMPLATE });
  }
  for (const call of fake.callsTo('/api/templates/project')) {
    if (!call.settled) call.respond({ content: PROJECT_TEMPLATE });
  }
  await flush();
  await flush();
}

async function bootstrapNewTicketForm(
  fake: ReturnType<typeof createFakeFetch>,
  store: ResourceStore,
  dom: ReturnType<typeof createDomTestRoot>,
  actions: ReturnType<typeof stubBoardFilterActions>,
) {
  await dom.render(
    <StrictMode>
      <ResourceProvider store={store}>
        <Harness state={minimalBoardState()} actions={actions} />
      </ResourceProvider>
    </StrictMode>,
  );
  await settleBoardDialogFetches(fake);
}

describe('BoardDialogs new-ticket ↔ new-project draft return', () => {
  it('returns from new-project Back with unsaved ticket title/body (no active projects)', async () => {
    const fake = createFakeFetch();
    const store = makeStore(fake);
    const actions = stubBoardFilterActions();
    const dom = createDomTestRoot();
    await bootstrapNewTicketForm(fake, store, dom, actions);

    const titleInput = ticketTitleInput();
    await act(async () => {
      setInputValue(titleInput, DRAFT_MARKER);
      await flush();
    });

    const createFirst = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Create a project first'),
    );
    expect(createFirst).toBeDefined();
    await act(async () => {
      createFirst!.click();
      await flush();
    });

    await settleBoardDialogFetches(fake);
    expect(bodyText()).toContain('Create Project');

    await clickDialogButton('Back');
    await settleBoardDialogFetches(fake);

    expect(bodyText()).toContain('Create Ticket');
    expect(ticketTitleInput().value).toBe(DRAFT_MARKER);
    dom.unmount();
  });

  it('clears lifted draft after closing new-ticket (no cross-open leakage)', async () => {
    const fake = createFakeFetch();
    const store = makeStore(fake);
    const actions = stubBoardFilterActions();
    let latestDialog: BoardFilterState['dialog'] = 'new-ticket';
    const dom = createDomTestRoot();
    await dom.render(
      <StrictMode>
        <ResourceProvider store={store}>
          <Harness
            state={minimalBoardState()}
            actions={actions}
            onDialogChange={(dialog) => {
              latestDialog = dialog;
            }}
          />
        </ResourceProvider>
      </StrictMode>,
    );
    await settleBoardDialogFetches(fake);

    await act(async () => {
      setInputValue(ticketTitleInput(), `${DRAFT_MARKER}-LEAK`);
      await flush();
    });

    await clickDialogButton('Close');
    expect(latestDialog).toBeNull();
    expect(actions.setDialog).toHaveBeenCalledWith(null);

    dom.unmount();
    const actions2 = stubBoardFilterActions();
    const dom2 = createDomTestRoot();
    await bootstrapNewTicketForm(fake, store, dom2, actions2);
    expect(ticketTitleInput().value).not.toContain(`${DRAFT_MARKER}-LEAK`);
    dom2.unmount();
  });

  it('standalone new-project Back closes the board dialog', async () => {
    const fake = createFakeFetch();
    const store = makeStore(fake);
    const actions = stubBoardFilterActions();
    let latestDialog: BoardFilterState['dialog'] = 'new-project';
    const dom = createDomTestRoot();

    await dom.render(
      <StrictMode>
        <ResourceProvider store={store}>
          <Harness
            state={minimalBoardState({ dialog: 'new-project' })}
            actions={actions}
            onDialogChange={(dialog) => {
              latestDialog = dialog;
            }}
          />
        </ResourceProvider>
      </StrictMode>,
    );
    await settleBoardDialogFetches(fake);

    await clickDialogButton('Back');
    expect(latestDialog).toBeNull();
    expect(actions.setDialog).toHaveBeenCalledWith(null);
    dom.unmount();
  });
});
