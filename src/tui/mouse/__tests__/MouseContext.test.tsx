import { describe, it, expect, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink-testing-library';
import { Text, useStdin } from 'ink';
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

  it('drives a raw SGR mouse byte-sequence through Ink\'s input emitter to a registered region', async () => {
    const onClick = vi.fn();
    // Capture what Ink's internal `input` emitter actually delivers for the SGR
    // write — this is the SAME channel MouseProvider now subscribes to, so it
    // proves the mouse bytes reach `onInput` through Ink's parser (not a
    // competing `stdin.on('data')` listener).
    const emitted: string[] = [];
    function ClickProbe() {
      const stdinCtx = useStdin() as unknown as { internal_eventEmitter?: EventEmitter };
      useMouseRegions([{ id: 'r', rect: { x: 0, y: 0, width: 5, height: 1 }, onClick }]);
      React.useEffect(() => {
        const emitter = stdinCtx.internal_eventEmitter;
        if (!emitter) return;
        const cap = (chunk: string) => emitted.push(chunk);
        emitter.on('input', cap);
        return () => {
          emitter.off('input', cap);
        };
      }, [stdinCtx]);
      return <Text>probe</Text>;
    }
    const { stdin } = render(<MouseProvider><ClickProbe /></MouseProvider>);

    // SGR 1006 press: button 0 (left) at 1-indexed (3,1) -> 0-indexed (2,0),
    // which falls inside the {x:0,y:0,width:5,height:1} region.
    stdin.write('\x1b[<0;3;1M');

    await vi.waitFor(() => {
      expect(onClick).toHaveBeenCalledTimes(1);
    });
    // Ink's parser delivered the FULL SGR sequence as a single string through
    // the internal emitter (its final byte `M` completes the CSI); it is NOT
    // split or held pending, so no flush timer is needed.
    expect(emitted).toContain('\x1b[<0;3;1M');
    const evt = onClick.mock.calls[0][0];
    expect(evt).toMatchObject({ x: 2, y: 0, button: 'left', action: 'down' });
  });
});
