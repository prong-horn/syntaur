import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';
import { loadTemplate } from '../ticket-templates/registry.js';
import {
  computeNextLine,
  evaluateGate,
  evaluateVerbGates,
  freshnessThresholdMs,
  GATE_HINTS,
  type GateContext,
  type MovedEvent,
} from '../ticket-templates/gates.js';
import { parseLogEntries } from '../ticket-templates/log-reader.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import { stageForStatus } from '../ticket-templates/stages.js';
import type { TicketFrontmatter } from '../lifecycle/types.js';
import type { TemplateManifest } from '../ticket-templates/manifest.js';

let home: string;

async function loadBuiltin(id: string): Promise<TemplateManifest> {
  return await loadTemplate(home, id);
}

function baseFm(overrides: Partial<TicketFrontmatter> = {}): TicketFrontmatter {
  return {
    id: 'T-1',
    slug: 't',
    title: 'T',
    project: 'p',
    template: 'feature',
    workflow: null,
    status: 'backlog',
    priority: 'medium',
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
    assignee: null,
    externalIds: [],
    depends_on: [],
    links: [],
    blocked: null,
    workspace: {
      repository: null,
      branch: null,
      worktree: null,
      parentBranch: null,
    },
    tags: [],
    archived: false,
    archivedAt: null,
    archivedReason: null,
    phase: null,
    disposition: null,
    plan: { file: null, approvedDigest: null, approvedAt: null, approvedBy: null },
    parked: null,
    reviewRequested: false,
    reworkRequested: false,
    implementationStarted: false,
    override: null,
    facts: {},
    attestations: [],
    solicitations: [],
    firedVerdicts: [],
    frozenChecks: null,
    hold: false,
    gateOverrides: [],
    ...overrides,
  };
}

function ctx(
  ticketDir: string,
  fm: TicketFrontmatter,
  manifest: TemplateManifest,
  body: string,
  log = '',
  deps = new Map<string, 'done' | 'dropped'>(),
  moves: MovedEvent[] = [],
): GateContext {
  return {
    ticketDir,
    fm,
    manifest,
    ticketBody: body,
    logEntries: parseLogEntries(log),
    dependencyStages: deps,
    moves,
  };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gates-test-'));
  process.env.SYNTAUR_HOME = home;
  await seedMissingBuiltins(home);
});

afterEach(async () => {
  delete process.env.SYNTAUR_HOME;
  await rm(home, { recursive: true, force: true });
});

