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
  GATE_HINTS,
  type GateContext,
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
    status: 'draft',
    priority: 'medium',
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
    assignee: null,
    externalIds: [],
    statusHistory: [],
    depends_on: [],
    links: [],
    blockedReason: null,
    workspace: {
      repository: null,
      branch: null,
      worktreePath: null,
      parentBranch: null,
    },
    tags: [],
    archived: false,
    archivedAt: null,
    archivedReason: null,
    phase: null,
    disposition: null,
    plan: { file: null, approvedDigest: null, approvedAt: null, approvedBy: null },
    parked: false,
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
  deps = new Map<string, 'done' | 'backlog'>(),
): GateContext {
  return {
    ticketDir,
    fm,
    manifest,
    ticketBody: body,
    logEntries: parseLogEntries(log),
    dependencyStages: deps,
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
      '# Plan\n\n## Objective\n\n<!-- placeholder -->\n',
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

  it('handoff-logged passes on any handoff entry (transitional rule)', async () => {
    const manifest = await loadBuiltin('feature');
    const log = `## 2026-09-01T00:00:00Z · handoff · human\n\nBatoning to review.\n`;
    const result = await evaluateGate(
      'handoff-logged',
      ctx(join(home, 't'), baseFm(), manifest, '', log),
    );
    expect(result.pass).toBe(true);
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
});

describe('Next line per built-in stage', () => {
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

  it('quick backlog → syntaur done', async () => {
    expect(await nextFor('quick', 'draft')).toBe('syntaur done X-1');
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
  worktreePath: /tmp/wt
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
