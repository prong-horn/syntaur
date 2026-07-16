import { describe, it, expect } from 'vitest';
import { buildTuiRenderProps } from '../tui.js';

describe('tui bootstrap', () => {
  it('derives cockpit props from config + tmux + claude-bg + syntaurd probes', async () => {
    const props = await buildTuiRenderProps({
      config: { defaultProjectDir: '/tmp/projects' } as never,
      assignmentsDir: '/tmp/assignments',
      checkTmux: async () => true,
      checkClaudeBg: async () => false,
      checkSyntaurd: async () => false,
    });
    expect(props).toEqual({
      projectsDir: '/tmp/projects',
      assignmentsDir: '/tmp/assignments',
      tmuxAvailable: true,
      claudeBgAvailable: false,
      syntaurdAvailable: false,
    });
  });

  it('threads the syntaurd probe result through to the props', async () => {
    const props = await buildTuiRenderProps({
      config: { defaultProjectDir: '/tmp/projects' } as never,
      assignmentsDir: '/tmp/assignments',
      checkTmux: async () => false,
      checkClaudeBg: async () => false,
      checkSyntaurd: async () => true,
    });
    expect(props.syntaurdAvailable).toBe(true);
  });
});
