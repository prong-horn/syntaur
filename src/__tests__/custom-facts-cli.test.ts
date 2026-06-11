import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], home: string): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: { ...process.env, SYNTAUR_HOME: home },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

// A custom status set with a `shipped` rung gated on a custom bool + an
// attestation (binds:plan), and a `deployed` rung gated on a binds:commit
// attestation. The whole derive block must be present (parseStatusConfig is
// all-or-nothing once `statuses:` exists).
function configMd(projectsDir: string): string {
  return `---
version: "2.0"
defaultProjectDir: ${projectsDir}
statuses:
  definitions:
    - id: draft
      label: Draft
    - id: ready_for_planning
      label: Ready for Planning
    - id: ready_to_implement
      label: Ready to Implement
    - id: in_progress
      label: In Progress
    - id: review
      label: Review
    - id: shipped
      label: Shipped
    - id: deployed
      label: Deployed
    - id: blocked
      label: Blocked
    - id: completed
      label: Completed
      terminal: true
    - id: failed
      label: Failed
      terminal: true
  order:
    - draft
    - ready_for_planning
    - ready_to_implement
    - in_progress
    - review
    - shipped
    - deployed
    - blocked
    - completed
    - failed
  facts:
    - name: qaPassed
      type: bool
    - name: storyPoints
      type: number
    - name: codeReview
      type: attestation
      binds: plan
    - name: deploy
      type: attestation
      binds: commit
  phaseLadder:
    - phase: draft
      when: "*"
    - phase: ready_for_planning
      when: "hasRealObjective:true AND acRealTotal > 0"
    - phase: ready_to_implement
      when: "planApproved:true"
    - phase: in_progress
      when: "planApproved:true AND implementationStarted:true"
    - phase: review
      when: "acAllChecked:true OR reviewRequested:true"
    - phase: shipped
      when: "qaPassed:true AND codeReviewApproved:true"
    - phase: deployed
      when: "deployApproved:true"
  disposition:
    - when: "blocked:true"
      is: blocked
    - else: active
  headline:
    terminal: passthrough
    parked: blocked
    blocked: blocked
    active: phase
---
`;
}

const ASSIGNMENT = (repoPath: string) => `---
id: feat-x-id
slug: feat-x
title: "Feat X"
project: p1
status: draft
priority: medium
created: "2026-06-09T10:00:00Z"
updated: "2026-06-09T10:00:00Z"
assignee: null
externalIds: []
dependsOn: []
links: []
blockedReason: null
workspace:
  repository: ${repoPath}
  worktreePath: null
  branch: feat/x
  parentBranch: main
tags: []
---

# Feat X

## Objective

A real objective.

## Acceptance Criteria

- [ ] Criterion one
- [ ] Criterion two
`;

