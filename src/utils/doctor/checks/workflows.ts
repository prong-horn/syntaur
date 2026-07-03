/**
 * Doctor check: every workflow binding references a workflow that actually
 * exists in the library. A dangling binding (project `defaultWorkflow` /
 * `workflowByType[type]`, global `defaultWorkflow`, or an assignment `workflow:`
 * override that names a workflow that was deleted or misspelled) silently
 * resolves to `default` at runtime — this surfaces it as an error instead so the
 * ticket lands where the author intended.
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists } from '../../fs.js';
import { getWorkflowLibrary, DEFAULT_WORKFLOW_ID } from '../../workflow-resolve.js';
import { readProjectBinding } from '../../project-binding.js';
import { listAssignmentsByProject } from '../../assignment-walk.js';
import { parseAssignmentFull } from '../../../dashboard/parser.js';
import { assignmentsDir as getStandaloneDir } from '../../paths.js';
import type { Check, CheckResult } from '../types.js';

const CATEGORY = 'workflows';

const referencesResolve: Check = {
  id: 'workflows.references-resolve',
  category: CATEGORY,
  title: 'Workflow bindings reference defined workflows',
  async run(ctx): Promise<CheckResult> {
    const library = getWorkflowLibrary(ctx.config);
    const known = new Set(Object.keys(library));
    const problems: string[] = [];

    // The built-in default must always be resolvable — it is the terminal
    // fallback for every binding.
    if (!known.has(DEFAULT_WORKFLOW_ID)) {
      problems.push(`the built-in "${DEFAULT_WORKFLOW_ID}" workflow is missing from the library`);
    }
    if (ctx.config.defaultWorkflow && !known.has(ctx.config.defaultWorkflow)) {
      problems.push(
        `global defaultWorkflow "${ctx.config.defaultWorkflow}" is not a defined workflow`,
      );
    }

    // Per-project bindings.
    const projectsDir = ctx.config.defaultProjectDir;
    let projectNames: string[] = [];
    try {
      projectNames = await readdir(projectsDir);
    } catch {
      projectNames = [];
    }
    for (const name of projectNames) {
      const projectDir = resolve(projectsDir, name);
      if (!(await fileExists(resolve(projectDir, 'project.md')))) continue;
      const binding = await readProjectBinding(projectDir);
      if (binding.defaultWorkflow && !known.has(binding.defaultWorkflow)) {
        problems.push(
          `project ${name}: defaultWorkflow "${binding.defaultWorkflow}" is not a defined workflow`,
        );
      }
      for (const [type, wf] of Object.entries(binding.workflowByType)) {
        if (!known.has(wf)) {
          problems.push(
            `project ${name}: workflowByType[${type}] = "${wf}" is not a defined workflow`,
          );
        }
      }
    }

    // Per-assignment overrides.
    const { withAssignmentMd } = await listAssignmentsByProject(projectsDir, getStandaloneDir());
    for (const a of withAssignmentMd) {
      try {
        const parsed = parseAssignmentFull(
          await readFile(resolve(a.assignmentDir, 'assignment.md'), 'utf-8'),
        );
        if (parsed.workflow && !known.has(parsed.workflow)) {
          const where = a.projectSlug ? `${a.projectSlug}/${a.assignmentSlug}` : a.assignmentSlug;
          problems.push(`${where}: workflow "${parsed.workflow}" is not a defined workflow`);
        }
      } catch {
        // A malformed assignment.md is the assignment checks' concern, not ours.
      }
    }

    if (problems.length === 0) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'pass',
        detail: `${known.size} workflow(s) defined; all bindings resolve`,
        autoFixable: false,
      };
    }

    return {
      id: this.id,
      category: this.category,
      title: this.title,
      status: 'error',
      detail: problems.join('; '),
      affected: problems,
      remediation: {
        kind: 'manual',
        suggestion:
          'Define the missing workflow(s) under `workflows:` in ~/.syntaur/config.md, or fix the binding to name an existing workflow id.',
        command: null,
      },
      autoFixable: false,
    };
  },
};

export const workflowsChecks: Check[] = [referencesResolve];
