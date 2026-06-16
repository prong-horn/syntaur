import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Scroll to the element whose id matches `location.hash` once content has
 * rendered. Re-runs on mount and whenever the hash or `tab` changes, so a
 * palette deep-link like `?tab=plan#my-heading` lands on the right heading after
 * the pane swaps in. A `requestAnimationFrame` (plus a short fallback timeout)
 * defers the lookup until after the markdown headings — which carry
 * `slugifyHeading`-derived ids — have committed to the DOM.
 *
 * Pass the active `tab` so a tab switch (which re-renders a different pane)
 * re-triggers the scroll for the same hash.
 */
export function useHashScroll(tab?: string): void {
  const location = useLocation();

  useEffect(() => {
    const id = location.hash.slice(1);
    if (!id) return;

    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const scroll = () => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ block: 'start' });
        return true;
      }
      return false;
    };

    // First try after the next paint; if the target isn't mounted yet (pane
    // still swapping), retry once after a short delay.
    raf = requestAnimationFrame(() => {
      if (!scroll()) {
        timer = setTimeout(scroll, 80);
      }
    });

    return () => {
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
  }, [location.hash, location.pathname, tab]);
}
