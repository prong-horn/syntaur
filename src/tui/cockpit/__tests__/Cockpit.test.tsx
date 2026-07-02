import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Cockpit } from '../Cockpit.js';

describe('Cockpit shell', () => {
  it('renders rail (Live Sessions + Projects) + detail + action bar', () => {
    const { lastFrame, unmount } = render(<Cockpit projectsDir="/tmp/p" assignmentsDir="/tmp/a" tmuxAvailable={false} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('Live Sessions');
    expect(f).toContain('Projects');
    expect(f).toContain('Detail');
    // Action bar: Launch/Attach are context-sensitive (no selection yet ->
    // disabled), Quit is always available.
    expect(f).toContain('Launch');
    expect(f).toContain('Attach');
    expect(f).toContain('Quit');
    unmount();
  });
});
