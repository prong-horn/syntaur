import type { Check } from './types.js';
import { envChecks } from './checks/env.js';
import { structureChecks } from './checks/structure.js';
import { missionChecks } from './checks/mission.js';
import { assignmentChecks } from './checks/assignment.js';
import { dashboardChecks } from './checks/dashboard.js';
import { integrationChecks } from './checks/integrations.js';
import { workspaceChecks } from './checks/workspace.js';

export function allChecks(): Check[] {
  return [
    ...envChecks,
    ...structureChecks,
    ...missionChecks,
    ...assignmentChecks,
    ...dashboardChecks,
    ...integrationChecks,
    ...workspaceChecks,
  ];
}
