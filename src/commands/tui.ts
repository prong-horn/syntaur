import React from 'react';
import { readConfig, type SyntaurConfig } from '../utils/config.js';
import { initSessionDb } from '../dashboard/session-db.js';
import { checkClaudeBgAvailable } from '../tui/claude-agents/capability.js';
import { checkSyntaurdAvailable } from '../tui/syntaurd/capability.js';
import { assignmentsDir as resolveAssignmentsDir } from '../utils/paths.js';

export interface CockpitRenderProps {
  projectsDir: string;
  assignmentsDir: string;
  claudeBgAvailable: boolean;
  syntaurdAvailable: boolean;
}

export async function buildTuiRenderProps(deps: {
  config: SyntaurConfig;
  assignmentsDir: string;
  checkClaudeBg: () => Promise<boolean>;
  checkSyntaurd: () => Promise<boolean>;
}): Promise<CockpitRenderProps> {
  return {
    projectsDir: deps.config.defaultProjectDir,
    assignmentsDir: deps.assignmentsDir,
    claudeBgAvailable: await deps.checkClaudeBg(),
    syntaurdAvailable: await deps.checkSyntaurd(),
  };
}

export async function tuiCommand(): Promise<void> {
  const config = await readConfig();
  initSessionDb();
  const props = await buildTuiRenderProps({
    config,
    assignmentsDir: resolveAssignmentsDir(),
    checkClaudeBg: checkClaudeBgAvailable,
    checkSyntaurd: checkSyntaurdAvailable,
  });

  const { render } = await import('ink');
  const { Cockpit } = await import('../tui/cockpit/Cockpit.js');
  const instance = render(React.createElement(Cockpit, props), { alternateScreen: true });
  await instance.waitUntilExit();
}
