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

  it('drives a raw SGR mouse byte-sequence from stdin through the parser to a registered region', async () => {
    const onClick = vi.fn();
    function ClickProbe() {
      useMouseRegions([{ id: 'r', rect: { x: 0, y: 0, width: 5, height: 1 }, onClick }]);
      return <Text>probe</Text>;
    }
    const { stdin } = render(<MouseProvider><ClickProbe /></MouseProvider>);

    // SGR 1006 press: button 0 (left) at 1-indexed (3,1) -> 0-indexed (2,0),
    // which falls inside the {x:0,y:0,width:5,height:1} region.
    stdin.write('\x1b[<0;3;1M');

    await vi.waitFor(() => {
      expect(onClick).toHaveBeenCalledTimes(1);
    });
    const evt = onClick.mock.calls[0][0];
    expect(evt).toMatchObject({ x: 2, y: 0, button: 'left', action: 'down' });
  });
});
