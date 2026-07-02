import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Cockpit } from '../Cockpit.js';

describe('Cockpit shell', () => {
  it('renders rail + detail + status bar', () => {
    const { lastFrame } = render(<Cockpit projectsDir="/tmp/p" assignmentsDir="/tmp/a" tmuxAvailable={false} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('Rail');
    expect(f).toContain('Detail');
    expect(f).toContain('no tmux');
  });
});
