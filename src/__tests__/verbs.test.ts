import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { newCommand } from '../commands/new.js';
import { createProjectCommand } from '../commands/create-project.js';
import {
  closeEventsDb,
  initEventsDb,
  listEventsByTicket,
  resetEventsDb,
} from '../db/events-db.js';
import { parseTicketFrontmatter, updateTicketWorkspace } from '../lifecycle/frontmatter.js';
import {
  flagTicket,
  GateFailedError,
  moveTicket,
  VerbRefusedError,
} from '../lifecycle/verbs.js';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';
import { renderPlanStub } from '../templates/plan.js';

let home: string;
let projectsDir: string;

beforeEach(async () => {
  home = await mkdtempSafe();
  projectsDir = resolve(home, 'projects');
  process.env.SYNTAUR_HOME = home;
  resetEventsDb();
  await writeFile(
    resolve(home, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\n---\n`,
  );
  await seedMissingBuiltins(home);
  initEventsDb(resolve(home, 'syntaur.db'));
});

afterEach(async () => {
  closeEventsDb();
  resetEventsDb();
  delete process.env.SYNTAUR_HOME;
  await rm(home, { recursive: true, force: true });
});

async function mkdtempSafe(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  const { join: j } = await import('node:path');
  const { tmpdir: td } = await import('node:os');
  return mkdtemp(j(td(), 'syntaur-verbs-'));
}

async function ticketDir(id: string, slug: string): Promise<string> {
  const dir = resolve(projectsDir, 'p', 'tickets', `${id}-${slug}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeFeatureTicket(
  id: string,
  slug: string,
  status: string,
  opts: {
    planBody?: string;
    approved?: boolean;
    workspace?: boolean;
    depends_on?: string[];
  } = {},
): Promise<string> {
  await mkdir(resolve(projectsDir, 'p'), { recursive: true });
  await writeFile(
    resolve(projectsDir, 'p', 'project.md'),
    '---\nslug: p\ntitle: P\nprefix: FE\nnextTicket: 99\n---\n# P\n',
    'utf-8',
  );
  const dir = await ticketDir(id, slug);
  const planBody = opts.planBody ?? '# Plan\n\nReal objective and tasks.\n';
  const digest = createHash('sha256').update(planBody, 'utf-8').digest('hex');
  const workspaceYaml = `workspace:
  repository: null
  worktree: null
  branch: null
  parentBranch: null`;
  const deps =
    opts.depends_on && opts.depends_on.length > 0
      ? `depends_on:\n${opts.depends_on.map((d) => `  - ${d}`).join('\n')}`
      : 'depends_on: []';
  let ticketContent = `---
id: ${id}
slug: ${slug}
title: "${slug}"
project: p
template: feature
status: ${status}
priority: medium
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
assignee: null
${deps}
links: []
blocked: null
parked: null
plan:
  file: plan.md
  approvedDigest: ${opts.approved ? digest : 'null'}
  approvedAt: ${opts.approved ? '"2026-01-01T00:00:00Z"' : 'null'}
  approvedBy: ${opts.approved ? 'human' : 'null'}
${workspaceYaml}
tags: []
---

## Objective

Objective text.

## Acceptance Criteria

- [x] one
`;
  if (opts.workspace) {
    ticketContent = updateTicketWorkspace(ticketContent, {
      repository: '/repo',
      worktree: '/tmp/wt',
      branch: 'main',
      parentBranch: 'main',
    });
  }
  await writeFile(resolve(dir, 'ticket.md'), ticketContent, 'utf-8');
  if (opts.planBody !== undefined || status !== 'backlog') {
    await writeFile(resolve(dir, 'plan.md'), planBody, 'utf-8');
  }
  return dir;
}

describe('feature template verb happy paths', () => {
  it('plan moves backlog → planning', async () => {
    await writeFeatureTicket('FE-1', 'feat', 'backlog', { planBody: undefined });
    const result = await moveTicket('FE-1', 'plan', { project: 'p', dir: projectsDir });
    expect(result).toMatchObject({ from: 'backlog', to: 'planning', verb: 'plan' });
    expect(parseTicketFrontmatter(await readFile(resolve(await ticketDir('FE-1', 'feat'), 'ticket.md'), 'utf-8')).status).toBe('planning');
  });

  it('approve moves planning → ready with plan-approved event', async () => {
    await writeFeatureTicket('FE-2', 'feat2', 'planning');
    const result = await moveTicket('FE-2', 'approve', { project: 'p', dir: projectsDir, agent: 'human' });
    expect(result).toMatchObject({ from: 'planning', to: 'ready', planApproved: true });
    const events = listEventsByTicket('FE-2');
    expect(events.some((e) => e.type === 'plan-approved')).toBe(true);
    expect(events.some((e) => e.type === 'moved')).toBe(true);
  });

  it('start moves ready → in_progress when gates pass', async () => {
    await writeFeatureTicket('FE-3', 'feat3', 'ready', { approved: true, workspace: true });
    const result = await moveTicket('FE-3', 'start', { project: 'p', dir: projectsDir });
    expect(result).toMatchObject({ from: 'ready', to: 'in_progress', verb: 'start' });
  });

  it('review moves in_progress → review', async () => {
    await writeFeatureTicket('FE-4', 'feat4', 'in_progress', { approved: true, workspace: true });
    const result = await moveTicket('FE-4', 'review', { project: 'p', dir: projectsDir });
    expect(result).toMatchObject({ from: 'in_progress', to: 'review', verb: 'review' });
  });

  it('done moves review → done when gates pass (--force)', async () => {
    const dir = await writeFeatureTicket('FE-5', 'feat5', 'review', { approved: true, workspace: true });
    await writeFile(
      resolve(dir, 'journal.md'),
      '## 2026-09-01T00:00:00Z · handoff · human\n\nReady.\n\n## 2026-09-02T00:00:00Z · review · pi\nverdict: approve · open: high=0 medium=0\n\nok\n',
      'utf-8',
    );
    const result = await moveTicket('FE-5', 'done', { project: 'p', dir: projectsDir, force: true });
    expect(result).toMatchObject({ from: 'review', to: 'done', verb: 'done' });
  });

  it('drop moves in_progress → dropped with reason', async () => {
    await writeFeatureTicket('FE-6', 'feat6', 'in_progress', { approved: true, workspace: true });
    const result = await moveTicket('FE-6', 'drop', {
      project: 'p',
      dir: projectsDir,
      reason: 'no longer needed',
      agent: 'human',
    });
    expect(result).toMatchObject({ from: 'in_progress', to: 'dropped', verb: 'drop' });
    const moved = listEventsByTicket('FE-6').find((e) => e.type === 'moved');
    expect(JSON.parse(moved!.details ?? '{}').reason).toBe('no longer needed');
  });

  it('reopen moves done → review', async () => {
    await writeFeatureTicket('FE-7', 'feat7', 'done', { approved: true, workspace: true });
    const result = await moveTicket('FE-7', 'reopen', { project: 'p', dir: projectsDir });
    expect(result).toMatchObject({ from: 'done', to: 'review', verb: 'reopen' });
  });

  it('block/park/unblock/unpark set flags without stage change', async () => {
    await writeFeatureTicket('FE-8', 'feat8', 'in_progress', { approved: true, workspace: true });
    await flagTicket('FE-8', 'block', 'waiting on API', { project: 'p', dir: projectsDir, agent: 'codex' });
    let fm = parseTicketFrontmatter(await readFile(resolve(await ticketDir('FE-8', 'feat8'), 'ticket.md'), 'utf-8'));
    expect(fm.blocked).toBe('waiting on API');
    expect(fm.status).toBe('in_progress');
    await flagTicket('FE-8', 'park', 'on hold', { project: 'p', dir: projectsDir });
    fm = parseTicketFrontmatter(await readFile(resolve(await ticketDir('FE-8', 'feat8'), 'ticket.md'), 'utf-8'));
    expect(fm.parked).toBe('on hold');
    await flagTicket('FE-8', 'unblock', null, { project: 'p', dir: projectsDir });
    await flagTicket('FE-8', 'unpark', null, { project: 'p', dir: projectsDir });
    fm = parseTicketFrontmatter(await readFile(resolve(await ticketDir('FE-8', 'feat8'), 'ticket.md'), 'utf-8'));
    expect(fm.blocked).toBeNull();
    expect(fm.parked).toBeNull();
    const flagged = listEventsByTicket('FE-8').filter((e) => e.type === 'flagged');
    expect(flagged.length).toBeGreaterThanOrEqual(2);
    const blockEvent = flagged.find((e) => JSON.parse(e.details ?? '{}').flag === 'blocked');
    expect(blockEvent?.actor).toBe('codex');
  });
});

describe('refusals and gates', () => {
  it('general rule: wrong stage refuses start from backlog', async () => {
    await writeFeatureTicket('FE-9', 'feat9', 'backlog');
    await expect(moveTicket('FE-9', 'start', { project: 'p', dir: projectsDir })).rejects.toThrow(
      /ticket is in backlog, start applies from ready/,
    );
  });

  it('absent stage: review refused on spike template', async () => {
    await mkdir(resolve(projectsDir, 'p'), { recursive: true });
    await writeFile(resolve(projectsDir, 'p', 'project.md'), '---\nslug: p\ntitle: P\nprefix: SP\nnextTicket: 2\n---\n', 'utf-8');
    const dir = await ticketDir('SP-1', 'spike');
    await writeFile(
      resolve(dir, 'ticket.md'),
      `---
id: SP-1
slug: spike
title: Spike
project: p
template: spike
status: in_progress
priority: medium
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
depends_on: []
links: []
blocked: null
parked: null
plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null
tags: []
---

## Objective

Q?
`,
      'utf-8',
    );
    await expect(moveTicket('SP-1', 'review', { project: 'p', dir: projectsDir })).rejects.toThrow(
      /template spike has no review stage/,
    );
  });

  it('file-only approve on bug leaves stage at backlog', async () => {
    await mkdir(resolve(projectsDir, 'p'), { recursive: true });
    await writeFile(resolve(projectsDir, 'p', 'project.md'), '---\nslug: p\ntitle: P\nprefix: BG\nnextTicket: 2\n---\n', 'utf-8');
    const dir = await ticketDir('BG-1', 'bug');
    const planBody = '# Plan\n\nFix details.\n';
    await writeFile(
      resolve(dir, 'ticket.md'),
      `---
id: BG-1
slug: bug
title: Bug
project: p
template: bug
status: backlog
priority: high
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
depends_on: []
links: []
blocked: null
parked: null
plan:
  file: plan.md
  approvedDigest: null
  approvedAt: null
  approvedBy: null
tags: []
---

## Objective

Fix it.
`,
      'utf-8',
    );
    await writeFile(resolve(dir, 'plan.md'), planBody, 'utf-8');
    const result = await moveTicket('BG-1', 'approve', { project: 'p', dir: projectsDir });
    expect(result.from).toBe('backlog');
    expect(result.to).toBe('backlog');
    const fm = parseTicketFrontmatter(await readFile(resolve(dir, 'ticket.md'), 'utf-8'));
    expect(fm.status).toBe('backlog');
    expect(fm.plan.approvedDigest).toBeTruthy();
  });

  it('approve implies plan-exists even when manifest omits approve gates', async () => {
    const stub = renderPlanStub({ ticketSlug: 'feat10', timestamp: '2026-01-01T00:00:00Z' });
    await writeFeatureTicket('FE-10', 'feat10', 'planning', { planBody: stub });
    await expect(
      moveTicket('FE-10', 'approve', { project: 'p', dir: projectsDir }),
    ).rejects.toBeInstanceOf(GateFailedError);
  });

  it('approve right after plan create throws GateFailedError on plan-exists', async () => {
    const stub = renderPlanStub({ ticketSlug: 'feat20', timestamp: '2026-01-01T00:00:00Z' });
    await writeFeatureTicket('FE-20', 'feat20', 'planning', { planBody: stub });
    await expect(
      moveTicket('FE-20', 'approve', { project: 'p', dir: projectsDir }),
    ).rejects.toBeInstanceOf(GateFailedError);
  });

  it('approve passes when stub plan has a real task line', async () => {
    const stub = renderPlanStub({ ticketSlug: 'feat21', timestamp: '2026-01-01T00:00:00Z' });
    const withTask = stub.replace(
      '## Tasks\n\n<!-- Add the implementation tasks here. -->',
      '## Tasks\n\n- [ ] Implement auth',
    );
    await writeFeatureTicket('FE-21', 'feat21', 'planning', { planBody: withTask });
    const result = await moveTicket('FE-21', 'approve', { project: 'p', dir: projectsDir });
    expect(result.to).toBe('ready');
  });

  it('reason is required for drop, block, and park', async () => {
    await writeFeatureTicket('FE-11', 'feat11', 'in_progress', { approved: true, workspace: true });
    await expect(
      moveTicket('FE-11', 'drop', { project: 'p', dir: projectsDir }),
    ).rejects.toThrow(/reason is required/);
    await expect(
      flagTicket('FE-11', 'block', null, { project: 'p', dir: projectsDir }),
    ).rejects.toBeInstanceOf(VerbRefusedError);
    await expect(
      flagTicket('FE-11', 'park', '  ', { project: 'p', dir: projectsDir }),
    ).rejects.toThrow(/reason is required/);
  });

  it('--force is recorded on the moved event', async () => {
    await writeFeatureTicket('FE-12', 'feat12', 'ready', { approved: true, workspace: false });
    const result = await moveTicket('FE-12', 'start', {
      project: 'p',
      dir: projectsDir,
      force: true,
      agent: 'pi',
    });
    expect(result.forced).toBe(true);
    const moved = listEventsByTicket('FE-12').find((e) => e.type === 'moved');
    expect(moved?.actor).toBe('pi');
    const details = JSON.parse(moved!.details ?? '{}');
    expect(details.forced).toBe(true);
    expect(details.verb).toBe('start');
  });
});

describe('syntaur new', () => {
  it('seeds backlog and emits created', async () => {
    await createProjectCommand('P', { dir: projectsDir });
    const created = await newCommand('Feature work', {
      project: 'p',
      dir: projectsDir,
      template: 'feature',
      silent: true,
    });
    const fm = parseTicketFrontmatter(await readFile(resolve(created.ticketDir, 'ticket.md'), 'utf-8'));
    expect(fm.status).toBe('backlog');
    const events = listEventsByTicket(created.id);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('created');
    expect(events[0].actor).toBe('human');
  });
});
