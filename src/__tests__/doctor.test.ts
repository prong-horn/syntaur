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
let missionsDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'syntaur-doctor-'));
  process.env.HOME = homeDir;
  syntaurDir = resolve(homeDir, '.syntaur');
  missionsDir = resolve(syntaurDir, 'missions');
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await rm(homeDir, { recursive: true, force: true });
});

async function initBaseline(): Promise<void> {
  await mkdir(syntaurDir, { recursive: true });
  await mkdir(missionsDir, { recursive: true });
  await mkdir(resolve(syntaurDir, 'playbooks'), { recursive: true });
  await writeFile(
    resolve(syntaurDir, 'config.md'),
    `---\nversion: "1.0"\ndefaultMissionDir: ${missionsDir}\n---\n`,
  );
}

async function writeMissionScaffold(slug: string): Promise<string> {
  const missionDir = resolve(missionsDir, slug);
  await mkdir(resolve(missionDir, 'assignments'), { recursive: true });
  await mkdir(resolve(missionDir, 'resources'), { recursive: true });
  await mkdir(resolve(missionDir, 'memories'), { recursive: true });
  const files: Array<[string, string]> = [
    [resolve(missionDir, 'mission.md'), `# ${slug}\n`],
    [resolve(missionDir, 'manifest.md'), `# ${slug} manifest\n`],
    [resolve(missionDir, 'agent.md'), `# agent\n`],
    [resolve(missionDir, 'claude.md'), `# claude\n`],
    [resolve(missionDir, '_status.md'), `# status\n`],
    [resolve(missionDir, '_index-assignments.md'), `# index\n`],
    [resolve(missionDir, '_index-plans.md'), `# index\n`],
    [resolve(missionDir, '_index-decisions.md'), `# index\n`],
    [resolve(missionDir, 'resources', '_index.md'), `# index\n`],
    [resolve(missionDir, 'memories', '_index.md'), `# index\n`],
  ];
  for (const [p, c] of files) await writeFile(p, c);
  return missionDir;
}

function assignmentMd(status: string, workspace?: { repository?: string | null; worktreePath?: string | null }): string {
  const repo = workspace?.repository ?? null;
  const wpath = workspace?.worktreePath ?? null;
  return `---
id: 11111111-1111-1111-1111-111111111111
slug: test-assignment
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

# Test Assignment
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
    const missions = byId(report, 'structure.missions-dir');
    expect(missions[0]?.status).toBe('skipped');
  });

  it('passes all structure checks on a freshly initialized root', async () => {
    await initBaseline();
    const report = await runChecks();
    expect(byId(report, 'env.syntaur-root-exists')[0]?.status).toBe('pass');
    expect(byId(report, 'env.config-valid')[0]?.status).toBe('pass');
    expect(byId(report, 'structure.missions-dir')[0]?.status).toBe('pass');
    expect(byId(report, 'structure.playbooks-dir')[0]?.status).toBe('pass');
    expect(byId(report, 'structure.known-files-recognized')[0]?.status).toBe('pass');
  });

  it('detects missing config.md', async () => {
    await mkdir(syntaurDir, { recursive: true });
    await mkdir(missionsDir, { recursive: true });
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

  it('flags workspace-missing for in_progress assignment with null workspace', async () => {
    await initBaseline();
    const missionDir = await writeMissionScaffold('m1');
    const assignmentDir = resolve(missionDir, 'assignments', 'a1');
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(resolve(assignmentDir, 'assignment.md'), assignmentMd('in_progress'));
    const report = await runChecks();
    const issues = byId(report, 'assignment.workspace-missing').filter((c) => c.status === 'error');
    expect(issues.length).toBe(1);
    expect(issues[0].detail).toContain('a1');
    expect(report.summary.error).toBeGreaterThanOrEqual(1);
  });

  it('does not flag workspace-missing for pending or completed assignments', async () => {
    await initBaseline();
    const missionDir = await writeMissionScaffold('m1');
    const pendingDir = resolve(missionDir, 'assignments', 'p');
    const completedDir = resolve(missionDir, 'assignments', 'c');
    await mkdir(pendingDir, { recursive: true });
    await mkdir(completedDir, { recursive: true });
    await writeFile(resolve(pendingDir, 'assignment.md'), assignmentMd('pending'));
    await writeFile(resolve(completedDir, 'assignment.md'), assignmentMd('completed'));
    const report = await runChecks();
    const issues = byId(report, 'assignment.workspace-missing').filter((c) => c.status !== 'pass');
    expect(issues.length).toBe(0);
  });

  it('detects invalid status values', async () => {
    await initBaseline();
    const missionDir = await writeMissionScaffold('m1');
    const assignmentDir = resolve(missionDir, 'assignments', 'bad');
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(resolve(assignmentDir, 'assignment.md'), assignmentMd('not_a_real_status'));
    const report = await runChecks();
    const issues = byId(report, 'assignment.invalid-status').filter((c) => c.status === 'error');
    expect(issues.length).toBe(1);
    expect(issues[0].detail).toContain('not_a_real_status');
  });

  it('detects orphaned assignment folders (no assignment.md)', async () => {
    await initBaseline();
    const missionDir = await writeMissionScaffold('m1');
    await mkdir(resolve(missionDir, 'assignments', 'orphan'), { recursive: true });
    const report = await runChecks();
    const issues = byId(report, 'assignment.orphaned-folder').filter((c) => c.status === 'error');
    expect(issues.length).toBe(1);
  });

  it('detects an incomplete mission scaffold', async () => {
    await initBaseline();
    const missionDir = resolve(missionsDir, 'half-built');
    await mkdir(resolve(missionDir, 'assignments'), { recursive: true });
    await writeFile(resolve(missionDir, 'mission.md'), '# partial\n');
    const report = await runChecks();
    const issues = byId(report, 'mission.required-files-present').filter((c) => c.status === 'error');
    expect(issues.length).toBe(1);
    expect(issues[0].detail).toMatch(/manifest\.md|agent\.md|claude\.md/);
  });

  it('detects a mission folder that has no mission.md at all', async () => {
    await initBaseline();
    const missionDir = resolve(missionsDir, 'only-assignments');
    await mkdir(resolve(missionDir, 'assignments'), { recursive: true });
    const report = await runChecks();
    const issues = byId(report, 'mission.required-files-present').filter((c) => c.status === 'error');
    expect(issues.length).toBe(1);
    expect(issues[0].detail).toContain('mission.md');
  });

  it('does not falsely report manifest-stale for a fresh mission', async () => {
    await initBaseline();
    await writeMissionScaffold('fresh');
    const report = await runChecks();
    const issues = byId(report, 'mission.manifest-stale').filter((c) => c.status === 'warn');
    expect(issues.length).toBe(0);
  });

  it('detects a silent fallback when defaultMissionDir is relative', async () => {
    await mkdir(syntaurDir, { recursive: true });
    await writeFile(
      resolve(syntaurDir, 'config.md'),
      '---\nversion: "1.0"\ndefaultMissionDir: relative/path\n---\n',
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
      `---\nversion: "1.0"\ndefaultMissionDir: ${missionsDir}\nintegrations: brokenvalue\n  claudePluginDir: /some/path\n---\n`,
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
    const resolveCheck = byId(report, 'workspace.context-assignment-resolves')[0];
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