describe('gate evaluators', () => {
  it('plan-exists passes when the plan file has real content', async () => {
    const ticketDir = join(home, 'ticket');
    await mkdir(ticketDir, { recursive: true });
    await writeFile(
      resolve(ticketDir, 'plan.md'),
      '# Plan\n\nReal objective text here.\n',
      'utf-8',
    );
    const manifest = await loadBuiltin('feature');
    const fm = baseFm({ plan: { ...baseFm().plan, file: 'plan.md' } });
    const result = await evaluateGate('plan-exists', ctx(ticketDir, fm, manifest, ''));
    expect(result.pass).toBe(true);
  });

  it('plan-exists fails on scaffold-only plan', async () => {
    const ticketDir = join(home, 'ticket');
    await mkdir(ticketDir, { recursive: true });
    await writeFile(
      resolve(ticketDir, 'plan.md'),
      '# Plan\n\n**Date:** 2026-04-01\n\n## Objective\n\n<!-- placeholder -->\n',
      'utf-8',
    );
    const manifest = await loadBuiltin('feature');
    const result = await evaluateGate(
      'plan-exists',
      ctx(ticketDir, baseFm(), manifest, ''),
    );
    expect(result.pass).toBe(false);
    expect(result.hint).toBe(GATE_HINTS['plan-exists']);
  });

  it('deps-done treats completed and done as satisfied', async () => {
    const manifest = await loadBuiltin('feature');
    const fm = baseFm({ depends_on: ['A-1', 'B-2'] });
    const done = await evaluateGate(
      'deps-done',
      ctx(join(home, 't'), fm, manifest, '', '', new Map([['A-1', 'done'], ['B-2', 'done']])),
    );
    expect(done.pass).toBe(true);
  });

  it('handoff-logged passes on any handoff when no in_progress/reopen moves exist', async () => {
    const manifest = await loadBuiltin('feature');
    const log = `## 2026-09-01T00:00:00Z · handoff · human\n\nBatoning to review.\n`;
    const result = await evaluateGate(
      'handoff-logged',
      ctx(join(home, 't'), baseFm(), manifest, '', log),
    );
    expect(result.pass).toBe(true);
  });

  it('handoff-logged fails when handoff predates the last move into in_progress', async () => {
    const manifest = await loadBuiltin('feature');
    const log = [
      '## 2026-09-01T00:00:00Z · handoff · human',
      '',
      'Old handoff.',
      '',
      '## 2026-09-03T00:00:00Z · progress · human',
      '',
      'More work.',
    ].join('\n');
    const moves: MovedEvent[] = [
      { at: '2026-09-02T00:00:00Z', from: 'ready', to: 'in_progress', verb: 'start' },
    ];
    const result = await evaluateGate(
      'handoff-logged',
      ctx(join(home, 't'), baseFm(), manifest, '', log, new Map(), moves),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/after the current work cycle/);
  });

  it('handoff-logged passes when handoff body contains a sub-heading', async () => {
    const manifest = await loadBuiltin('feature');
    const log = [
      '## 2026-09-04T00:00:00Z · handoff · human',
      '',
      'Fresh handoff.',
      '',
      '## Summary',
      '',
      'Shipped the API.',
    ].join('\n');
    const result = await evaluateGate(
      'handoff-logged',
      ctx(join(home, 't'), baseFm(), manifest, '', log),
    );
    expect(result.pass).toBe(true);
  });

  it('handoff-logged passes when handoff is after the last reopen', async () => {
    const manifest = await loadBuiltin('feature');
    const log = `## 2026-09-04T00:00:00Z · handoff · human\n\nFresh handoff.\n`;
    const moves: MovedEvent[] = [
      { at: '2026-09-01T00:00:00Z', from: 'ready', to: 'in_progress', verb: 'start' },
      { at: '2026-09-03T00:00:00Z', from: 'done', to: 'review', verb: 'reopen' },
    ];
    const result = await evaluateGate(
      'handoff-logged',
      ctx(join(home, 't'), baseFm(), manifest, '', log, new Map(), moves),
    );
    expect(result.pass).toBe(true);
    expect(freshnessThresholdMs(moves, 'in_progress')).toBe(Date.parse('2026-09-03T00:00:00Z'));
  });

  it('handoff-logged fails when the log has no handoff entry', async () => {
    const manifest = await loadBuiltin('feature');
    const log = `## 2026-09-01T00:00:00Z · progress · human\n\nStill working.\n`;
    const result = await evaluateGate(
      'handoff-logged',
      ctx(join(home, 't'), baseFm(), manifest, '', log),
    );
    expect(result.pass).toBe(false);
    expect(result.hint).toBe(GATE_HINTS['handoff-logged']);
  });

  it('review-clean passes on latest approve with high=0', async () => {
    const manifest = await loadBuiltin('feature');
    const log = `## 2026-09-02T00:00:00Z · review · pi\nverdict: approve · open: high=0 medium=0\n\nClean.\n`;
    const result = await evaluateGate(
      'review-clean',
      ctx(join(home, 't'), baseFm(), manifest, '', log),
    );
    expect(result.pass).toBe(true);
  });

  it('review-clean fails when the latest review predates the last move into review', async () => {
    const manifest = await loadBuiltin('feature');
    const log = `## 2026-09-01T00:00:00Z · review · pi\nverdict: approve · open: high=0 medium=0\n\nStale.\n`;
    const moves: MovedEvent[] = [
      { at: '2026-09-02T00:00:00Z', from: 'in_progress', to: 'review', verb: 'review' },
    ];
    const result = await evaluateGate(
      'review-clean',
      ctx(join(home, 't'), baseFm(), manifest, '', log, new Map(), moves),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/before the current review cycle/);
  });

  it('review-clean passes when review is after reopen into review', async () => {
    const manifest = await loadBuiltin('feature');
    const log = `## 2026-09-04T00:00:00Z · review · pi\nverdict: approve · open: high=0 medium=0\n\nFresh.\n`;
    const moves: MovedEvent[] = [
      { at: '2026-09-02T00:00:00Z', from: 'in_progress', to: 'review', verb: 'review' },
      { at: '2026-09-03T00:00:00Z', from: 'done', to: 'review', verb: 'reopen' },
    ];
    const result = await evaluateGate(
      'review-clean',
      ctx(join(home, 't'), baseFm(), manifest, '', log, new Map(), moves),
    );
    expect(result.pass).toBe(true);
  });

  it('review-clean fails when the latest review verdict is changes', async () => {
    const manifest = await loadBuiltin('feature');
    const log = `## 2026-09-02T00:00:00Z · review · pi\nverdict: changes · open: high=0 medium=0\n\nFix it.\n`;
    const result = await evaluateGate(
      'review-clean',
      ctx(join(home, 't'), baseFm(), manifest, '', log),
    );
    expect(result.pass).toBe(false);
    expect(result.hint).toBe(GATE_HINTS['review-clean']);
  });

  it('review-clean fails when the latest review approves with high=1', async () => {
    const manifest = await loadBuiltin('feature');
    const log = `## 2026-09-02T00:00:00Z · review · pi\nverdict: approve · open: high=1 medium=0\n\nNot clean.\n`;
    const result = await evaluateGate(
      'review-clean',
      ctx(join(home, 't'), baseFm(), manifest, '', log),
    );
    expect(result.pass).toBe(false);
    expect(result.hint).toBe(GATE_HINTS['review-clean']);
  });
});

