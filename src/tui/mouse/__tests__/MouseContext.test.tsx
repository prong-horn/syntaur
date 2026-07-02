import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { MouseProvider, useHitRegistry } from '../MouseContext.js';
import { useMouseRegions } from '../hooks.js';

function Probe({ onHit }: { onHit: () => void }) {
  const registry = useHitRegistry();
  useMouseRegions([{ id: 'p', rect: { x: 0, y: 0, width: 5, height: 1 }, onClick: onHit }]);
  React.useEffect(() => { registry.dispatch({ x: 2, y: 0, button: 'left', action: 'down' }); });
  return <Text>probe</Text>;
}

describe('MouseProvider + useMouseRegions', () => {
  it('registers a region reachable by the shared registry', () => {
    const onHit = vi.fn();
    render(<MouseProvider><Probe onHit={onHit} /></MouseProvider>);
    expect(onHit).toHaveBeenCalled();
  });
});
