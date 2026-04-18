import { resolve } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { fileExists } from '../../fs.js';
import type { Check, CheckResult } from '../types.js';

const CATEGORY = 'mission';

const REQUIRED_MISSION_FILES = [
  'mission.md',
  'manifest.md',
  'agent.md',
  'claude.md',
  '_status.md',
  '_index-assignments.md',
  '_index-plans.md',
  '_index-decisions.md',
  'resources/_index.md',
  'memories/_index.md',
] as const;

const KNOWN_MISSION_TOP_LEVEL = new Set<string>([
  'mission.md',
  'manifest.md',
  'agent.md',
  'claude.md',
  '_status.md',
  'assignments',
  'resources',
  'memories',
]);

const MISSION_MARKERS = ['mission.md', 'manifest.md', 'agent.md', 'assignments'] as const;

async function listMissions(ctx: { config: { defaultMissionDir: string } }): Promise<string[]> {
  const dir = ctx.config.defaultMissionDir;
  if (!(await fileExists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const result: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const missionDir = resolve(dir, e.name);
    let looksLikeMission = false;
    for (const marker of MISSION_MARKERS) {
      if (await fileExists(resolve(missionDir, marker))) {
        looksLikeMission = true;
        break;
      }
    }
    if (looksLikeMission) result.push(missionDir);
  }
  return result;
}

const requiredFiles: Check = {
  id: 'mission.required-files-present',
  category: CATEGORY,
  title: 'Each mission has the full required scaffold',
  async run(ctx) {
    const missions = await listMissions(ctx);
    const results: CheckResult[] = [];
    for (const missionDir of missions) {
      const missing: string[] = [];
      for (const rel of REQUIRED_MISSION_FILES) {
        const p = resolve(missionDir, rel);
        if (!(await fileExists(p))) missing.push(rel);
      }
      if (missing.length === 0) continue;
      results.push({
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: `mission at ${missionDir} is missing: ${missing.join(', ')}`,
        affected: missing.map((m) => resolve(missionDir, m)),
        remediation: {
          kind: 'manual',
          suggestion: 'Recreate the missing scaffold files from templates',
          command: null,
        },
        autoFixable: false,
      });
    }
    if (results.length === 0) {
      return pass(this);
    }
    return results;
  },
};

const manifestStale: Check = {
  id: 'mission.manifest-stale',
  category: CATEGORY,
  title: 'manifest.md is not older than any assignment change',
  async run(ctx) {
    const missions = await listMissions(ctx);
    const results: CheckResult[] = [];
    for (const missionDir of missions) {
      const manifestPath = resolve(missionDir, 'manifest.md');
      if (!(await fileExists(manifestPath))) continue;
      const manifestMtime = (await stat(manifestPath)).mtimeMs;
      const newestAssignment = await newestAssignmentMtime(missionDir);
      if (newestAssignment === 0) continue;
      if (newestAssignment > manifestMtime) {
        results.push({
          id: this.id,
          category: this.category,
          title: this.title,
          status: 'warn',
          detail: `manifest.md in ${missionDir} is older than the newest assignment.md`,
          affected: [manifestPath],
          remediation: {
            kind: 'manual',
            suggestion: 'Rebuild the manifest (no CLI rebuild helper yet — edit manually or wait for v2)',
            command: null,
          },
          autoFixable: false,
        });
      }
    }
    if (results.length === 0) return pass(this);
    return results;
  },
};

const orphanFiles: Check = {
  id: 'mission.orphan-files',
  category: CATEGORY,
  title: 'No unexpected files at mission top level',
  async run(ctx) {
    const missions = await listMissions(ctx);
    const results: CheckResult[] = [];
    for (const missionDir of missions) {
      const entries = await readdir(missionDir, { withFileTypes: true });
      const orphans: string[] = [];
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        if (KNOWN_MISSION_TOP_LEVEL.has(e.name)) continue;
        if (e.name.startsWith('_index-') && e.name.endsWith('.md')) continue;
        orphans.push(e.name);
      }
      if (orphans.length === 0) continue;
      results.push({
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'warn',
        detail: `mission at ${missionDir} has unexpected entries: ${orphans.join(', ')}`,
        affected: orphans.map((o) => resolve(missionDir, o)),
        autoFixable: false,
      });
    }
    if (results.length === 0) return pass(this);
    return results;
  },
};

export const missionChecks: Check[] = [requiredFiles, manifestStale, orphanFiles];

async function newestAssignmentMtime(missionDir: string): Promise<number> {
  const assignmentsRoot = resolve(missionDir, 'assignments');
  if (!(await fileExists(assignmentsRoot))) return 0;
  let newest = 0;
  let entries;
  try {
    entries = await readdir(assignmentsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const assignmentMd = resolve(assignmentsRoot, e.name, 'assignment.md');
    try {
      const s = await stat(assignmentMd);
      if (s.mtimeMs > newest) newest = s.mtimeMs;
    } catch {
      // no assignment.md — skip (orphan check covers that)
    }
  }
  return newest;
}

function pass(check: { id: string; category: string; title: string }): CheckResult {
  return {
    id: check.id,
    category: check.category,
    title: check.title,
    status: 'pass',
    autoFixable: false,
  };
}
