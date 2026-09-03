import { readConfig } from '../utils/config.js';

export interface BrowseOptions {
  agent?: string;
  worktreePrompt?: boolean;
}

/**
 * The assignment browser. It used to double as a launcher — Enter opened an
 * agent in a terminal — but agents are worked in the dashboard's Chat tab now
 * (phase 4, Decision 8), so the tree is a reader.
 */
export async function browseCommand(_options: BrowseOptions): Promise<void> {
  const config = await readConfig();
  const projectsDir = config.defaultProjectDir;

  const { render } = await import('ink');
  const React = await import('react');
  const { App } = await import('../tui/App.js');

  const instance = render(React.createElement(App, { projectsDir }));
  await instance.waitUntilExit();
}
