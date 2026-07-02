import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { MouseProvider } from '../../mouse/MouseContext.js';
import { LeftRail } from '../LeftRail.js';
import type { AgentSessionWithLiveness } from '../../../dashboard/types.js';

const session = {
  sessionId: 's1abc999',
  agent: 'claude',
  started: '2026-07-01T00:00:00Z',
  status: 'active',
  isLive: true,
  resumeSupported: true,
  forkSupported: false,
  projectSlug: null,
  assignmentSlug: null,
  path: '/tmp/s1abc999',
} as AgentSessionWithLiveness;

describe('LeftRail', () => {
  it('renders Live Sessions + a live row', () => {
    const { lastFrame, unmount } = render(
      <MouseProvider>
        <LeftRail
          projectsDir="/tmp/p"
          railRect={{ x: 0, y: 0, width: 30, height: 20 }}
          sessions={[session]}
          focused
          active
          onSelectSession={vi.fn()}
          onSelectAssignment={vi.fn()}
        />
      </MouseProvider>,
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('Live Sessions');
    expect(f).toContain('claude');
    expect(f).toContain('s1abc99');
    unmount();
  });

  it('renders (none) when there are no live sessions', () => {
    const { lastFrame, unmount } = render(
      <MouseProvider>
        <LeftRail
          projectsDir="/tmp/p"
          railRect={{ x: 0, y: 0, width: 30, height: 20 }}
          sessions={[]}
          focused={false}
          active={false}
          onSelectSession={vi.fn()}
          onSelectAssignment={vi.fn()}
        />
      </MouseProvider>,
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('(none)');
    unmount();
  });
});
