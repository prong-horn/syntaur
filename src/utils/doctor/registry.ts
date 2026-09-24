import type { Check } from './types.js';
import { envChecks } from './checks/env.js';
import { structureChecks } from './checks/structure.js';
import { legacyLeftoverChecks } from './checks/legacy-leftovers.js';
import { legacyLeftoverChecks } from './checks/legacy-leftovers.js';
import { projectChecks } from './checks/project.js';
import { ticketChecks } from './checks/ticket.js';
import { dashboardChecks } from './checks/dashboard.js';
import { workspaceChecks } from './checks/workspace.js';
import { skillsChecks } from './checks/skills.js';
import { hooksChecks } from './checks/hooks.js';
import { stalenessChecks } from './checks/staleness.js';
import { gitChecks } from './checks/git.js';

export function allChecks(): Check[] {
  return [
    ...envChecks,
    ...structureChecks,
    ...legacyLeftoverChecks,
    ...gitChecks,
    ...projectChecks,
    ...ticketChecks,
    ...dashboardChecks,
    ...workspaceChecks,
    ...hooksChecks,
    ...skillsChecks,
    ...stalenessChecks,
  ];
}