async function nextFor(
  templateId: string,
  status: string,
  setup?: (ticketDir: string) => Promise<void>,
): Promise<string> {
    const manifest = await loadBuiltin(templateId);
    const ticketDir = join(home, templateId, status);
    await mkdir(ticketDir, { recursive: true });
    const ticketMd = `---
id: X-1
slug: x
title: X
project: p
template: ${templateId}
status: ${status}
priority: medium
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
depends_on: []
links: []
plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null
---

## Objective

Work.

## Acceptance Criteria

- [x] one
`;
    await writeFile(resolve(ticketDir, 'ticket.md'), ticketMd, 'utf-8');
    if (setup) await setup(ticketDir);
    const fm = parseTicketFrontmatter(
      await import('node:fs/promises').then((fs) => fs.readFile(resolve(ticketDir, 'ticket.md'), 'utf-8')),
    );
    const stage = stageForStatus(status);
    const gateCtx = ctx(ticketDir, fm, manifest, '## Acceptance Criteria\n\n- [x] one\n');
    return await computeNextLine('X-1', stage, manifest, gateCtx);
}

describe('Next line per built-in stage', () => {
  it('quick backlog → syntaur done', async () => {
    expect(await nextFor('quick', 'backlog')).toBe('syntaur done X-1');
  });

  it('feature in_progress → syntaur review when gates pass', async () => {
    const next = await nextFor('feature', 'in_progress', async (dir) => {
      const { createHash } = await import('node:crypto');
      const plan = '# Plan\n\nImplemented.\n';
      await writeFile(resolve(dir, 'plan.md'), plan, 'utf-8');
      const digest = createHash('sha256').update(plan, 'utf-8').digest('hex');
      const ticketMd = await import('node:fs/promises').then((fs) =>
        fs.readFile(resolve(dir, 'ticket.md'), 'utf-8'),
      );
      const updated = `${ticketMd.replace(
        'plan:\n  file: null',
        `plan:\n  file: plan.md\n  approvedDigest: ${digest}\n  approvedAt: "2026-01-01T00:00:00Z"\n  approvedBy: human`,
      ).replace(
        'approvedDigest: null\n  approvedAt: null\n  approvedBy: null',
        '',
      )}

workspace:
  repository: /repo
  branch: main
  worktree: /tmp/wt
  parentBranch: main
`;
      await writeFile(resolve(dir, 'ticket.md'), updated, 'utf-8');
      const journal = [
        '## 2026-09-01T00:00:00Z · handoff · human\n\nReady for review.\n',
        '## 2026-09-02T00:00:00Z · review · pi\nverdict: approve · open: high=0 medium=0\n\nok\n',
      ].join('\n');
      await writeFile(resolve(dir, 'journal.md'), journal, 'utf-8');
    });
    expect(next).toBe('syntaur review X-1');
  });
});

