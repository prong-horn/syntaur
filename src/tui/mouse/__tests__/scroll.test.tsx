import { describe, it, expect, vi } from 'vitest';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { clampOffset, nextOffset, useViewport, WHEEL_STEP, type ViewportState } from '../scroll.js';

describe('clampOffset', () => {
  it('clamps to 0 when negative', () => {
    expect(clampOffset(-5, 100, 10)).toBe(0);
  });
  it('clamps to contentLength - viewHeight at the max', () => {
    expect(clampOffset(1000, 100, 10)).toBe(90);
  });
  it('is 0 when content fits within the viewport', () => {
    expect(clampOffset(5, 8, 10)).toBe(0);
  });
  it('passes through an in-range offset unchanged', () => {
    expect(clampOffset(42, 100, 10)).toBe(42);
  });
});

describe('nextOffset', () => {
  const base: ViewportState = { offset: 50, followTail: false };

  it('moves down by delta and clamps at the bottom', () => {
    const next = nextOffset(base, 1000, 100, 10);
    expect(next.offset).toBe(90);
    expect(next.followTail).toBe(true);
  });

  it('moves up by delta and turns followTail off away from the bottom', () => {
    const atBottom: ViewportState = { offset: 90, followTail: true };
    const next = nextOffset(atBottom, -WHEEL_STEP, 100, 10);
    expect(next.offset).toBe(87);
    expect(next.followTail).toBe(false);
  });

  it('resumes followTail exactly when scrolling back to the bottom', () => {
    const next = nextOffset({ offset: 80, followTail: false }, 10, 100, 10);
    expect(next.offset).toBe(90);
    expect(next.followTail).toBe(true);
  });

  it('never goes negative', () => {
    const next = nextOffset({ offset: 2, followTail: false }, -100, 100, 10);
    expect(next.offset).toBe(0);
  });
});

function ViewportProbe({ contentLength, viewHeight }: { contentLength: number; viewHeight: number }) {
  const vp = useViewport(contentLength, viewHeight);
  return (
    <Text>
      offset={vp.offset} followTail={String(vp.followTail)} atBottom={String(vp.atBottom)}
    </Text>
  );
}

describe('useViewport', () => {
  it('starts at offset 0, following the tail', () => {
    const { lastFrame, unmount } = render(<ViewportProbe contentLength={5} viewHeight={10} />);
    expect(lastFrame()).toContain('offset=0');
    expect(lastFrame()).toContain('followTail=true');
    unmount();
  });

  it('tracks the bottom as content grows while following', async () => {
    const { lastFrame, rerender, unmount } = render(<ViewportProbe contentLength={5} viewHeight={10} />);
    rerender(<ViewportProbe contentLength={50} viewHeight={10} />);
    await vi.waitFor(() => expect(lastFrame()).toContain('offset=40'));
    expect(lastFrame()).toContain('followTail=true');
    unmount();
  });
});
