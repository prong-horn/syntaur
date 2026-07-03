import { describe, it, expect, vi } from 'vitest';
import { HitRegistry } from '../registry.js';
import type { MouseEvent } from '../parse.js';

const at = (x: number, y: number, action: MouseEvent['action'] = 'down'): MouseEvent => ({
  x, y, button: action.startsWith('scroll') ? 'none' : 'left', action,
});

describe('HitRegistry', () => {
  it('fires onClick for a down inside a region', () => {
    const r = new HitRegistry(); const spy = vi.fn();
    r.set({ id: 'a', rect: { x: 0, y: 0, width: 10, height: 2 }, onClick: spy });
    expect(r.dispatch(at(3, 1))).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
  });
  it('does nothing outside every region', () => {
    const r = new HitRegistry(); const spy = vi.fn();
    r.set({ id: 'a', rect: { x: 0, y: 0, width: 2, height: 2 }, onClick: spy });
    expect(r.dispatch(at(9, 9))).toBe(false);
  });
  it('routes scroll to onScroll not onClick', () => {
    const r = new HitRegistry(); const click = vi.fn(); const scroll = vi.fn();
    r.set({ id: 'a', rect: { x: 0, y: 0, width: 10, height: 10 }, onClick: click, onScroll: scroll });
    r.dispatch(at(1, 1, 'scroll-down'));
    expect(scroll).toHaveBeenCalledOnce();
    expect(click).not.toHaveBeenCalled();
  });
  it('higher z wins on overlap', () => {
    const r = new HitRegistry(); const lo = vi.fn(); const hi = vi.fn();
    r.set({ id: 'lo', rect: { x: 0, y: 0, width: 10, height: 10 }, onClick: lo, z: 0 });
    r.set({ id: 'hi', rect: { x: 0, y: 0, width: 10, height: 10 }, onClick: hi, z: 5 });
    r.dispatch(at(2, 2));
    expect(hi).toHaveBeenCalledOnce();
    expect(lo).not.toHaveBeenCalled();
  });
  it('remove unregisters', () => {
    const r = new HitRegistry(); const spy = vi.fn();
    r.set({ id: 'a', rect: { x: 0, y: 0, width: 10, height: 10 }, onClick: spy });
    r.remove('a');
    expect(r.dispatch(at(1, 1))).toBe(false);
  });
});
