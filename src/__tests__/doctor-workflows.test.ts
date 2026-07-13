import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { workflowsChecks, findWorkflowStructureProblems } from '../utils/doctor/checks/workflows.js';
import { invalidateWorkflowLibraryCache } from '../utils/workflow-library.js';
import type { CheckContext, CheckResult } from '../utils/doctor/types.js';
import type { SyntaurConfig, WorkflowDefinition } from '../utils/config.js';
import type { StageWorkflow } from '../utils/stage-model.js';
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

  it('does NOT false-positive on a column-0 `statuses:` in the markdown body', async () => {
    // The body (after the closing ---) is not the config; the check must mirror
    // parseStatusConfig, which only reads the frontmatter fence. A whole-file
    // /^statuses:/m regex would have wrongly errored here.
    await writeFile(
      join(home, '.syntaur', 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\nworkflows:\n  default:\n    label: Default\n---\n# Notes\n\nstatuses: this is prose, not a config block\n`,
      'utf-8',
    );
    const r = await runSingle(configWith({}));
    expect(r.status).toBe('pass');
  });

  it('does NOT false-positive on an inline `statuses: x` scalar (parser needs an anchored block)', async () => {
    // parseStatusConfig requires `^statuses:\s*$` — an inline scalar is ignored,
    // so it is not a colliding source and must not be flagged.
    await writeConfigMd('workflows:\n  default:\n    label: Default\nstatuses: some-scalar\n');
    const r = await runSingle(configWith({}));
    expect(r.status).toBe('pass');
  });
});

// ── WS-0: per-file stage-workflow structural checks ─────────────────────────

describe('findWorkflowStructureProblems (pure, one PASS + FAIL per rule)', () => {
  const sound: StageWorkflow = {
    id: 'feature',
    stages: [
      { id: 'a', next: [{ to: 'done' }] },
      { id: 'done', terminal: true },
    ],
  };

  it('PASS: a structurally sound workflow has no problems', () => {
    expect(findWorkflowStructureProblems(sound)).toEqual([]);
  });

  it('FAIL: no terminal stage', () => {
    const wf: StageWorkflow = { id: 'w', stages: [{ id: 'a', next: [{ to: 'b' }] }, { id: 'b' }] };
    expect(findWorkflowStructureProblems(wf).some((p) => p.includes('no terminal stage'))).toBe(true);
  });

  it('FAIL: a route targets an unknown stage', () => {
    const wf: StageWorkflow = {
      id: 'w',
      stages: [{ id: 'a', next: [{ to: 'ghost' }] }, { id: 'done', terminal: true }],
    };
    expect(
      findWorkflowStructureProblems(wf).some((p) => p.includes('routes to unknown stage "ghost"')),
    ).toBe(true);
  });

  it('FAIL: an unreachable non-entry stage', () => {
    const wf: StageWorkflow = {
      id: 'w',
      stages: [{ id: 'a', terminal: true }, { id: 'orphan' }],
    };
    expect(findWorkflowStructureProblems(wf).some((p) => p.includes('"orphan" is unreachable'))).toBe(
      true,
    );
  });

  it('FAIL: a gate entry with no check and no condition', () => {
    const wf: StageWorkflow = {
      id: 'w',
      stages: [
        { id: 'a', gate: [{ check: '' }], next: [{ to: 'done' }] },
        { id: 'done', terminal: true },
      ],
    };
    expect(findWorkflowStructureProblems(wf).some((p) => p.includes('no predicate'))).toBe(true);
  });

  it("PASS: a `not:`-only gate entry is a valid predicate (not 'no predicate')", () => {
    const wf: StageWorkflow = {
      id: 'w',
      stages: [
        { id: 'a', gate: [{ check: '', not: 'codeReviewedChangesRequested' }], next: [{ to: 'done' }] },
        { id: 'done', terminal: true },
      ],
    };
    expect(findWorkflowStructureProblems(wf).some((p) => p.includes('no predicate'))).toBe(false);
  });

  it('FAIL: duplicate stage ids (ambiguous stored status)', () => {
    const wf: StageWorkflow = {
      id: 'w',
      stages: [
        { id: 'review', next: [{ to: 'done' }] },
        { id: 'review', terminal: true },
        { id: 'done', terminal: true },
      ],
    };
    expect(
      findWorkflowStructureProblems(wf).some((p) => p.includes('duplicate stage id "review"')),
    ).toBe(true);
  });

  it('FAIL: an auto-advance (on: gate) route cycle', () => {
    const wf: StageWorkflow = {
      id: 'w',
      stages: [
        { id: 'a', next: [{ to: 'b' }] },
        { id: 'b', next: [{ to: 'a' }, { to: 'done' }] },
        { id: 'done', terminal: true },
      ],
    };
    const problems = findWorkflowStructureProblems(wf);
    expect(problems.some((p) => p.includes('route cycle'))).toBe(true);
    // ...and no false unreachable (every stage has an incoming edge or is entry).
    expect(problems.some((p) => p.includes('unreachable'))).toBe(false);
  });

  it('FAIL: a disconnected subgraph is unreachable even though its stages have incoming edges', () => {
    // entry → done (terminal); orphan-a ⇄ orphan-b via manual routes. Every
    // orphan has an incoming edge, so an "any incoming edge" check would miss
    // this — reachability from the entry stage must flag both orphans.
    const wf: StageWorkflow = {
      id: 'w',
      stages: [
        { id: 'entry', next: [{ to: 'done' }] },
        { id: 'done', terminal: true },
        { id: 'oa', next: [{ to: 'ob', on: 'manual' }] },
        { id: 'ob', next: [{ to: 'oa', on: 'manual' }] },
      ],
    };
    const problems = findWorkflowStructureProblems(wf);
    expect(problems.some((p) => p.includes('"oa" is unreachable'))).toBe(true);
    expect(problems.some((p) => p.includes('"ob" is unreachable'))).toBe(true);
  });

  it('does not flag a cycle formed by non-gate (work-start/manual) routes', () => {
    const wf: StageWorkflow = {
      id: 'w',
      stages: [
        { id: 'a', next: [{ to: 'b', on: 'work-start' }] },
        { id: 'b', next: [{ to: 'a', on: 'manual' }, { to: 'done' }] },
        { id: 'done', terminal: true },
      ],
    };
    expect(findWorkflowStructureProblems(wf).some((p) => p.includes('route cycle'))).toBe(false);
  });
});