describe('custom facts + attestations CLI (end-to-end)', () => {
  let home: string;
  let aDir: string;
  let assignmentPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-cf-'));
    await writeFile(join(home, 'config.md'), configMd(resolve(home, 'projects')));
    aDir = join(home, 'projects', 'p1', 'assignments', 'feat-x');
    await mkdir(aDir, { recursive: true });
    await writeFile(join(home, 'projects', 'p1', 'project.md'), '---\nslug: p1\n---\n# P1\n');
    assignmentPath = join(aDir, 'assignment.md');
    await writeFile(assignmentPath, ASSIGNMENT('/repo'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function fm() {
    return parseAssignmentFrontmatter(await readFile(assignmentPath, 'utf-8'));
  }

  it('AC7 forward + reverse: fact set + attest fire the rung; replan regresses it', async () => {
    expect((await runCli(['recompute', 'feat-x', '--project', 'p1'], home)).code).toBe(0);
    expect((await fm()).status).toBe('ready_for_planning');

    await writeFile(join(aDir, 'plan.md'), '# Plan v1');
    await runCli(['plan', 'approve', 'feat-x', '--project', 'p1'], home);
    await runCli(['implement', 'feat-x', '--project', 'p1'], home);
    expect((await fm()).status).toBe('in_progress');

    // custom bool fact alone is not enough (codeReview not approved)
    let r = await runCli(['fact', 'set', 'feat-x', 'qaPassed', 'true', '--project', 'p1'], home);
    expect(r.code).toBe(0);
    expect((await fm()).status).toBe('in_progress');
    expect((await fm()).facts.qaPassed).toBe('true');

    // attest the plan-bound review → shipped rung fires
    r = await runCli(['attest', 'feat-x', 'codeReview', '--verdict', 'approved', '--agent', 'codex', '--project', 'p1'], home);
    expect(r.code).toBe(0);
    expect((await fm()).status).toBe('shipped');
    const att = (await fm()).attestations;
    expect(att).toHaveLength(1);
    expect(att[0]).toMatchObject({ fact: 'codeReview', actor: 'agent:codex', verdict: 'approved', file: 'plan.md' });
    expect(att[0].digest).toBeTruthy();

    // replan: editing the plan invalidates the digest binding — which voids
    // BOTH the codeReview attestation AND the plan approval (both are plan-digest
    // bound) → recompute regresses past shipped all the way to ready_for_planning.
    await writeFile(join(aDir, 'plan.md'), '# Plan v1 EDITED');
    expect((await runCli(['recompute', 'feat-x', '--project', 'p1'], home)).code).toBe(0);
    expect((await fm()).status).toBe('ready_for_planning'); // shipped lost
  });

  it('re-attest replaces the actor record; default verdict is approved', async () => {
    await runCli(['recompute', 'feat-x', '--project', 'p1'], home);
    await writeFile(join(aDir, 'plan.md'), '# Plan');
    await runCli(['attest', 'feat-x', 'codeReview', '--agent', 'codex', '--verdict', 'changes-requested', '--project', 'p1'], home);
    await runCli(['attest', 'feat-x', 'codeReview', '--agent', 'codex', '--project', 'p1'], home); // default approved, replaces
    const att = (await fm()).attestations.filter((a) => a.actor === 'agent:codex');
    expect(att).toHaveLength(1);
    expect(att[0].verdict).toBe('approved');
  });

  it('binds:commit attestation goes stale after a new commit', async () => {
    // Real git repo as the workspace
    const repo = await mkdtemp(join(tmpdir(), 'syntaur-cf-repo-'));
    const git = (args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf-8' });
    git(['init', '-q']);
    git(['config', 'user.email', 't@t.t']);
    git(['config', 'user.name', 'T']);
    await writeFile(join(repo, 'a.txt'), 'one');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'one']);
    await writeFile(assignmentPath, ASSIGNMENT(repo));

    try {
      await runCli(['recompute', 'feat-x', '--project', 'p1'], home);
      let r = await runCli(['attest', 'feat-x', 'deploy', '--agent', 'ci', '--project', 'p1'], home);
      expect(r.code).toBe(0);
      const att = (await fm()).attestations.find((a) => a.fact === 'deploy')!;
      expect(att.commit).toBeTruthy();
      // valid now → deployed rung fires (deployApproved:true)
      expect((await fm()).status).toBe('deployed');

      // new commit → HEAD moves → attestation stale → recompute regresses
      await writeFile(join(repo, 'a.txt'), 'two');
      git(['add', '.']);
      git(['commit', '-q', '-m', 'two']);
      await runCli(['recompute', 'feat-x', '--project', 'p1'], home);
      expect((await fm()).status).not.toBe('deployed');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('binds:commit attest refuses when the workspace is not a git repo', async () => {
    await writeFile(assignmentPath, ASSIGNMENT('/definitely/not/a/repo'));
    await runCli(['recompute', 'feat-x', '--project', 'p1'], home);
    const r = await runCli(['attest', 'feat-x', 'deploy', '--agent', 'ci', '--project', 'p1'], home);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/not a git repo|workspace/i);
  });

  it('errors: undeclared fact, type mismatch, non-attestation attest, bad verdict', async () => {
    await runCli(['recompute', 'feat-x', '--project', 'p1'], home);

    let r = await runCli(['fact', 'set', 'feat-x', 'bogus', 'true', '--project', 'p1'], home);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/not a declared custom fact/i);

    r = await runCli(['fact', 'set', 'feat-x', 'qaPassed', 'notabool', '--project', 'p1'], home);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/not a valid bool/i);

    r = await runCli(['attest', 'feat-x', 'qaPassed', '--project', 'p1'], home); // qaPassed is bool, not attestation
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/not a declared attestation/i);

    await writeFile(join(aDir, 'plan.md'), '# Plan');
    r = await runCli(['attest', 'feat-x', 'codeReview', '--verdict', 'maybe', '--project', 'p1'], home);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/invalid verdict/i);
  });

  it('verbs run against a PRE-migration home (explicit verbs are not marker-gated)', async () => {
    // No `derive-migrated` marker was ever written by this test.
    const r = await runCli(['fact', 'set', 'feat-x', 'qaPassed', 'true', '--project', 'p1'], home);
    expect(r.code).toBe(0);
    expect((await fm()).facts.qaPassed).toBe('true');
  });

  it('ALL seven status mutations preserve statuses.facts; init --force drops them', async () => {
    const { parseStatusConfig } = await import('../utils/config.js');
    const cfgPath = join(home, 'config.md');
    const EXPECT = ['qaPassed', 'storyPoints', 'codeReview', 'deploy'];
    const facts = async () =>
      (parseStatusConfig(await readFile(cfgPath, 'utf-8'))!.facts ?? []).map((f) => f.name);
    const order = async () => parseStatusConfig(await readFile(cfgPath, 'utf-8'))!.order;

    expect(await facts()).toEqual(EXPECT);

    // 1. add  2. set  3. reorder  4. transition add  5. transition remove
    // 6. remove  7. rename — none may silently delete the facts block.
    expect((await runCli(['status', 'add', 'qa', '--label', 'QA', '--at-end'], home)).code).toBe(0);
    expect(await facts()).toEqual(EXPECT);

    expect((await runCli(['status', 'set', '--id', 'draft', '--label', 'Draft X'], home)).code).toBe(0);
    expect(await facts()).toEqual(EXPECT);

    expect((await runCli(['status', 'reorder', [...(await order())].reverse().join(',')], home)).code).toBe(0);
    expect(await facts()).toEqual(EXPECT);

    expect(
      (await runCli(['status', 'transition', 'add', '--from', 'draft', '--command', 'go', '--to', 'in_progress'], home)).code,
    ).toBe(0);
    expect(await facts()).toEqual(EXPECT);

    expect(
      (await runCli(['status', 'transition', 'remove', '--from', 'draft', '--command', 'go'], home)).code,
    ).toBe(0);
    expect(await facts()).toEqual(EXPECT);

    expect((await runCli(['status', 'remove', 'deployed'], home)).code).toBe(0);
    expect(await facts()).toEqual(EXPECT);

    expect((await runCli(['status', 'rename', 'blocked', '--to', 'on_hold'], home)).code).toBe(0);
    expect(await facts()).toEqual(EXPECT);

    // init --force is intentionally destructive (resets to defaults; drops facts)
    expect((await runCli(['status', 'init', '--force'], home)).code).toBe(0);
    expect(parseStatusConfig(await readFile(cfgPath, 'utf-8'))!.facts ?? null).toBeNull();
  });

  it('AC9: a dimension-stable fact set appends a same-status audit entry + bumps updated', async () => {
    await runCli(['recompute', 'feat-x', '--project', 'p1'], home);
    const before = await fm();
    const beforeCount = before.statusHistory.length;

    // storyPoints is in no rung → guaranteed dimension-stable mutation.
    const r = await runCli(['fact', 'set', 'feat-x', 'storyPoints', '5', '--project', 'p1'], home);
    expect(r.code).toBe(0);
    const after = await fm();
    const newEntries = after.statusHistory.slice(beforeCount);
    expect(newEntries).toHaveLength(1);
    expect(newEntries[0]).toMatchObject({
      command: 'fact-set',
      from: after.status,
      to: after.status,
    });
    expect(newEntries[0].by).toBeTruthy();
    // no phase/disposition keys on a same-status audit entry
    expect(newEntries[0].phaseFrom).toBeUndefined();
    // `updated` was bumped to the audit entry's timestamp (second-resolution, so
    // assert equality with the entry's `at` rather than strict inequality).
    expect(after.updated).toBe(newEntries[0].at);

    // a no-op repeat (same value) writes nothing new
    await runCli(['fact', 'set', 'feat-x', 'storyPoints', '5', '--project', 'p1'], home);
    expect((await fm()).statusHistory.length).toBe(after.statusHistory.length);
  });
});
