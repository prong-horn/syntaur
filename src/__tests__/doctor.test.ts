import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runChecks } from '../utils/doctor/index.js';
import { renderJson } from '../utils/doctor/output-json.js';
import { renderHuman } from '../utils/doctor/output-human.js';
import type { DoctorReport } from '../utils/doctor/types.js';

const originalHome = process.env.HOME;
let homeDir: string;
let syntaurDir: string;
let projectsDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'syntaur-doctor-'));
  process.env.HOME = homeDir;
  syntaurDir = resolve(homeDir, '.syntaur');
  projectsDir = resolve(syntaurDir, 'projects');
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await rm(homeDir, { recursive: true, force: true });
});

async function initBaseline(): Promise<void> {
  await mkdir(syntaurDir, { recursive: true });
  await mkdir(projectsDir, { recursive: true });
  await mkdir(resolve(syntaurDir, 'playbooks'), { recursive: true });
  await writeFile(
    resolve(syntaurDir, 'config.md'),
    `---\nversion: "1.0"\ndefaultProjectDir: ${projectsDir}\n---\n`,
  );
}

async function writeProjectScaffold(slug: string): Promise<string> {
  const projectDir = resolve(projectsDir, slug);
  await mkdir(resolve(projectDir, 'tickets'), { recursive: true });
  await mkdir(resolve(projectDir, 'resources'), { recursive: true });
  await mkdir(resolve(projectDir, 'memories'), { recursive: true });
  const files: Array<[string, string]> = [
    [resolve(projectDir, 'project.md'), `# ${slug}\n`],
    [resolve(projectDir, 'manifest.md'), `# ${slug} manifest\n`],
    [resolve(projectDir, 'agent.md'), `# agent\n`],
    [resolve(projectDir, 'claude.md'), `# claude\n`],
    [resolve(projectDir, '_status.md'), `# status\n`],
    [resolve(projectDir, '_index-tickets.md'), `# index\n`],
    [resolve(projectDir, '_index-plans.md'), `# index\n`],
    [resolve(projectDir, '_index-decisions.md'), `# index\n`],
    [resolve(projectDir, 'resources', '_index.md'), `# index\n`],
    [resolve(projectDir, 'memories', '_index.md'), `# index\n`],
  ];
  for (const [p, c] of files) await writeFile(p, c);
  return projectDir;
}

function ticketMd(status: string, workspace?: { repository?: string | null; worktreePath?: string | null }): string {
  const repo = workspace?.repository ?? null;
  const wpath = workspace?.worktreePath ?? null;
  return `---
id: 11111111-1111-1111-1111-111111111111
slug: test-ticket
title: Test
status: ${status}
priority: medium
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
assignee: null
externalIds: []
dependsOn: []
blockedReason: null
workspace:
  repository: ${repo ?? 'null'}
  worktreePath: ${wpath ?? 'null'}
  branch: null
  parentBranch: null
tags: []
---

# Test Ticket
`;
}

function byId(report: DoctorReport, id: string) {
  return report.checks.filter((c) => c.id === id);
}

