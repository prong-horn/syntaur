import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationHotkeys } from '../NavigationHotkeys';

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigateMock }));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  navigateMock.mockReset();
});

describe('NavigationHotkeys mounted modal guard', () => {
  it('blocks navigation chords from dialog buttons and resumes after close', async () => {
    const listeners = new Map<string, (event: KeyboardEvent) => void>();
    let dialogOpen = true;
    const fakeWindow = {
      addEventListener: (type: string, listener: (event: KeyboardEvent) => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
      setTimeout,
      clearTimeout,
    };
    const fakeDocument = {
      querySelector: () => (dialogOpen ? {} : null),
    };
    (globalThis as unknown as { window: typeof fakeWindow; document: typeof fakeDocument; HTMLElement: typeof HTMLElement }).window = fakeWindow;
    (globalThis as unknown as { document: typeof fakeDocument }).document = fakeDocument;
    (globalThis as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement = class HTMLElement {} as typeof HTMLElement;

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <NavigationHotkeys />,
      );
    });
    expect(listeners.has('keydown')).toBe(true);

    const button = new (globalThis.HTMLElement as typeof HTMLElement)() as HTMLElement & {
      tagName: string;
      isContentEditable: boolean;
      closest: () => null;
    };
    button.tagName = 'BUTTON';
    button.isContentEditable = false;
    button.closest = () => null;
    const event = (key: string, target: EventTarget | null) => ({
      key,
      target,
      repeat: false,
      isComposing: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault: () => undefined,
    }) as unknown as KeyboardEvent;

    await act(async () => listeners.get('keydown')?.(event('n', button)));
    expect(navigateMock).not.toHaveBeenCalled();

    dialogOpen = false;
    // The listener is mounted once; the fake document is read at keydown time.
    expect(listeners.has('keydown')).toBe(true);
    await act(async () => listeners.get('keydown')?.(event('g', null)));
    await act(async () => listeners.get('keydown')?.(event('b', null)));
    expect(navigateMock).toHaveBeenCalledWith('/board');
    renderer.unmount();
  });
});
