import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  closeEventsDb,
  initEventsDb,
  listEventsByTicket,
  resetEventsDb,
} from '../db/events-db.js';
import {
  flagTicket,
  GateFailedError,
  moveTicket,
  VerbRefusedError,
  type MoveVerb,
} from '../lifecycle/verbs.js';
import { BUILTIN_TEMPLATE_IDS, seedMissingBuiltins } from '../ticket-templates/builtins.js';
import { loadTemplate } from '../ticket-templates/registry.js';
import type { StageId } from '../ticket-templates/manifest.js';
import { stageForStatus } from '../ticket-templates/stages.js';

const MOVE_VERBS: MoveVerb[] = ['plan', 'approve', 'start', 'review', 'done', 'drop', 'reopen'];
const FLAG_VERBS = ['block', 'unblock', 'park', 'unpark'] as const;

let home: string;
let projectsDir: string;
let nextTicketNum = 1;

function nextTicketId(): string {
  return `MX-${nextTicketNum++}`;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'verbs-matrix-'));
  projectsDir = resolve(home, 'projects');
  process.env.SYNTAUR_HOME = home;
  resetEventsDb();
  await writeFile(
    resolve(home, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\n---\n`,
  );
  await seedMissingBuiltins(home);
  initEventsDb(resolve(home, 'syntaur.db'));
  await mkdir(resolve(projectsDir, 'p'), { recursive: true });
  await writeFile(
    resolve(projectsDir, 'p', 'project.md'),
    '---\nslug: p\ntitle: P\nprefix: MX\nnextTicket: 500\n---\n# P\n',
  );
});

afterEach(async () => {
  closeEventsDb();
  resetEventsDb();
  delete process.env.SYNTAUR_HOME;
  await rm(home, { recursive: true, force: true });
});

async function ticketDir(id: string, slug: string): Promise<string> {
  const dir = resolve(projectsDir, 'p', 'tickets', `${id}-${slug}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeTicket(
  templateId: string,
  stage: StageId | 'dropped',
  id: string,
): Promise<string> {
  const dir = await ticketDir(id, `${templateId}-${stage}`);
  const planBody = '# Plan\n\nReal plan body for gates.\n';
  const digest = createHash('sha256').update(planBody, 'utf-8').digest('hex');
  const manifest = await loadTemplate(home, templateId);
  const hasPlan = manifest.files.some((f) => f.role === 'plan');
  const hasLog = manifest.files.some((f) => f.role === 'log');
  const hasDeliverable = manifest.files.some((f) => f.role === 'deliverable');
  const planYaml = hasPlan
    ? `plan:
  file: plan.md
  approvedDigest: ${digest}
  approvedAt: "2026-01-01T00:00:00Z"
  approvedBy: human`
    : `plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null`;
  const workspaceYaml =
    manifest.workspace === 'required'
      ? `workspace:
  repository: /repo
  branch: main
  worktree: /wt
  parentBranch: main`
      : `workspace:
  repository: null
  branch: null
  worktree: null
  parentBranch: null`;
  await writeFile(
    resolve(dir, 'ticket.md'),
    `---
id: ${id}
slug: ${templateId}-${stage}
title: "${templateId} ${stage}"
project: p
template: ${templateId}
status: ${stage}
priority: medium
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
assignee: null
depends_on: []
links: []
blocked: null
parked: null
${planYaml}
${workspaceYaml}
tags: []
---

## Objective

Objective.

## Acceptance Criteria

- [x] one
`,
    'utf-8',
  );
  if (hasPlan) {
    await writeFile(resolve(dir, 'plan.md'), planBody, 'utf-8');
  }
  if (hasLog) {
    await writeFile(
      resolve(dir, 'journal.md'),
      [
        '## 2026-09-01T00:00:00Z · handoff · human',
        '',
        'Ready.',
        '',
        '## 2026-09-02T00:00:00Z · review · pi',
        'verdict: approve · open: high=0 medium=0',
        '',
        'ok',
      ].join('\n'),
      'utf-8',
    );
  }
  if (hasDeliverable) {
    await writeFile(resolve(dir, 'findings.md'), '# Findings\n\nReal findings.\n', 'utf-8');
  }
  return dir;
}

type OutcomeKind = 'moved' | 'refused' | 'gate' | 'flag' | 'noop';

async function tryMove(
  id: string,
  verb: MoveVerb,
  force = false,
): Promise<{ kind: OutcomeKind; message?: string }> {
  try {
    const result = await moveTicket(id, verb, {
      project: 'p',
      dir: projectsDir,
      force,
      reason: verb === 'drop' ? 'matrix drop' : undefined,
      actor: 'human',
    });
    if (result.from === result.to) return { kind: 'noop' };
    return { kind: 'moved' };
  } catch (error) {
    if (error instanceof VerbRefusedError) {
      return { kind: 'refused', message: error.message };
    }
    if (error instanceof GateFailedError) {
      return { kind: 'gate', message: error.message };
    }
    throw error;
  }
}

async function tryFlag(id: string, verb: typeof FLAG_VERBS[number]): Promise<OutcomeKind> {
  try {
    await flagTicket(id, verb, verb === 'unblock' || verb === 'unpark' ? null : 'matrix reason', {
      project: 'p',
      dir: projectsDir,
      actor: 'human',
    });
    return 'flag';
  } catch (error) {
    if (error instanceof VerbRefusedError) return 'refused';
    throw error;
  }
}

describe('verbs matrix — built-in templates × stages × verbs', () => {
  for (const templateId of BUILTIN_TEMPLATE_IDS) {
    describe(templateId, () => {
      it('covers every stage × move verb with force (stage rules)', async () => {
        const manifest = await loadTemplate(home, templateId);
        const stageIds = [...manifest.stages.map((s) => s.id), 'dropped'] as Array<StageId | 'dropped'>;
        for (const stage of stageIds) {
          for (const verb of MOVE_VERBS) {
            const id = nextTicketId();
            await writeTicket(templateId, stage, id);
            const outcome = await tryMove(id, verb, true);
            if (outcome.kind === 'refused') {
              expect(outcome.message).toMatch(/Cannot|template|not a valid ticket id/);
              continue;
            }
            expect(['moved', 'noop']).toContain(outcome.kind);
            if (outcome.kind === 'moved') {
              const events = listEventsByTicket(id).filter((e) => e.type === 'moved');
              expect(events.length).toBe(1);
              const details = JSON.parse(events[0]!.details ?? '{}');
              expect(details.verb).toBe(verb);
              expect(details.forced).toBe(true);
            }
          }
        }
      });

      it('covers every stage × move verb without force (refuse or gate)', async () => {
        const manifest = await loadTemplate(home, templateId);
        const stageIds = [...manifest.stages.map((s) => s.id), 'dropped'] as Array<StageId | 'dropped'>;
        for (const stage of stageIds) {
          for (const verb of MOVE_VERBS) {
            const id = nextTicketId();
            await writeTicket(templateId, stage, id);
            const outcome = await tryMove(id, verb, false);
            expect(['moved', 'refused', 'gate', 'noop']).toContain(outcome.kind);
          }
        }
      });

      it('covers flag verbs on an active stage', async () => {
        const manifest = await loadTemplate(home, templateId);
        const active = manifest.stages.find((s) => s.id !== 'done')?.id ?? 'backlog';
        const id = nextTicketId();
        const dir = await writeTicket(templateId, active, id);
        for (const verb of FLAG_VERBS) {
          const kind = await tryFlag(id, verb);
          expect(['flag', 'refused']).toContain(kind);
        }
        const { parseTicketFrontmatter } = await import('../lifecycle/frontmatter.js');
        const fm = parseTicketFrontmatter(await readFile(resolve(dir, 'ticket.md'), 'utf-8'));
        expect(stageForStatus(fm.status)).toBe(active);
      });
    });
  }
});
