import { escapeYamlString } from '../utils/yaml.js';

export interface ProjectParams {
  id: string;
  slug: string;
  title: string;
  timestamp: string;
  /** Short per-project ticket id prefix (e.g. FIT, SCR). */
  prefix: string;
  /** Next ticket counter value; ids are never reused. */
  nextTicket?: number;
  /** Default ticket template for `syntaur new` in this project. */
  defaultTemplate?: string;
  /**
   * Repository paths the project spans. Each entry is YAML-escaped on
   * render so paths with spaces / colons / quotes don't corrupt the
   * frontmatter. Empty by default for new projects.
   */
  repositories?: string[];
  /** Project-level default workflow id; emitted only when provided. */
  defaultWorkflow?: string | null;
  /** Project `type → workflow id` binding map; emitted only when non-empty. */
  workflowByType?: Record<string, string>;
}

function renderRepositoriesBlock(repos: string[] | undefined): string {
  if (!repos || repos.length === 0) {
    return 'repositories: []';
  }
  return ['repositories:', ...repos.map((p) => `  - ${escapeYamlString(p)}`)].join('\n');
}

/**
 * Render the optional project workflow-binding fields (`defaultWorkflow` scalar
 * + `workflowByType` map). Empty string when neither is set — a project with no
 * explicit binding is valid and resolves via the global default.
 */
function renderWorkflowBinding(
  defaultWorkflow: string | null | undefined,
  workflowByType: Record<string, string> | undefined,
): string {
  const lines: string[] = [];
  if (defaultWorkflow) lines.push(`defaultWorkflow: ${defaultWorkflow}`);
  if (workflowByType && Object.keys(workflowByType).length > 0) {
    lines.push('workflowByType:');
    for (const [type, workflow] of Object.entries(workflowByType)) {
      lines.push(`  ${type}: ${workflow}`);
    }
  }
  return lines.length > 0 ? `\n${lines.join('\n')}` : '';
}

export function renderProject(params: ProjectParams): string {
  const safeTitle = escapeYamlString(params.title);
  const repositoriesBlock = renderRepositoriesBlock(params.repositories);
  const workflowBindingBlock = renderWorkflowBinding(
    params.defaultWorkflow,
    params.workflowByType,
  );
  const nextTicket = params.nextTicket ?? 1;
  const defaultTemplate = params.defaultTemplate ?? 'feature';
  return `---
id: ${params.id}
slug: ${params.slug}
title: ${safeTitle}
prefix: ${params.prefix}
nextTicket: ${nextTicket}
defaultTemplate: ${defaultTemplate}
archived: false
archivedAt: null
archivedReason: null
created: "${params.timestamp}"
updated: "${params.timestamp}"
externalIds: []
tags: []
${repositoriesBlock}${workflowBindingBlock}
---

# ${params.title}

## Overview

<!-- Describe the project goal, context, and success criteria here. -->

## Notes

<!-- Optional human notes, updates, or context. -->
`;
}
