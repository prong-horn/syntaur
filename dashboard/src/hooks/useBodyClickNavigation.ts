import { useCallback, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { NON_DRAGGABLE_SELECTOR } from '../components/KanbanBoard';

export interface BodyClickNavigation<T extends HTMLElement> {
  /** Attach to the clickable container (card `<div>`, table `<tr>`, …). */
  containerRef: RefObject<T>;
  onMouseDown: () => void;
  onClick: (event: ReactMouseEvent<T>) => void;
}

/**
 * Makes a whole container (a kanban/list card body or a table row) navigate to
 * `detailHref` on click, while NOT hijacking clicks that are really:
 *  - dismissing an open status-pill menu (its trigger inside the container still
 *    carries `aria-expanded="true"` at mousedown, before the picker's own
 *    document-level outside-close listener runs);
 *  - dismissing any open menu/popover (`[role="menu"]` rendered anywhere);
 *  - committing an inline editor (its `<input>`/`<textarea>` still holds focus at
 *    mousedown — blur fires afterward);
 *  - hitting an interactive control (anything matching `NON_DRAGGABLE_SELECTOR`).
 *
 * The suppress decision is taken on mousedown (when the overlay/focus state is
 * still observable) and consumed by the trailing click. Single source of truth
 * for "should this body click navigate?", shared by the kanban/list card and the
 * table row so they cannot drift apart.
 */
export function useBodyClickNavigation<T extends HTMLElement = HTMLElement>(
  detailHref: string,
): BodyClickNavigation<T> {
  const navigate = useNavigate();
  const containerRef = useRef<T>(null);
  // Set on mousedown; when true the trailing click is dismissing an open menu or
  // committing an inline edit, so it must NOT also navigate.
  const suppressNavRef = useRef(false);

  const onMouseDown = useCallback(() => {
    const container = containerRef.current;
    const statusMenuOpen = Boolean(container?.querySelector('[aria-expanded="true"]'));
    const anyMenuOpen = Boolean(document.querySelector('[role="menu"]'));
    const active = document.activeElement;
    const editorActive = Boolean(
      active &&
        container?.contains(active) &&
        (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA'),
    );
    suppressNavRef.current = statusMenuOpen || anyMenuOpen || editorActive;
  }, []);

  const onClick = useCallback(
    (event: ReactMouseEvent<T>) => {
      if (suppressNavRef.current) return; // dismissed a menu / committed an edit
      const target = event.target as HTMLElement | null;
      if (!target || target.closest(NON_DRAGGABLE_SELECTOR)) return; // interactive control
      navigate(detailHref);
    },
    [navigate, detailHref],
  );

  return { containerRef, onMouseDown, onClick };
}
