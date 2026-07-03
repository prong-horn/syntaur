import React from 'react';
import { readConfig, type SyntaurConfig } from '../utils/config.js';
import { initSessionDb } from '../dashboard/session-db.js';
import { checkTmuxAvailable } from '../dashboard/scanner.js';
import { assignmentsDir as resolveAssignmentsDir } from '../utils/paths.js';

export interface CockpitRenderProps {
  projectsDir: string;
  assignmentsDir: string;
  tmuxAvailable: boolean;
}

export async function buildTuiRenderProps(deps: {
  config: SyntaurConfig;
  assignmentsDir: string;
  checkTmux: () => Promise<boolean>;
}): Promise<CockpitRenderProps> {
  return {
    projectsDir: deps.config.defaultProjectDir,
    assignmentsDir: deps.assignmentsDir,
    tmuxAvailable: await deps.checkTmux(),
  };
}

export async function tuiCommand(): Promise<void> {
  const config = await readConfig();
  initSessionDb();
  const props = await buildTuiRenderProps({
    config,
    assignmentsDir: resolveAssignmentsDir(),
    checkTmux: checkTmuxAvailable,
  });

  const { render } = await import('ink');
  const { Cockpit } = await import('../tui/cockpit/Cockpit.js');
  const instance = render(React.createElement(Cockpit, props), { alternateScreen: true });
  await instance.waitUntilExit();
}
