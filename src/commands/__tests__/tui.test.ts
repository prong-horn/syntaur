import { describe, it, expect } from 'vitest';
import { buildTuiRenderProps } from '../tui.js';

describe('tui bootstrap', () => {
  it('derives cockpit props from config + tmux probe', async () => {
    const props = await buildTuiRenderProps({
      config: { defaultProjectDir: '/tmp/projects' } as never,
      assignmentsDir: '/tmp/assignments',
      checkTmux: async () => true,
    });
    expect(props).toEqual({ projectsDir: '/tmp/projects', assignmentsDir: '/tmp/assignments', tmuxAvailable: true });
  });
});
