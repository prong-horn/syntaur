import { readConfig } from '../utils/config.js';
import type { AgentType } from '../tui/launch.js';

export async function browseCommand(options: { agent: AgentType }): Promise<void> {
  const config = await readConfig();
  const projectsDir = config.defaultProjectDir;
  const agent = options.agent;

  const { render } = await import('ink');
  const React = await import('react');
  const { App } = await import('../tui/App.js');
  const { launchAgent } = await import('../tui/launch.js');

  let unmount: (() => void) | null = null;

  const onLaunch = async (launchOpts: { projectsDir: string; projectSlug: string; assignmentSlug: string }) => {
    if (unmount) {
      unmount();
      unmount = null;
    }
    await launchAgent({ ...launchOpts, agent });
  };

  const instance = render(
    React.createElement(App, { projectsDir, onLaunch }),
  );
  unmount = instance.unmount;

  await instance.waitUntilExit();
}
