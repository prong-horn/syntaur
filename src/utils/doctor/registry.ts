import type { Check } from './types.js';
import { envChecks } from './checks/env.js';
import { structureChecks } from './checks/structure.js';
import { projectChecks } from './checks/project.js';
import { ticketChecks } from './checks/ticket.js';
import { dashboardChecks } from './checks/dashboard.js';
import { integrationChecks } from './checks/integrations.js';
import { workspaceChecks } from './checks/workspace.js';
import { skillsChecks } from './checks/skills.js';
import { crossAgentChecks } from './checks/cross-agent.js';
import { pluginChecks } from './checks/plugin.js';
import { deriveConfigChecks } from './checks/derive-config.js';
import { workflowsChecks } from './checks/workflows.js';
import { stalenessChecks } from './checks/staleness.js';

export function allChecks(): Check[] {
  return [
    ...envChecks,
    ...structureChecks,
    ...projectChecks,
    ...ticketChecks,
    ...dashboardChecks,
    ...integrationChecks,
    ...workspaceChecks,
    ...skillsChecks,
    ...crossAgentChecks,
    ...pluginChecks,
    ...deriveConfigChecks,
    ...workflowsChecks,
    ...stalenessChecks,
  ];
}
