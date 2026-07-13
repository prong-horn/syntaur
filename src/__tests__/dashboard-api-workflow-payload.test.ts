import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getAssignmentDetail,
  getProjectDetail,
  clearStatusConfigCache,
} from '../dashboard/api.js';
import { writeWorkflowsConfig, type WorkflowDefinition } from '../utils/config.js';
import { buildDefaultStatusConfig } from '../utils/status-defaults.js';

const originalSyntaurHome = process.env.SYNTAUR_HOME;

let tmpHome: string;
let projectsDir: string;

const bug: WorkflowDefinition = {
  label: 'Bug Flow',
  statuses: [
    { id: 'open', label: 'Open', terminal: false },
    { id: 'fixing', label: 'Fixing Hard', terminal: false },
    { id: 'verified', label: 'Verified & Closed', terminal: true },
  ],
  order: ['open', 'fixing', 'verified'],
  transitions: [{ from: 'open', command: 'start', to: 'fixing' }],
  derive: null,
  facts: null,
};

function assignmentMd(opts: {
  slug: string;
  type?: string | null;
  workflow?: string | null;
  status: string;
}): string {
  const workflowLine = opts.workflow ? `\nworkflow: ${opts.workflow}` : '';
  return `---
id: 11111111-1111-1111-1111-${opts.slug.padEnd(12, '0').slice(0, 12)}
slug: ${opts.slug}
title: ${opts.slug} title
project: proj
type: ${opts.type ?? 'feature'}${workflowLine}
status: ${opts.status}
priority: medium
created: "2026-04-07T10:00:00Z"
updated: "2026-04-07T10:00:00Z"
---

# ${opts.slug}

## Objective

Do the thing.
`;
}

async function seedAssignment(opts: {
  slug: string;
  type?: string | null;
  workflow?: string | null;
  status: string;
}): Promise<void> {
  const dir = resolve(projectsDir, 'proj', 'assignments', opts.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'assignment.md'), assignmentMd(opts), 'utf-8');
}

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'wf-payload-home-'));
  process.env.SYNTAUR_HOME = tmpHome;
  await mkdir(join(tmpHome, '.syntaur'), { recursive: true });
  projectsDir = await mkdtemp(join(tmpdir(), 'wf-payload-proj-'));

  // Global workflow library: built-in default + a custom "bug" workflow.
  const def: WorkflowDefinition = { label: 'Default', ...buildDefaultStatusConfig() };
  await writeWorkflowsConfig({ default: def, bug }, 'default');
  clearStatusConfigCache();
});

afterEach(async () => {
  if (originalSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = originalSyntaurHome;
  clearStatusConfigCache();
  await rm(tmpHome, { recursive: true, force: true });
  await rm(projectsDir, { recursive: true, force: true });
});

describe('API payloads carry workflow id/label + real status label (Task 9)', () => {
  it('resolves the ticket workflow via project workflowByType[type]', async () => {
    // Project binds type "bug" → the bug workflow.
    await mkdir(resolve(projectsDir, 'proj'), { recursive: true });
    await writeFile(
      resolve(projectsDir, 'proj', 'project.md'),
      `---\nid: p\nslug: proj\ntitle: Proj\nworkflowByType:\n  bug: bug\n---\n# Proj\n`,
      'utf-8',
    );
    await seedAssignment({ slug: 'a1', type: 'bug', status: 'fixing' });

    const detail = await getAssignmentDetail(projectsDir, 'proj', 'a1');
    expect(detail).not.toBeNull();
    expect(detail!.workflow).toBeNull(); // no explicit override — resolved via type
    expect(detail!.resolvedWorkflow).toBe('bug');
    expect(detail!.workflowLabel).toBe('Bug Flow');
    expect(detail!.statusLabel).toBe('Fixing Hard'); // label from the bug workflow, not default
  });

  it('honors an explicit assignment `workflow:` override', async () => {
    await mkdir(resolve(projectsDir, 'proj'), { recursive: true });
    await writeFile(
      resolve(projectsDir, 'proj', 'project.md'),
      `---\nid: p\nslug: proj\ntitle: Proj\n---\n# Proj\n`,
      'utf-8',
    );
    // No project binding; the assignment pins the bug workflow explicitly.
    await seedAssignment({ slug: 'a2', type: 'feature', workflow: 'bug', status: 'verified' });

    const detail = await getAssignmentDetail(projectsDir, 'proj', 'a2');
    expect(detail!.workflow).toBe('bug');
    expect(detail!.resolvedWorkflow).toBe('bug');
    expect(detail!.workflowLabel).toBe('Bug Flow');
    expect(detail!.statusLabel).toBe('Verified & Closed');
  });

  it('falls back to the default workflow for an unbound ticket', async () => {
    await mkdir(resolve(projectsDir, 'proj'), { recursive: true });
    await writeFile(
      resolve(projectsDir, 'proj', 'project.md'),
      `---\nid: p\nslug: proj\ntitle: Proj\n---\n# Proj\n`,
      'utf-8',
    );
    await seedAssignment({ slug: 'a3', type: 'feature', status: 'in_progress' });

    const detail = await getAssignmentDetail(projectsDir, 'proj', 'a3');
    expect(detail!.resolvedWorkflow).toBe('default');
    expect(detail!.workflowLabel).toBe('Default');
    expect(detail!.statusLabel).toBe('In Progress');
  });

  it('project-detail summaries also carry the resolved workflow per ticket', async () => {
    await mkdir(resolve(projectsDir, 'proj'), { recursive: true });
    await writeFile(
      resolve(projectsDir, 'proj', 'project.md'),
      `---\nid: p\nslug: proj\ntitle: Proj\nworkflowByType:\n  bug: bug\n---\n# Proj\n`,
      'utf-8',
    );
    await seedAssignment({ slug: 'a1', type: 'bug', status: 'fixing' });
    await seedAssignment({ slug: 'a3', type: 'feature', status: 'in_progress' });

    const project = await getProjectDetail(projectsDir, 'proj');
    expect(project).not.toBeNull();
    const bySlug = Object.fromEntries(project!.assignments.map((a) => [a.slug, a]));
    expect(bySlug.a1.resolvedWorkflow).toBe('bug');
    expect(bySlug.a1.statusLabel).toBe('Fixing Hard');
    expect(bySlug.a3.resolvedWorkflow).toBe('default');
  });
});
