// @vitest-environment happy-dom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

export interface DomTestRoot {
  container: HTMLDivElement;
  render: (element: ReactElement) => Promise<void>;
  unmount: () => void;
}

export function createDomTestRoot(): DomTestRoot {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = createRoot(container);

  return {
    container,
    async render(element) {
      await act(async () => {
        root!.render(element);
      });
    },
    unmount() {
      act(() => {
        root?.unmount();
        root = null;
      });
      container.remove();
    },
  };
}

export function bodyText(): string {
  return document.body.textContent ?? '';
}
