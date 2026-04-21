import { resolve } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { fileExists } from '../../fs.js';
import { parseAssignmentFull } from '../../../dashboard/parser.js';
import { DEFAULT_STATUSES, DEFAULT_TERMINAL_STATUSES } from '../../../lifecycle/types.js';
import { DEFAULT_ASSIGNMENT_TYPES } from '../../config.js';
import { assignmentsDir as getStandaloneDir } from '../../paths.js';
import type { CheckContext, Check, CheckResult } from '../types.js';

const CATEGORY = 'assignment';

const STATUSES_REQUIRING_HANDOFF = new Set(['review', 'completed']);

interface AssignmentEntry {
  projectDir: string;
  /** `null` for standalone assignments (no containing project). */
  projectSlug: string | null;
  assignmentDir: string;
  /** For standalone, this is the UUID folder name. */
  assignmentSlug: string;
  standalone: boolean;
}

async function listAssignments(ctx: CheckContext): Promise<{
  withAssignmentMd: AssignmentEntry[];
  orphanFolders: AssignmentEntry[];
}> {
  const result = { withAssignmentMd: [] as AssignmentEntry[], orphanFolders: [] as AssignmentEntry[] };
  const projectsDir = ctx.config.defaultProjectDir;
  if (await fileExists(projectsDir)) {
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
          standalone: false,
        };
        if (await fileExists(assignmentMd)) {
          result.withAssignmentMd.push(entry);
        } else {
          result.orphanFolders.push(entry);
        }
      }
    }
  }

  // Walk standalone assignments at ~/.syntaur/assignments/
  const standaloneRoot = getStandaloneDir();
  if (await fileExists(standaloneRoot)) {
    const entries = await readdir(standaloneRoot, { withFileTypes: true });
    for (const a of entries) {
      if (!a.isDirectory()) continue;
      if (a.name.startsWith('.') || a.name.startsWith('_')) continue;
      const assignmentDir = resolve(standaloneRoot, a.name);
      const assignmentMd = resolve(assignmentDir, 'assignment.md');
      const entry: AssignmentEntry = {
        projectDir: standaloneRoot,
        projectSlug: null,
        assignmentDir,
        assignmentSlug: a.name,
        standalone: true,
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

const companionFilesScaffolded: Check = {
  id: 'assignment.companion-files',
  category: CATEGORY,
  title: 'progress.md and comments.md scaffolded (v2.0)',
  async run(ctx) {
    const { withAssignmentMd } = await listAssignments(ctx);
    const results: CheckResult[] = [];
    for (const a of withAssignmentMd) {
      const missing: string[] = [];
      for (const filename of ['progress.md', 'comments.md']) {
        if (!(await fileExists(resolve(a.assignmentDir, filename)))) {
          missing.push(filename);
        }
      }
      if (missing.length === 0) continue;
      const label = a.standalone ? `standalone/${a.assignmentSlug}` : `${a.projectSlug}/${a.assignmentSlug}`;
      results.push({
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'warn',
        detail: `${label} is missing ${missing.join(' and ')} (pre-v2.0 assignment — not required, but scaffolding them keeps the dashboard and CLIs consistent)`,
        affected: missing.map((m) => resolve(a.assignmentDir, m)),
        remediation: {
          kind: 'manual',
          suggestion: `Create ${missing.join(' and ')} with the renderProgress/renderComments templates, or re-scaffold via the CLI`,
          command: null,
        },
        autoFixable: false,
      });
    }
    if (results.length === 0) return pass(this);
    return results;
  },
};

const typeDefinition: Check = {
  id: 'assignment.type-definition',
  category: CATEGORY,
  title: 'Assignment `type` is in config.types.definitions',
  async run(ctx) {
    const typesConfig = ctx.config.types;
    if (!typesConfig) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'skipped',
        detail: 'config.types is not set; applying defaults — skipping strict validation',
        autoFixable: false,
      } satisfies CheckResult;
    }
    const allowed = new Set(typesConfig.definitions.map((d) => d.id));
    const { withAssignmentMd } = await listAssignments(ctx);
    const results: CheckResult[] = [];
    for (const a of withAssignmentMd) {
      const path = resolve(a.assignmentDir, 'assignment.md');
      const parsed = await parseSafe(path);
      if (!parsed) continue;
      if (!parsed.type) continue; // optional field
      if (!allowed.has(parsed.type)) {
        const label = a.standalone ? `standalone/${a.assignmentSlug}` : `${a.projectSlug}/${a.assignmentSlug}`;
        results.push({
          id: this.id,
          category: this.category,
          title: this.title,
          status: 'warn',
          detail: `${label}: type "${parsed.type}" is not in config.types.definitions (${[...allowed].join(', ')})`,
          affected: [path],
          remediation: {
            kind: 'manual',
            suggestion: `Either add "${parsed.type}" to config.types.definitions or change the assignment's type to one of the configured values`,
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

const projectFrontmatterMatchesContainer: Check = {
  id: 'assignment.project-matches-container',
  category: CATEGORY,
  title: '`project` frontmatter matches containing project slug (or null for standalone)',
  async run(ctx) {
    const { withAssignmentMd } = await listAssignments(ctx);
    const results: CheckResult[] = [];
    for (const a of withAssignmentMd) {
      const path = resolve(a.assignmentDir, 'assignment.md');
      const parsed = await parseSafe(path);
      if (!parsed) continue;
      if (a.standalone) {
        if (parsed.project !== null) {
          results.push({
            id: this.id,
            category: this.category,
            title: this.title,
            status: 'error',
            detail: `standalone/${a.assignmentSlug}: frontmatter declares project "${parsed.project}" but the folder is under ~/.syntaur/assignments/ (project must be null)`,
            affected: [path],
            remediation: {
              kind: 'manual',
              suggestion: 'Set `project: null` in the frontmatter, or move the folder into a project.',
              command: null,
            },
            autoFixable: false,
          });
        }
      } else {
        if (parsed.project !== a.projectSlug) {
          results.push({
            id: this.id,
            category: this.category,
            title: this.title,
            status: 'error',
            detail: `${a.projectSlug}/${a.assignmentSlug}: frontmatter declares project "${parsed.project ?? 'null'}" but the folder is inside project "${a.projectSlug}"`,
            affected: [path],
            remediation: {
              kind: 'manual',
              suggestion: `Set \`project: ${a.projectSlug}\` in the frontmatter.`,
              command: null,
            },
            autoFixable: false,
          });
        }
      }
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
  companionFilesScaffolded,
  typeDefinition,
  projectFrontmatterMatchesContainer,
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