describe('syntaur doctor', () => {
  it('fails fast when ~/.syntaur/ does not exist', async () => {
    const report = await runChecks();
    expect(report.summary.error).toBeGreaterThanOrEqual(1);
    const root = byId(report, 'env.syntaur-root-exists');
    expect(root[0]?.status).toBe('error');
    const projects = byId(report, 'structure.projects-dir');
    expect(projects[0]?.status).toBe('skipped');
  });

  it('passes all structure checks on a freshly initialized root', async () => {
    await initBaseline();
    const report = await runChecks();
    expect(byId(report, 'env.syntaur-root-exists')[0]?.status).toBe('pass');
    expect(byId(report, 'env.config-valid')[0]?.status).toBe('pass');
    expect(byId(report, 'structure.projects-dir')[0]?.status).toBe('pass');
    expect(byId(report, 'structure.playbooks-dir')[0]?.status).toBe('pass');
    expect(byId(report, 'structure.known-files-recognized')[0]?.status).toBe('pass');
  });

  it('detects missing config.md', async () => {
    await mkdir(syntaurDir, { recursive: true });
    await mkdir(projectsDir, { recursive: true });
    await mkdir(resolve(syntaurDir, 'playbooks'), { recursive: true });
    const report = await runChecks();
    const configCheck = byId(report, 'env.config-valid')[0];
    expect(configCheck?.status).toBe('error');
    expect(configCheck?.detail).toContain('not found');
  });

  it('flags unexpected top-level entries as a warning', async () => {
    await initBaseline();
    await mkdir(resolve(syntaurDir, 'not-a-known-dir'));
    const report = await runChecks();
    const orphans = byId(report, 'structure.known-files-recognized')[0];
    expect(orphans?.status).toBe('warn');
    expect(orphans?.detail).toContain('not-a-known-dir');
  });

  it('passes known-files-recognized when every allowlisted name is present', async () => {
    await initBaseline();
    const { KNOWN_TOP_LEVEL } = await import('../utils/doctor/checks/structure.js');
    for (const name of KNOWN_TOP_LEVEL) {
      const target = resolve(syntaurDir, name);
      if (name.endsWith('.json') || name.endsWith('.md') || name.includes('.')) {
        await writeFile(target, '');
      } else {
        await mkdir(target, { recursive: true });
      }
    }
    const report = await runChecks();
    expect(byId(report, 'structure.known-files-recognized')[0]?.status).toBe('pass');
  });

  it('warns on stale backup and corrupt view-prefs files by name', async () => {
    await initBaseline();
    await writeFile(resolve(syntaurDir, 'syntaur.db.pre-v11.bak'), '');
    await writeFile(resolve(syntaurDir, 'view-prefs.corrupt-1.json'), '{}');
    const report = await runChecks();
    const orphans = byId(report, 'structure.known-files-recognized')[0];
    expect(orphans?.status).toBe('warn');
    expect(orphans?.detail).toContain('syntaur.db.pre-v11.bak');
    expect(orphans?.detail).toContain('view-prefs.corrupt-1.json');
  });

  it('flags workspace-missing for in_progress ticket with null workspace', async () => {
    await initBaseline();
    const projectDir = await writeProjectScaffold('m1');
    const ticketDir = resolve(projectDir, 'tickets', 'a1');
    await mkdir(ticketDir, { recursive: true });
    await writeFile(resolve(ticketDir, 'ticket.md'), ticketMd('in_progress'));
    const report = await runChecks();
    const issues = byId(report, 'ticket.workspace-missing').filter((c) => c.status === 'error');
    expect(issues.length).toBe(1);
    expect(issues[0].detail).toContain('a1');
    expect(report.summary.error).toBeGreaterThanOrEqual(1);
  });

  it('does not flag workspace-missing for pending or completed tickets', async () => {
    await initBaseline();
    const projectDir = await writeProjectScaffold('m1');
    const pendingDir = resolve(projectDir, 'tickets', 'p');
    const completedDir = resolve(projectDir, 'tickets', 'c');
    await mkdir(pendingDir, { recursive: true });
    await mkdir(completedDir, { recursive: true });
    await writeFile(resolve(pendingDir, 'ticket.md'), ticketMd('pending'));
    await writeFile(resolve(completedDir, 'ticket.md'), ticketMd('completed'));
    const report = await runChecks();
    const issues = byId(report, 'ticket.workspace-missing').filter((c) => c.status !== 'pass');
    expect(issues.length).toBe(0);
  });

  it('does not flag workspace-missing for draft, ready_for_planning, or ready_to_implement', async () => {
    await initBaseline();
    const projectDir = await writeProjectScaffold('m1');
    for (const status of ['draft', 'ready_for_planning', 'ready_to_implement']) {
      const dir = resolve(projectDir, 'tickets', status);
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, 'ticket.md'), ticketMd(status));
    }
    const report = await runChecks();
    const issues = byId(report, 'ticket.workspace-missing').filter((c) => c.status !== 'pass');
    expect(issues.length).toBe(0);
  });

  it('flags draft-missing-objective when a draft has an empty Objective', async () => {
    await initBaseline();
    const projectDir = await writeProjectScaffold('m1');
    const dir = resolve(projectDir, 'tickets', 'empty-draft');
    await mkdir(dir, { recursive: true });
    // Build a ticket with explicit empty Objective body
    const md = `---\nid: 22222222-2222-2222-2222-222222222222\nslug: empty-draft\ntitle: Empty\nstatus: draft\npriority: medium\ncreated: "2026-01-01T00:00:00Z"\nupdated: "2026-01-01T00:00:00Z"\nassignee: null\nexternalIds: []\ndependsOn: []\nblockedReason: null\nworkspace:\n  repository: null\n  worktreePath: null\n  branch: null\n  parentBranch: null\ntags: []\n---\n\n# Empty\n\n## Objective\n\n## Acceptance Criteria\n\n- [ ] <!-- criterion 1 -->\n`;
    await writeFile(resolve(dir, 'ticket.md'), md);
    const report = await runChecks();
    const issues = byId(report, 'ticket.draft-missing-objective').filter((c) => c.status === 'warn');
    expect(issues.length).toBe(1);
    expect(issues[0].detail).toContain('empty-draft');
  });

  it('does not flag draft-missing-objective when Objective has real content', async () => {
    await initBaseline();
    const projectDir = await writeProjectScaffold('m1');
    const dir = resolve(projectDir, 'tickets', 'real-draft');
    await mkdir(dir, { recursive: true });
    const md = `---\nid: 33333333-3333-3333-3333-333333333333\nslug: real-draft\ntitle: Real\nstatus: draft\npriority: medium\ncreated: "2026-01-01T00:00:00Z"\nupdated: "2026-01-01T00:00:00Z"\nassignee: null\nexternalIds: []\ndependsOn: []\nblockedReason: null\nworkspace:\n  repository: null\n  worktreePath: null\n  branch: null\n  parentBranch: null\ntags: []\n---\n\n# Real\n\n## Objective\n\nThis is a real objective with actual content describing the work.\n\n## Acceptance Criteria\n\n- [ ] something concrete\n`;
    await writeFile(resolve(dir, 'ticket.md'), md);
    const report = await runChecks();
    const issues = byId(report, 'ticket.draft-missing-objective').filter((c) => c.status !== 'pass');
    expect(issues.length).toBe(0);
  });

  it('flags ready-to-implement-missing-plan when plan.md is missing', async () => {
    await initBaseline();
    const projectDir = await writeProjectScaffold('m1');
    const dir = resolve(projectDir, 'tickets', 'no-plan');
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, 'ticket.md'), ticketMd('ready_to_implement'));
    const report = await runChecks();
    const issues = byId(report, 'ticket.ready-to-implement-missing-plan').filter((c) => c.status === 'warn');
    expect(issues.length).toBe(1);
    expect(issues[0].detail).toContain('no-plan');
  });

  it('does not flag ready-to-implement-missing-plan when plan.md has content', async () => {
    await initBaseline();
    const projectDir = await writeProjectScaffold('m1');
    const dir = resolve(projectDir, 'tickets', 'has-plan');
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, 'ticket.md'), ticketMd('ready_to_implement'));
    await writeFile(resolve(dir, 'plan.md'), '# Plan\n\nSome plan content.\n');
    const report = await runChecks();
    const issues = byId(report, 'ticket.ready-to-implement-missing-plan').filter((c) => c.status !== 'pass');
    expect(issues.length).toBe(0);
  });

  it('detects invalid status values', async () => {
    await initBaseline();
    const projectDir = await writeProjectScaffold('m1');
    const ticketDir = resolve(projectDir, 'tickets', 'bad');
    await mkdir(ticketDir, { recursive: true });
    await writeFile(resolve(ticketDir, 'ticket.md'), ticketMd('not_a_real_status'));
    const report = await runChecks();
    const issues = byId(report, 'ticket.invalid-status').filter((c) => c.status === 'error');
    expect(issues.length).toBe(1);
    expect(issues[0].detail).toContain('not_a_real_status');
  });

  it('detects orphaned ticket folders (no ticket.md)', async () => {
    await initBaseline();
    const projectDir = await writeProjectScaffold('m1');
    await mkdir(resolve(projectDir, 'tickets', 'orphan'), { recursive: true });
    const report = await runChecks();
    const issues = byId(report, 'ticket.orphaned-folder').filter((c) => c.status === 'error');
    expect(issues.length).toBe(1);
  });

  it('detects an incomplete project scaffold', async () => {
    await initBaseline();
    const projectDir = resolve(projectsDir, 'half-built');
    await mkdir(resolve(projectDir, 'tickets'), { recursive: true });
    await writeFile(resolve(projectDir, 'project.md'), '# partial\n');
    const report = await runChecks();
    const issues = byId(report, 'project.required-files-present').filter((c) => c.status === 'error');
    expect(issues.length).toBe(1);
    expect(issues[0].detail).toMatch(/manifest\.md|agent\.md|claude\.md/);
  });

  it('detects a project folder that has no project.md at all', async () => {
    await initBaseline();
    const projectDir = resolve(projectsDir, 'only-tickets');
    await mkdir(resolve(projectDir, 'tickets'), { recursive: true });
    const report = await runChecks();
    const issues = byId(report, 'project.required-files-present').filter((c) => c.status === 'error');
    expect(issues.length).toBe(1);
    expect(issues[0].detail).toContain('project.md');
  });

  it('does not falsely report manifest-stale for a fresh project', async () => {
    await initBaseline();
    await writeProjectScaffold('fresh');
    const report = await runChecks();
    const issues = byId(report, 'project.manifest-stale').filter((c) => c.status === 'warn');
    expect(issues.length).toBe(0);
  });

  it('allows existing resources/ and memories/ folders without _index.md', async () => {
    await initBaseline();
    const projectDir = resolve(projectsDir, 'legacy-knowledge');
    await mkdir(resolve(projectDir, 'tickets'), { recursive: true });
    await mkdir(resolve(projectDir, 'resources'), { recursive: true });
    await mkdir(resolve(projectDir, 'memories'), { recursive: true });
    const files: Array<[string, string]> = [
      [resolve(projectDir, 'project.md'), `# legacy\n`],
      [resolve(projectDir, 'manifest.md'), `# manifest\n`],
      [resolve(projectDir, '_status.md'), `# status\n`],
      [resolve(projectDir, '_index-tickets.md'), `# index\n`],
      [resolve(projectDir, '_index-plans.md'), `# index\n`],
      [resolve(projectDir, '_index-decisions.md'), `# index\n`],
    ];
    for (const [p, c] of files) await writeFile(p, c);

    const report = await runChecks();
    expect(
      byId(report, 'project.required-files-present').filter((c) => c.status === 'error'),
    ).toHaveLength(0);
    expect(byId(report, 'project.orphan-files').filter((c) => c.status === 'warn')).toHaveLength(0);
  });

  it('detects a silent fallback when defaultProjectDir is relative', async () => {
    await mkdir(syntaurDir, { recursive: true });
    await writeFile(
      resolve(syntaurDir, 'config.md'),
      '---\nversion: "1.0"\ndefaultProjectDir: relative/path\n---\n',
    );
    const report = await runChecks();
    const configCheck = byId(report, 'env.config-valid')[0];
    expect(configCheck?.status).toBe('error');
    expect(configCheck?.detail).toMatch(/absolute|fell back/i);
  });

  it('detects malformed nested integrations frontmatter (broken indentation)', async () => {
    await mkdir(syntaurDir, { recursive: true });
    // Nested field present at wrong indent level — readNestedField still finds it via regex
    // but parseFrontmatter in config.ts drops it because it's preceded by a non-empty parent value.
    await writeFile(
      resolve(syntaurDir, 'config.md'),
      `---\nversion: "1.0"\ndefaultProjectDir: ${projectsDir}\nintegrations: brokenvalue\n  claudePluginDir: /some/path\n---\n`,
    );
    const report = await runChecks();
    const configCheck = byId(report, 'env.config-valid')[0];
    expect(configCheck?.status).toBe('error');
    expect(configCheck?.detail).toMatch(/integrations/i);
  });

  it('accepts a standalone-session context.json', async () => {
    await initBaseline();
    const cwd = await mkdtemp(join(tmpdir(), 'syntaur-doctor-cwd-'));
    await mkdir(resolve(cwd, '.syntaur'), { recursive: true });
    await writeFile(resolve(cwd, '.syntaur', 'context.json'), JSON.stringify({ sessionId: 'abc' }));
    const report = await runChecks({ cwd });
    const validCheck = byId(report, 'workspace.context-valid')[0];
    const resolveCheck = byId(report, 'workspace.context-ticket-resolves')[0];
    const terminalCheck = byId(report, 'workspace.context-terminal')[0];
    expect(validCheck?.status).toBe('pass');
    expect(resolveCheck?.status).toBe('skipped');
    expect(terminalCheck?.status).toBe('skipped');
    await rm(cwd, { recursive: true, force: true });
  });

  it('produces stable JSON output shape', async () => {
    await initBaseline();
    const report = await runChecks();
    const json = renderJson(report);
    const parsed = JSON.parse(json) as DoctorReport;
    expect(parsed.version).toBe('1.0');
    expect(parsed.summary).toEqual({
      pass: expect.any(Number),
      warn: expect.any(Number),
      error: expect.any(Number),
      skipped: expect.any(Number),
    });
    for (const c of parsed.checks) {
      expect(c).toHaveProperty('id');
      expect(c).toHaveProperty('category');
      expect(c).toHaveProperty('title');
      expect(c).toHaveProperty('status');
      expect(c).toHaveProperty('autoFixable');
    }
  });

  it('human output renders without crashing', async () => {
    await initBaseline();
    const report = await runChecks();
    const text = renderHuman(report, { verbose: true });
    expect(text).toContain('syntaur doctor');
    expect(text).toContain('summary:');
  });

  it('--only filters to a single check', async () => {
    await initBaseline();
    const report = await runChecks({ only: 'env.config-valid' });
    expect(report.checks.every((c) => c.id === 'env.config-valid')).toBe(true);
  });
});
