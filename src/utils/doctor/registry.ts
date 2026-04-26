import type { Check } from './types.js';
import { envChecks } from './checks/env.js';
import { structureChecks } from './checks/structure.js';
import { projectChecks } from './checks/project.js';
import { assignmentChecks } from './checks/assignment.js';
import { dashboardChecks } from './checks/dashboard.js';
import { integrationChecks } from './checks/integrations.js';
import { workspaceChecks } from './checks/workspace.js';
import { agentChecks } from './checks/agents.js';

export function allChecks(): Check[] {
  return [
    ...envChecks,
    ...structureChecks,
    ...projectChecks,
    ...assignmentChecks,
    ...dashboardChecks,
    ...integrationChecks,
    ...workspaceChecks,
    ...agentChecks,
  ];
}