describe('doctor: workflows.single-workflow-source + workflows.stage-structure', () => {
  const dualCheck = workflowsChecks.find((c) => c.id === 'workflows.single-workflow-source')!;
  const structureCheck = workflowsChecks.find((c) => c.id === 'workflows.stage-structure')!;

  async function writeWorkflowFile(id: string, body: string): Promise<void> {
    // SYNTAUR_HOME is `home`, so the per-file dir is `home/workflows`.
    const dir = join(home, 'workflows');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${id}.md`), body, 'utf-8');
  }

  const noBlock = () =>
    ({ defaultProjectDir: projectsDir, defaultWorkflow: null, workflows: null, statuses: null }) as SyntaurConfig;

  async function runCheck(check: (typeof workflowsChecks)[number], config: SyntaurConfig): Promise<CheckResult> {
    invalidateWorkflowLibraryCache();
    const r = await check.run(ctxFor(config));
    return Array.isArray(r) ? r[0] : r;
  }

  const goodWf = 'id: feature\nstages:\n  - id: a\n    next: [{ to: done }]\n  - id: done\n    terminal: true\n';

  it('single-workflow-source: errors when a per-file dir and a config workflows: block both exist', async () => {
    await writeWorkflowFile('feature', goodWf);
    // configWith supplies a workflows: block → dual source.
    const r = await runCheck(dualCheck, configWith({}));
    expect(r.status).toBe('error');
    expect(r.detail).toContain('config.md');
  });

  it('single-workflow-source: passes when only the per-file dir exists (no config block)', async () => {
    await writeWorkflowFile('feature', goodWf);
    const r = await runCheck(dualCheck, noBlock());
    expect(r.status).toBe('pass');
  });

  it('stage-structure: passes vacuously when no per-file workflows exist', async () => {
    const r = await runCheck(structureCheck, noBlock());
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('no per-file');
  });

  it('stage-structure: passes for a sound per-file workflow', async () => {
    await writeWorkflowFile('feature', goodWf);
    const r = await runCheck(structureCheck, noBlock());
    expect(r.status).toBe('pass');
  });

  it('stage-structure: surfaces parser issues (e.g. a file missing its id)', async () => {
    await writeWorkflowFile('feature', 'stages:\n  - id: done\n    terminal: true\n'); // no id:
    const r = await runCheck(structureCheck, noBlock());
    expect(r.status).toBe('error');
    expect(r.detail).toContain("missing 'id'");
  });

  it('stage-structure: flags a filename≠declared-id mismatch', async () => {
    await writeWorkflowFile('feature', 'id: other\nstages:\n  - id: done\n    terminal: true\n');
    const r = await runCheck(structureCheck, noBlock());
    expect(r.status).toBe('error');
    expect(r.detail).toContain('declares id "other"');
  });

  it('stage-structure: errors for a structurally broken per-file workflow', async () => {
    // No terminal stage + a route to an unknown stage.
    await writeWorkflowFile('broken', 'id: broken\nstages:\n  - id: a\n    next: [{ to: ghost }]\n');
    const r = await runCheck(structureCheck, noBlock());
    expect(r.status).toBe('error');
    expect(r.detail).toContain('no terminal stage');
    expect(r.detail).toContain('unknown stage "ghost"');
  });

  it('stage-structure: skips (not errors) when the library is unreadable (dual source)', async () => {
    await writeWorkflowFile('feature', goodWf);
    const r = await runCheck(structureCheck, configWith({})); // config block + dir → throws
    expect(r.status).toBe('skipped');
  });

  it('stage-structure: WARNS (not errors) for a guarded on: gate cycle', async () => {
    // a ⇄ b via on:gate, both stages GATED → satisfiability unknown → warning
    // (not a hard error). done is reachable via a manual route; terminal exists.
    const guardedCycle =
      'id: cyc\nstages:\n  - id: a\n    gate:\n      - check: x\n    next: [{ to: b }]\n  - id: b\n    gate:\n      - check: y\n    next: [{ to: a }, { to: done, on: manual }]\n  - id: done\n    terminal: true\n';
    await writeWorkflowFile('cyc', guardedCycle);
    const r = await runCheck(structureCheck, noBlock());
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('cycle');
  });

  it('stage-structure: a hard error dominates a co-present warning (error > warn)', async () => {
    // Same guarded cycle (warning) PLUS a route to an unknown stage (error).
    const mixed =
      'id: mixed\nstages:\n  - id: a\n    gate:\n      - check: x\n    next: [{ to: b }]\n  - id: b\n    gate:\n      - check: y\n    next: [{ to: a }, { to: done, on: manual }, { to: ghost, on: manual }]\n  - id: done\n    terminal: true\n';
    await writeWorkflowFile('mixed', mixed);
    const r = await runCheck(structureCheck, noBlock());
    expect(r.status).toBe('error');
    expect(r.detail).toContain('unknown stage "ghost"');
  });
});
