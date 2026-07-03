import { useEffect } from 'react';
import type { Region } from './registry.js';
import { useHitRegistry } from './MouseContext.js';

export function useMouseRegions(regions: Region[]): void {
  const registry = useHitRegistry();
  useEffect(() => {
    for (const r of regions) registry.set(r);
    return () => { for (const r of regions) registry.remove(r.id); };
  }, [registry, regions]);
}
