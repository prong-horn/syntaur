import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { MouseProvider } from '../../mouse/MouseContext.js';
import { ActionBar } from '../ActionBar.js';

describe('ActionBar', () => {
  it('renders enabled + disabled actions with key hints', () => {
    const { lastFrame } = render(
      <MouseProvider>
        <ActionBar
          barRect={{ x: 0, y: 23, width: 80, height: 1 }}
          actions={[
            { key: 'l', label: 'Launch', onRun: vi.fn(), enabled: true },
            { key: 'a', label: 'Attach', onRun: vi.fn(), enabled: false },
          ]}
        />
      </MouseProvider>,
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('Launch');
    expect(f).toContain('Attach');
    expect(f).toContain('l');
    expect(f).toContain('a');
  });
});
