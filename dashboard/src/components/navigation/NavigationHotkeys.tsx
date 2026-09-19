import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

/** Option A: fixed navigation chords and new-ticket only. */
const CHORD_TIMEOUT_MS = 1000;

const CHORD_DESTINATIONS: Record<string, string> = {
  n: '/inbox',
  b: '/board',
  s: '/sessions',
  l: '/library/playbooks',
  ',': '/settings',
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  if (target.closest('[role="combobox"], [role="textbox"]')) return true;
  return false;
}

function isOpenDialogPresent(): boolean {
  // Radix marks open dialogs with data-state, while custom/legacy overlays may
  // only expose the ARIA modal role. Either is enough to keep a global chord
  // from navigating away with an in-progress form.
  return !!document.querySelector(
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"]',
  );
}

export function NavigationHotkeys() {
  const navigate = useNavigate();
  const chordRef = useRef<{ awaiting: boolean; startedAt: number }>({
    awaiting: false,
    startedAt: 0,
  });
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    function clearChordTimer() {
      chordRef.current.awaiting = false;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }

    function handleKeydown(event: KeyboardEvent) {
      if (event.repeat || event.isComposing || event.key === 'Process' ||
          event.metaKey || event.ctrlKey || event.altKey || event.shiftKey ||
          isOpenDialogPresent() || isEditableTarget(event.target)) {
        clearChordTimer();
        return;
      }

      const key = event.key;

      if (chordRef.current.awaiting) {
        const elapsed = Date.now() - chordRef.current.startedAt;
        if (elapsed > CHORD_TIMEOUT_MS) {
          clearChordTimer();
        } else {
          const dest = CHORD_DESTINATIONS[key];
          if (dest) {
            event.preventDefault();
            clearChordTimer();
            navigate(dest);
            return;
          }
          clearChordTimer();
        }
      }

      if (key === 'n') {
        event.preventDefault();
        navigate('/board?dialog=new-ticket');
        return;
      }

      if (key === 'g') {
        event.preventDefault();
        chordRef.current = { awaiting: true, startedAt: Date.now() };
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(clearChordTimer, CHORD_TIMEOUT_MS);
      }
    }

    window.addEventListener('keydown', handleKeydown);
    return () => {
      window.removeEventListener('keydown', handleKeydown);
      clearChordTimer();
    };
  }, [navigate]);

  return null;
}
