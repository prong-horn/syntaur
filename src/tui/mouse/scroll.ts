import { useCallback, useEffect, useState } from 'react';
import type { MouseEvent } from './parse.js';

export interface ViewportState {
  offset: number;
  /** Auto-follow the tail (bottom) as content grows, until the user scrolls up. */
  followTail: boolean;
}

/** Number of rows a single wheel tick moves. */
export const WHEEL_STEP = 3;

/** Clamp an offset into `[0, max(0, contentLength - viewHeight)]`. */
export function clampOffset(offset: number, contentLength: number, viewHeight: number): number {
  const maxOffset = Math.max(0, contentLength - viewHeight);
  if (offset < 0) return 0;
  return Math.min(offset, maxOffset);
}

/**
 * Pure reducer: applies a scroll delta (positive = down, negative = up) and
 * re-derives `followTail` — off the instant the result lands above the
 * bottom, back on the instant it lands exactly at the bottom (scroll-to-end
 * resumes following, per design spec §5.3's log-viewer semantics).
 */
export function nextOffset(
  state: ViewportState,
  delta: number,
  contentLength: number,
  viewHeight: number,
): ViewportState {
  const maxOffset = Math.max(0, contentLength - viewHeight);
  const offset = clampOffset(state.offset + delta, contentLength, viewHeight);
  return { offset, followTail: offset >= maxOffset };
}

export interface Viewport {
  offset: number;
  followTail: boolean;
  atBottom: boolean;
  onWheel: (e: MouseEvent) => void;
  scrollBy: (delta: number) => void;
  toBottom: () => void;
}

/**
 * Viewport offset for a scrollable pane of `viewHeight` rows over
 * `contentLength` total rows. Auto-follows the tail while `followTail` is
 * true (the default) so new content stays visible; the moment the user
 * scrolls up it stops following until they scroll/PgDn/End back to the
 * bottom. Pass `onWheel` straight to a `Region.onScroll` — the mouse
 * registry already routes `scroll-up`/`scroll-down` there.
 */
export function useViewport(contentLength: number, viewHeight: number): Viewport {
  const [state, setState] = useState<ViewportState>({ offset: 0, followTail: true });

  // Content grew/shrank or the pane resized. While following the tail, snap
  // to the new bottom. While NOT following (user scrolled up), leave the
  // absolute offset alone — new tail content must not yank their view — and
  // only re-clamp it down if it now overshoots (pane shrank). A clamp alone
  // never resumes follow-tail; only scrolling back to the bottom does.
  useEffect(() => {
    setState((s) => {
      if (s.followTail) {
        const offset = clampOffset(Number.POSITIVE_INFINITY, contentLength, viewHeight);
        return offset === s.offset ? s : { offset, followTail: true };
      }
      const offset = clampOffset(s.offset, contentLength, viewHeight);
      return offset === s.offset ? s : { offset, followTail: false };
    });
  }, [contentLength, viewHeight]);

  const scrollBy = useCallback(
    (delta: number) => {
      setState((s) => nextOffset(s, delta, contentLength, viewHeight));
    },
    [contentLength, viewHeight],
  );

  const onWheel = useCallback(
    (e: MouseEvent) => {
      scrollBy(e.action === 'scroll-up' ? -WHEEL_STEP : WHEEL_STEP);
    },
    [scrollBy],
  );

  const toBottom = useCallback(() => {
    scrollBy(Number.POSITIVE_INFINITY);
  }, [scrollBy]);

  const maxOffset = Math.max(0, contentLength - viewHeight);
  return {
    offset: state.offset,
    followTail: state.followTail,
    atBottom: state.offset >= maxOffset,
    onWheel,
    scrollBy,
    toBottom,
  };
}
