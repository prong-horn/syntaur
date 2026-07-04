import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { workflowsChecks } from '../utils/doctor/checks/workflows.js';
import type { CheckContext, CheckResult } from '../utils/doctor/types.js';
import type { SyntaurConfig, WorkflowDefinition } from '../utils/config.js';
import { buildDefaultStatusConfig } from '../utils/status-defaults.js';

const check = workflowsChecks[0];
const originalHome = process.env.SYNTAUR_HOME;

let home: string;
let projectsDir: string;

const bug: WorkflowDefinition = { label: 'Bug', ...buildDefaultStatusConfig() };

// The check reads only workflows / defaultWorkflow / defaultProjectDir off the
// config, so a minimal cast is sufficient (matches the staleness-check tests).
function configWith(overrides: Partial<SyntaurConfig>): SyntaurConfig {
  return {
    defaultProjectDir: projectsDir,
    defaultWorkflow: null,
    workflows: { default: { label: 'Default', ...buildDefaultStatusConfig() }, bug },
    ...overrides,
  } as SyntaurConfig;
}

function ctxFor(config: SyntaurConfig): CheckContext {
  return {
    config,
    syntaurRoot: join(home, '.syntaur'),
    db: null,
    dbError: null,
    cwd: home,
    now: new Date('2026-07-02T00:00:00Z'),
  };
}

async function run(config: SyntaurConfig): Promise<CheckResult> {
  const r = await check.run(ctxFor(config));
  return Array.isArray(r) ? r[0] : r;
}

async function seedProject(slug: string, fm: string): Promise<void> {
  const dir = resolve(projectsDir, slug);
  await mkdir(dir, { recursive: true });
  const extra = fm ? `${fm}\n` : '';
  await writeFile(
    resolve(dir, 'project.md'),
    `---\nid: ${slug}\nslug: ${slug}\ntitle: ${slug}\n${extra}---\n# ${slug}\n`,
    'utf-8',
  );
}

async function seedAssignment(
  projectSlug: string,
  slug: string,
  workflow: string | null,
): Promise<void> {
  const dir = resolve(projectsDir, projectSlug, 'assignments', slug);
  await mkdir(dir, { recursive: true });
  const wf = workflow ? `\nworkflow: ${workflow}` : '';
  await writeFile(
    resolve(dir, 'assignment.md'),
    `---\nid: 22222222-2222-2222-2222-${slug.padEnd(12, '0').slice(0, 12)}\nslug: ${slug}\ntitle: ${slug}\nproject: ${projectSlug}\nstatus: in_progress\npriority: medium${wf}\n---\n# ${slug}\n\n## Objective\n\nDo it.\n`,
    'utf-8',
  );
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'doc-wf-home-'));
  process.env.SYNTAUR_HOME = home;
  await mkdir(join(home, '.syntaur', 'assignments'), { recursive: true }); // empty standalone tree
  projectsDir = await mkdtemp(join(tmpdir(), 'doc-wf-proj-'));
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = originalHome;
  await rm(home, { recursive: true, force: true });
  await rm(projectsDir, { recursive: true, force: true });
});

describe('doctor: workflows.references-resolve', () => {
  it('passes when every binding names a defined workflow', async () => {
    await seedProject('p', 'workflowByType:\n  bug: bug');
    await seedAssignment('p', 'a1', 'bug');
    const r = await run(configWith({}));
    expect(r.status).toBe('pass');
  });

  it('errors when a project workflowByType references a missing workflow', async () => {
    await seedProject('p', 'workflowByType:\n  bug: ghost');
    const r = await run(configWith({}));
    expect(r.status).toBe('error');
    expect(r.detail).toContain('ghost');
    expect(r.detail).toContain('workflowByType[bug]');
  });

  it('errors when a project defaultWorkflow references a missing workflow', async () => {
    await seedProject('p', 'defaultWorkflow: nope');
    const r = await run(configWith({}));
    expect(r.status).toBe('error');
    expect(r.detail).toContain('nope');
  });

  it('errors when an assignment workflow override references a missing workflow', async () => {
    await seedProject('p', '');
    await seedAssignment('p', 'a1', 'phantom');
    const r = await run(configWith({}));
    expect(r.status).toBe('error');
    expect(r.detail).toContain('phantom');
  });

  it('errors when the global defaultWorkflow is not defined', async () => {
    const r = await run(configWith({ defaultWorkflow: 'missing' }));
    expect(r.status).toBe('error');
    expect(r.detail).toContain('missing');
  });

  it('legacy single-workflow config (no `workflows:`) passes — library is just {default}', async () => {
    await seedProject('p', '');
    await seedAssignment('p', 'a1', null);
    // No `workflows` map, no statuses → getWorkflowLibrary synthesizes {default}.
    const r = await run({ defaultProjectDir: projectsDir, defaultWorkflow: null } as SyntaurConfig);
    expect(r.status).toBe('pass');
  });
});

describe('doctor: workflows.single-status-source', () => {
  const singleSource = workflowsChecks.find((c) => c.id === 'workflows.single-status-source')!;

  async function writeConfigMd(frontmatterBody: string): Promise<void> {
    await writeFile(
      join(home, '.syntaur', 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\n${frontmatterBody}---\n`,
      'utf-8',
    );
  }

  async function runSingle(config: SyntaurConfig): Promise<CheckResult> {
    const r = await singleSource.run(ctxFor(config));
    return Array.isArray(r) ? r[0] : r;
  }

  it('errors when BOTH a top-level statuses: block and a workflows: map exist', async () => {
    await writeConfigMd('statuses:\n  definitions:\n    - id: draft\n      label: Draft\n  order:\n    - draft\n');
    const r = await runSingle(configWith({}));
    expect(r.status).toBe('error');
    expect(r.detail).toContain('statuses:');
    expect(r.detail).toContain('workflows:');
  });

  it('errors even when the statuses: block is empty/unparseable (still a colliding source)', async () => {
    // parseStatusConfig returns null for an empty block, so config.statuses would
    // be null — but the physical block is still a second source. Detect it by text.
    await writeConfigMd('statuses:\n');
    const r = await runSingle(configWith({}));
    expect(r.status).toBe('error');
  });

  it('passes with a workflows: map and NO legacy statuses: block', async () => {
    await writeConfigMd('workflows:\n  default:\n    label: Default\n');
    const r = await runSingle(configWith({}));
    expect(r.status).toBe('pass');
  });

  it('passes for a legacy statuses: block with no workflows: map', async () => {
    await writeConfigMd('statuses:\n  definitions:\n    - id: draft\n      label: Draft\n  order:\n    - draft\n');
    const r = await runSingle({ defaultProjectDir: projectsDir, defaultWorkflow: null } as SyntaurConfig);
    expect(r.status).toBe('pass');
  });
});
