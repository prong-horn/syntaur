import type { MouseEvent } from './parse.js';

export interface Rect { x: number; y: number; width: number; height: number; }
export interface Region {
  id: string;
  rect: Rect;
  onClick?: (e: MouseEvent) => void;
  onScroll?: (e: MouseEvent) => void;
  z?: number;
}

export function rectContains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

export class HitRegistry {
  private regions = new Map<string, Region>();
  set(region: Region): void { this.regions.set(region.id, region); }
  remove(id: string): void { this.regions.delete(id); }
  clear(): void { this.regions.clear(); }
  dispatch(e: MouseEvent): boolean {
    const target = [...this.regions.values()]
      .filter((r) => rectContains(r.rect, e.x, e.y))
      .sort((a, b) => (b.z ?? 0) - (a.z ?? 0))[0];
    if (!target) return false;
    if (e.action === 'scroll-up' || e.action === 'scroll-down') {
      if (target.onScroll) { target.onScroll(e); return true; }
      return false;
    }
    if (e.action === 'down' && target.onClick) { target.onClick(e); return true; }
    return false;
  }
}
