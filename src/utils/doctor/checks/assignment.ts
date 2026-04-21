import { resolve } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { fileExists } from '../../fs.js';
import { parseAssignmentFull } from '../../../dashboard/parser.js';
import { DEFAULT_STATUSES, DEFAULT_TERMINAL_STATUSES } from '../../../lifecycle/types.js';
import type { CheckContext, Check, CheckResult } from '../types.js';

const CATEGORY = 'assignment';

const STATUSES_REQUIRING_HANDOFF = new Set(['review', 'completed']);

interface AssignmentEntry {
  projectDir: string;
  projectSlug: string;
  assignmentDir: string;
  assignmentSlug: string;
}

async function listAssignments(ctx: CheckContext): Promise<{
  withAssignmentMd: AssignmentEntry[];
  orphanFolders: AssignmentEntry[];
}> {
  const result = { withAssignmentMd: [] as AssignmentEntry[], orphanFolders: [] as AssignmentEntry[] };
  const projectsDir = ctx.config.defaultProjectDir;
  if (!(await fileExists(projectsDir))) return result;

  const projects = await readdir(projectsDir, { withFileTypes: true });
  for (const m of projects) {
    if (!m.isDirectory()) continue;
    if (m.name.startsWith('.') || m.name.startsWith('_')) continue;
    const assignmentsDir = resolve(projectsDir, m.name, 'assignments');
    if (!(await fileExists(assignmentsDir))) continue;

    const entries = await readdir(assignmentsDir, { withFileTypes: true });
    for (const a of entries) {
      if (!a.isDirectory()) continue;
      if (a.name.startsWith('.') || a.name.startsWith('_')) continue;
      const assignmentDir = resolve(assignmentsDir, a.name);
      const assignmentMd = resolve(assignmentDir, 'assignment.md');
      const entry: AssignmentEntry = {
        projectDir: resolve(projectsDir, m.name),
        projectSlug: m.name,
        assignmentDir,
        assignmentSlug: a.name,
      };
      if (await fileExists(assignmentMd)) {
        result.withAssignmentMd.push(entry);
      } else {
        result.orphanFolders.push(entry);
      }
    }
  }
  return result;
}

function configuredStatuses(ctx: CheckContext): Set<string> {
  const custom = ctx.config.statuses?.statuses?.map((s) => s.id) ?? [];
  if (custom.length > 0) return new Set(custom);
  return new Set(DEFAULT_STATUSES);
}

function terminalStatuses(ctx: CheckContext): Set<string> {
  const custom = ctx.config.statuses?.statuses?.filter((s) => s.terminal).map((s) => s.id) ?? [];
  if (custom.length > 0) return new Set(custom);
  return new Set(DEFAULT_TERMINAL_STATUSES);
}

const requiredFiles: Check = {
  id: 'assignment.required-files',
  category: CATEGORY,
  title: 'Each assignment folder has an assignment.md',
  async run(ctx) {
    const { withAssignmentMd } = await listAssignments(ctx);
    if (withAssignmentMd.length === 0) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'skipped',
        detail: 'no assignments found',
        autoFixable: false,
      } satisfies CheckResult;
    }
    return pass(this, `${withAssignmentMd.length} assignment.md files present`);
  },
};

const orphanedFolder: Check = {
  id: 'assignment.orphaned-folder',
  category: CATEGORY,
  title: 'No assignment folders without assignment.md',
  async run(ctx) {
    const { orphanFolders } = await listAssignments(ctx);
    if (orphanFolders.length === 0) return pass(this);
    return orphanFolders.map((o) => ({
      id: this.id,
      category: this.category,
      title: this.title,
      status: 'error' as const,
      detail: `folder ${o.assignmentDir} has no assignment.md`,
      affected: [o.assignmentDir],
      remediation: {
        kind: 'manual' as const,
        suggestion: 'Either create an assignment.md inside the folder or delete it',
        command: null,
      },
      autoFixable: false,
    }));
  },
};

