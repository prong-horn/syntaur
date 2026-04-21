import { resolve } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { fileExists } from '../../fs.js';
import type { Check, CheckResult } from '../types.js';

const CATEGORY = 'project';

const REQUIRED_PROJECT_FILES = [
  'project.md',
  'manifest.md',
  '_status.md',
  '_index-assignments.md',
  '_index-plans.md',
  '_index-decisions.md',
  'resources/_index.md',
  'memories/_index.md',
] as const;

const KNOWN_PROJECT_TOP_LEVEL = new Set<string>([
  'project.md',
  'manifest.md',
  '_status.md',
  'assignments',
  'resources',
  'memories',
]);

const PROJECT_MARKERS = ['project.md', 'manifest.md', 'assignments'] as const;

async function listProjects(ctx: { config: { defaultProjectDir: string } }): Promise<string[]> {
  const dir = ctx.config.defaultProjectDir;
  if (!(await fileExists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const result: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const projectDir = resolve(dir, e.name);
    let looksLikeProject = false;
    for (const marker of PROJECT_MARKERS) {
      if (await fileExists(resolve(projectDir, marker))) {
        looksLikeProject = true;
        break;
      }
    }
    if (looksLikeProject) result.push(projectDir);
  }
  return result;
}

const requiredFiles: Check = {
  id: 'project.required-files-present',
  category: CATEGORY,
  title: 'Each project has the full required scaffold',
  async run(ctx) {
    const projects = await listProjects(ctx);
    const results: CheckResult[] = [];
    for (const projectDir of projects) {
      const missing: string[] = [];
      for (const rel of REQUIRED_PROJECT_FILES) {
        const p = resolve(projectDir, rel);
        if (!(await fileExists(p))) missing.push(rel);
      }
      if (missing.length === 0) continue;
      results.push({
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: `project at ${projectDir} is missing: ${missing.join(', ')}`,
        affected: missing.map((m) => resolve(projectDir, m)),
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
  id: 'project.manifest-stale',
  category: CATEGORY,
  title: 'manifest.md is not older than any assignment change',
  async run(ctx) {
    const projects = await listProjects(ctx);
    const results: CheckResult[] = [];
    for (const projectDir of projects) {
      const manifestPath = resolve(projectDir, 'manifest.md');
      if (!(await fileExists(manifestPath))) continue;
      const manifestMtime = (await stat(manifestPath)).mtimeMs;
      const newestAssignment = await newestAssignmentMtime(projectDir);
      if (newestAssignment === 0) continue;
      if (newestAssignment > manifestMtime) {
        results.push({
          id: this.id,
          category: this.category,
          title: this.title,
          status: 'warn',
          detail: `manifest.md in ${projectDir} is older than the newest assignment.md`,
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
  id: 'project.orphan-files',
  category: CATEGORY,
  title: 'No unexpected files at project top level',
  async run(ctx) {
    const projects = await listProjects(ctx);
    const results: CheckResult[] = [];
    for (const projectDir of projects) {
      const entries = await readdir(projectDir, { withFileTypes: true });
      const orphans: string[] = [];
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        if (KNOWN_PROJECT_TOP_LEVEL.has(e.name)) continue;
        if (e.name.startsWith('_index-') && e.name.endsWith('.md')) continue;
        orphans.push(e.name);
      }
      if (orphans.length === 0) continue;
      results.push({
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'warn',
        detail: `project at ${projectDir} has unexpected entries: ${orphans.join(', ')}`,
        affected: orphans.map((o) => resolve(projectDir, o)),
        autoFixable: false,
      });
    }
    if (results.length === 0) return pass(this);
    return results;
  },
};

export const projectChecks: Check[] = [requiredFiles, manifestStale, orphanFiles];

async function newestAssignmentMtime(projectDir: string): Promise<number> {
  const assignmentsRoot = resolve(projectDir, 'assignments');
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
