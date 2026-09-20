import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { fileExists } from '../../fs.js';
import { parseTicketFolderName } from '../../ticket-folder.js';
import type { Check, CheckResult } from '../types.js';

const CATEGORY = 'project';

const REQUIRED_PROJECT_FILES = ['project.md'] as const;

const DERIVED_PROJECT_FILE_NAMES = [
  'manifest.md',
  '_index-tickets.md',
  '_index-assignments.md',
  '_index-sessions.md',
  '_index-plans.md',
  '_index-decisions.md',
  '_status.md',
  'resources/_index.md',
  'memories/_index.md',
] as const;

const KNOWN_PROJECT_TOP_LEVEL = new Set<string>([
  'project.md',
  'tickets',
  'resources',
  'memories',
]);

const PROJECT_MARKERS = ['project.md', 'tickets'] as const;

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

const derivedFilesPresent: Check = {
  id: 'project.derived-files-present',
  category: CATEGORY,
  title: 'No derived markdown index files remain under projects',
  async run(ctx) {
    const projects = await listProjects(ctx);
    const results: CheckResult[] = [];
    for (const projectDir of projects) {
      const present: string[] = [];
      for (const rel of DERIVED_PROJECT_FILE_NAMES) {
        if (await fileExists(resolve(projectDir, rel))) present.push(rel);
      }
      if (present.length === 0) continue;
      results.push({
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'warn',
        detail: `project at ${projectDir} still has derived files: ${present.join(', ')}`,
        affected: present.map((p) => resolve(projectDir, p)),
        remediation: {
          kind: 'manual',
          suggestion: 'Run migrate v2 to remove derived project markdown',
          command: 'syntaur migrate v2 --apply',
        },
        autoFixable: false,
      });
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

const ticketFolderLayout: Check = {
  id: 'project.ticket-folder-layout',
  category: CATEGORY,
  title: 'Ticket folders under tickets/ use <ID>-<slug> naming',
  async run(ctx) {
    const projects = await listProjects(ctx);
    const results: CheckResult[] = [];
    for (const projectDir of projects) {
      const ticketsRoot = resolve(projectDir, 'tickets');
      if (!(await fileExists(ticketsRoot))) continue;
      const entries = await readdir(ticketsRoot, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
        if (parseTicketFolderName(e.name)) continue;
        results.push({
          id: this.id,
          category: this.category,
          title: this.title,
          status: 'warn',
          detail: `ticket folder "${e.name}" in ${ticketsRoot} does not match <ID>-<slug> (e.g. SCR-1-my-feature)`,
          affected: [resolve(ticketsRoot, e.name)],
          remediation: {
            kind: 'manual',
            suggestion: 'Rename the folder to <ticket-id>-<slug> or run syntaur migrate v2 on a copy first',
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

export const projectChecks: Check[] = [
  requiredFiles,
  derivedFilesPresent,
  orphanFiles,
  ticketFolderLayout,
];

function pass(check: { id: string; category: string; title: string }): CheckResult {
  return {
    id: check.id,
    category: check.category,
    title: check.title,
    status: 'pass',
    autoFixable: false,
  };
}