const invalidStatus: Check = {
  id: 'assignment.invalid-status',
  category: CATEGORY,
  title: 'Assignment statuses are valid',
  async run(ctx) {
    const { withAssignmentMd } = await listAssignments(ctx);
    const allowed = configuredStatuses(ctx);
    const results: CheckResult[] = [];
    for (const a of withAssignmentMd) {
      const path = resolve(a.assignmentDir, 'assignment.md');
      const parsed = await parseSafe(path);
      if (!parsed) continue;
      if (!allowed.has(parsed.status)) {
        results.push({
          id: this.id,
          category: this.category,
          title: this.title,
          status: 'error',
          detail: `${a.projectSlug}/${a.assignmentSlug}: status "${parsed.status}" is not in configured statuses (${[...allowed].join(', ')})`,
          affected: [path],
          remediation: {
            kind: 'manual',
            suggestion: 'Update the assignment status to a valid value',
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

const workspaceMissing: Check = {
  id: 'assignment.workspace-missing',
  category: CATEGORY,
  title: 'Non-terminal assignments have workspace fields set',
  async run(ctx) {
    const { withAssignmentMd } = await listAssignments(ctx);
    const terminal = terminalStatuses(ctx);
    const results: CheckResult[] = [];
    for (const a of withAssignmentMd) {
      const path = resolve(a.assignmentDir, 'assignment.md');
      const parsed = await parseSafe(path);
      if (!parsed) continue;
      if (terminal.has(parsed.status)) continue;
      if (parsed.status === 'pending') continue; // workspace not yet expected
      const { repository, worktreePath } = parsed.workspace;
      if (repository === null && worktreePath === null) {
        results.push({
          id: this.id,
          category: this.category,
          title: this.title,
          status: 'error',
          detail: `${a.projectSlug}/${a.assignmentSlug} (status: ${parsed.status}) has no workspace.repository or workspace.worktreePath set — the PreToolUse hook will block implementation work`,
          affected: [path],
          remediation: {
            kind: 'manual',
            suggestion: 'Set workspace.repository and workspace.worktreePath in the assignment frontmatter before continuing implementation',
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

const requiredFilesByStatus: Check = {
  id: 'assignment.required-files-by-status',
  category: CATEGORY,
  title: 'Handoff file matches assignment status',
  async run(ctx) {
    const allowed = configuredStatuses(ctx);
    const defaultsCovered = Array.from(DEFAULT_STATUSES).every((s) => allowed.has(s));
    if (!defaultsCovered) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'skipped',
        detail: 'custom StatusConfig does not include default statuses; file-by-status mapping not applicable',
        autoFixable: false,
      } satisfies CheckResult;
    }
    const { withAssignmentMd } = await listAssignments(ctx);
    const results: CheckResult[] = [];
    for (const a of withAssignmentMd) {
      const assignmentPath = resolve(a.assignmentDir, 'assignment.md');
      const parsed = await parseSafe(assignmentPath);
      if (!parsed) continue;
      const missing: string[] = [];
      if (STATUSES_REQUIRING_HANDOFF.has(parsed.status)) {
        const handoffPath = resolve(a.assignmentDir, 'handoff.md');
        if (!(await fileExists(handoffPath))) missing.push('handoff.md');
      }
      if (missing.length === 0) continue;
      results.push({
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'warn',
        detail: `${a.projectSlug}/${a.assignmentSlug} (status: ${parsed.status}) is missing ${missing.join(', ')}`,
        affected: missing.map((m) => resolve(a.assignmentDir, m)),
        remediation: {
          kind: 'manual',
          suggestion: `Create the missing ${missing.join(' and ')} files for this assignment`,
          command: null,
        },
        autoFixable: false,
      });
    }
    if (results.length === 0) return pass(this);
    return results;
  },
};

export const assignmentChecks: Check[] = [
  requiredFiles,
  orphanedFolder,
  invalidStatus,
  workspaceMissing,
  requiredFilesByStatus,
];

async function parseSafe(path: string): Promise<ReturnType<typeof parseAssignmentFull> | null> {
  try {
    const content = await readFile(path, 'utf-8');
    return parseAssignmentFull(content);
  } catch {
    return null;
  }
}

function pass(check: { id: string; category: string; title: string }, detail?: string): CheckResult {
  return {
    id: check.id,
    category: check.category,
    title: check.title,
    status: 'pass',
    detail,
    autoFixable: false,
  };
}