describe('all gate ids pass and fail', () => {
  it('plan-approved fails without approval and passes when digest matches', async () => {
    const ticketDir = join(home, 'plan-approved');
    await mkdir(ticketDir, { recursive: true });
    const plan = '# Plan\n\nReal plan body.\n';
    await writeFile(resolve(ticketDir, 'plan.md'), plan, 'utf-8');
    const manifest = await loadBuiltin('feature');
    const fm = baseFm({ plan: { ...baseFm().plan, file: 'plan.md' } });
    const fail = await evaluateGate('plan-approved', ctx(ticketDir, fm, manifest, ''));
    expect(fail.pass).toBe(false);

    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(plan, 'utf-8').digest('hex');
    const approvedFm = baseFm({
      plan: {
        file: 'plan.md',
        approvedDigest: digest,
        approvedAt: '2026-01-01T00:00:00Z',
        approvedBy: 'human',
      },
    });
    const pass = await evaluateGate('plan-approved', ctx(ticketDir, approvedFm, manifest, ''));
    expect(pass.pass).toBe(true);
  });

  it('workspace-set fails until workspace fields are complete', async () => {
    const manifest = await loadBuiltin('feature');
    const fail = await evaluateGate('workspace-set', ctx(join(home, 'ws'), baseFm(), manifest, ''));
    expect(fail.pass).toBe(false);
    const pass = await evaluateGate(
      'workspace-set',
      ctx(
        join(home, 'ws'),
        baseFm({
          workspace: {
            repository: '/repo',
            branch: 'main',
            worktree: '/wt',
            parentBranch: 'main',
          },
        }),
        manifest,
        '',
      ),
    );
    expect(pass.pass).toBe(true);
  });

  it('criteria-checked fails when unchecked criteria remain', async () => {
    const manifest = await loadBuiltin('quick');
    const body = '## Acceptance Criteria\n\n- [ ] ship it\n';
    const fail = await evaluateGate('criteria-checked', ctx(join(home, 'crit'), baseFm(), manifest, body));
    expect(fail.pass).toBe(false);
    const pass = await evaluateGate(
      'criteria-checked',
      ctx(join(home, 'crit'), baseFm(), manifest, '## Acceptance Criteria\n\n- [x] ship it\n'),
    );
    expect(pass.pass).toBe(true);
  });

  it('deliverable-present fails on empty deliverable and passes with content', async () => {
    const manifest = await loadBuiltin('spike');
    const ticketDir = join(home, 'deliverable');
    await mkdir(ticketDir, { recursive: true });
    const role = manifest.files.find((f) => f.role === 'deliverable')!;
    const fail = await evaluateGate('deliverable-present', ctx(ticketDir, baseFm({ template: 'spike' }), manifest, ''));
    expect(fail.pass).toBe(false);
    await writeFile(resolve(ticketDir, role.path), '# Findings\n\nReal findings.\n', 'utf-8');
    const pass = await evaluateGate(
      'deliverable-present',
      ctx(ticketDir, baseFm({ template: 'spike' }), manifest, ''),
    );
    expect(pass.pass).toBe(true);
  });

  it('deps-done ignores dropped dependencies', async () => {
    const manifest = await loadBuiltin('feature');
    const fm = baseFm({ depends_on: ['X-9'] });
    const fail = await evaluateGate(
      'deps-done',
      ctx(join(home, 'deps'), fm, manifest, '', '', new Map([['X-9', 'dropped']])),
    );
    expect(fail.pass).toBe(false);
  });
});

describe('Next line for every built-in stage', () => {
  const matrix: Array<[string, string, string]> = [
    ['feature', 'backlog', 'syntaur plan create X-1'],
    ['feature', 'planning', 'Run syntaur plan create X-1'],
    ['feature', 'ready', GATE_HINTS['plan-approved']],
    ['feature', 'in_progress', 'syntaur review X-1'],
    ['feature', 'review', GATE_HINTS['handoff-logged']],
    ['feature', 'done', 'none (terminal)'],
    ['bug', 'backlog', GATE_HINTS['workspace-set']],
    ['bug', 'in_progress', 'syntaur review X-1'],
    ['bug', 'review', GATE_HINTS['handoff-logged']],
    ['bug', 'done', 'none (terminal)'],
    ['spike', 'backlog', 'syntaur start X-1'],
    ['spike', 'in_progress', GATE_HINTS['deliverable-present']],
    ['spike', 'done', 'none (terminal)'],
    ['quick', 'backlog', 'syntaur done X-1'],
    ['quick', 'done', 'none (terminal)'],
    ['legacy', 'backlog', 'syntaur plan create X-1'],
    ['legacy', 'planning', 'Run syntaur plan create X-1'],
    ['legacy', 'ready', 'syntaur start X-1'],
    ['legacy', 'in_progress', 'syntaur review X-1'],
    ['legacy', 'review', GATE_HINTS['handoff-logged']],
    ['legacy', 'done', 'none (terminal)'],
  ];

  for (const [templateId, status, expected] of matrix) {
    it(`${templateId} ${status} → ${expected}`, async () => {
      expect(await nextFor(templateId, status)).toBe(expected);
    });
  }

  it('off-template stage uses the next declared stage hint', async () => {
    const manifest = await loadBuiltin('quick');
    const ticketDir = join(home, 'off-template');
    await mkdir(ticketDir, { recursive: true });
    const ticketMd = `---
id: X-1
slug: x
title: X
project: p
template: quick
status: planning
priority: medium
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
depends_on: []
links: []
plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null
---

## Objective

Work.

## Acceptance Criteria

- [ ] one
`;
    await writeFile(resolve(ticketDir, 'ticket.md'), ticketMd, 'utf-8');
    const fm = parseTicketFrontmatter(ticketMd);
    const stage = stageForStatus('planning');
    const gateCtx = ctx(ticketDir, fm, manifest, '## Acceptance Criteria\n\n- [ ] one\n');
    const next = await computeNextLine('X-1', stage, manifest, gateCtx);
    expect(next).toBe('syntaur done X-1');
    expect(stage).toBe('planning');
  });
});
