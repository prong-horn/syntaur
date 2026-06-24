import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileExists } from '../../fs.js';
import { parseAssignmentFull } from '../../../dashboard/parser.js';
import { DEFAULT_TERMINAL_STATUSES } from '../../../lifecycle/types.js';
import type { CheckContext, Check, CheckResult } from '../types.js';

const CATEGORY = 'workspace';

interface ContextFile {
  sessionId?: string;
  transcriptPath?: string;
  projectSlug?: string;
  assignmentSlug?: string;
  projectDir?: string;
  assignmentDir?: string;
  workspaceRoot?: string;
  // Bundle-scoped fields — mutually exclusive with the assignment fields above.
  bundleId?: string;
  bundleSlug?: string;
  bundleScope?: string;
  bundleScopeId?: string;
  todoIds?: string[];
  planDir?: string;
  branch?: string;
  worktreePath?: string;
  repository?: string;
  boundAt?: string;
}

const ASSIGNMENT_FIELDS = ['projectSlug', 'assignmentSlug', 'projectDir', 'assignmentDir'] as const;
const BUNDLE_FIELDS = ['bundleId', 'bundleScope', 'bundleScopeId'] as const;
// context.json is a WORKSPACE MARKER now — these are the fields the launcher/grab
// flow writes. The active assignment resolves from the session's open engagement,
// NOT from this file (the legacy assignment scalars were removed).
const WORKSPACE_MARKER_FIELDS = ['repository', 'worktreePath', 'workspaceRoot', 'branch'] as const;

function hasAnyAssignmentField(ctx: ContextFile | null): boolean {
  if (!ctx) return false;
  return ASSIGNMENT_FIELDS.some((k) => typeof ctx[k] === 'string' && ctx[k]!.length > 0);
}

function hasWorkspaceMarker(ctx: ContextFile | null): boolean {
  if (!ctx) return false;
  return WORKSPACE_MARKER_FIELDS.some((k) => typeof ctx[k] === 'string' && ctx[k]!.length > 0);
}

function hasAnyBundleField(ctx: ContextFile | null): boolean {
  if (!ctx) return false;
  return BUNDLE_FIELDS.some((k) => typeof ctx[k] === 'string' && ctx[k]!.length > 0);
}

function isBundleContext(ctx: ContextFile | null): boolean {
  if (!ctx) return false;
  return hasAnyBundleField(ctx) && !hasAnyAssignmentField(ctx);
}

function isStandaloneSession(ctx: ContextFile | null): boolean {
  if (!ctx) return false;
  // Presence of session metadata (sessionId or transcriptPath), not the id
  // value — the value is a clobberable hint, presence-vs-absence is stable.
  const hasSessionMeta =
    (typeof ctx.sessionId === 'string' && ctx.sessionId.length > 0) ||
    (typeof ctx.transcriptPath === 'string' && ctx.transcriptPath.length > 0);
  return !hasAnyAssignmentField(ctx) && !hasAnyBundleField(ctx) && hasSessionMeta;
}

async function loadContext(ctx: CheckContext): Promise<{
  data: ContextFile | null;
  path: string;
  exists: boolean;
  parseError: string | null;
}> {
  const path = resolve(ctx.cwd, '.syntaur', 'context.json');
  if (!(await fileExists(path))) {
    return { data: null, path, exists: false, parseError: null };
  }
  try {
    const raw = await readFile(path, 'utf-8');
    return { data: JSON.parse(raw) as ContextFile, path, exists: true, parseError: null };
  } catch (err) {
    return {
      data: null,
      path,
      exists: true,
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}

const contextValid: Check = {
  id: 'workspace.context-valid',
  category: CATEGORY,
  title: '.syntaur/context.json parses and has required fields',
  async run(ctx) {
    const { data, path, exists, parseError } = await loadContext(ctx);
    if (!exists) return skipped(this, 'no .syntaur/context.json in cwd');
    if (parseError) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: `.syntaur/context.json is not valid JSON: ${parseError}`,
        affected: [path],
        remediation: {
          kind: 'manual',
          suggestion: 'Fix or regenerate the context file by re-grabbing the assignment',
          command: null,
        },
        autoFixable: false,
      } satisfies CheckResult;
    }
    if (isStandaloneSession(data)) {
      return pass(this, 'standalone session context (sessionId only)');
    }
    if (isBundleContext(data)) {
      // Validate the bundle-context payload has the required field set.
      const missing: string[] = [];
      for (const key of ['bundleId', 'bundleScope', 'bundleScopeId'] as const) {
        if (!data?.[key]) missing.push(key);
      }
      if (missing.length > 0) {
        return {
          id: this.id,
          category: this.category,
          title: this.title,
          status: 'error',
          detail: `.syntaur/context.json has partial bundle fields but is missing: ${missing.join(', ')}`,
          affected: [path],
          autoFixable: false,
        } satisfies CheckResult;
      }
      return pass(this, `bundle context (b:${data!.bundleId})`);
    }
    // context.json is a workspace marker — a file carrying workspace markers
    // (or legacy assignment scalars from before the demotion) is valid. The
    // active assignment resolves from the session's open engagement, so the
    // assignment scalars are no longer a required part of this file's contract.
    if (hasWorkspaceMarker(data) || hasAnyAssignmentField(data)) {
      return pass(this, 'workspace marker context');
    }
    return {
      id: this.id,
      category: this.category,
      title: this.title,
      status: 'error',
      detail:
        '.syntaur/context.json has no recognized fields (workspace markers, session, or bundle)',
      affected: [path],
      autoFixable: false,
    } satisfies CheckResult;
  },
};

const contextAssignmentResolves: Check = {
  id: 'workspace.context-assignment-resolves',
  category: CATEGORY,
  title: 'Context references an assignment that exists on disk',
  async run(ctx) {
    const { data, path, exists } = await loadContext(ctx);
    if (!exists) return skipped(this, 'no context to resolve');
    if (isStandaloneSession(data)) return skipped(this, 'standalone session context — no assignment to resolve');
    if (isBundleContext(data)) return skipped(this, 'bundle context — no assignment to resolve');
    if (!data?.assignmentDir) return skipped(this, 'context has no assignmentDir');
    const assignmentMd = resolve(data.assignmentDir, 'assignment.md');
    if (!(await fileExists(assignmentMd))) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: `context points to ${data.assignmentDir} but assignment.md is missing`,
        affected: [assignmentMd, path],
        remediation: {
          kind: 'manual',
          suggestion: 'Remove the stale .syntaur/context.json or restore the assignment',
          command: null,
        },
        autoFixable: false,
      } satisfies CheckResult;
    }
    return pass(this);
  },
};

const contextTerminal: Check = {
  id: 'workspace.context-terminal',
  category: CATEGORY,
  title: 'Context assignment is not in a terminal status',
  async run(ctx) {
    const { data, exists } = await loadContext(ctx);
    if (!exists) return skipped(this, 'no context to check');
    if (isStandaloneSession(data)) return skipped(this, 'standalone session context — no assignment to check');
    if (isBundleContext(data)) return skipped(this, 'bundle context — no assignment to check');
    if (!data?.assignmentDir) return skipped(this, 'context has no assignmentDir');
    const assignmentMd = resolve(data.assignmentDir, 'assignment.md');
    if (!(await fileExists(assignmentMd))) return skipped(this, 'assignment file missing');
    try {
      const content = await readFile(assignmentMd, 'utf-8');
      const parsed = parseAssignmentFull(content);
      const terminal = terminalStatuses(ctx);
      if (terminal.has(parsed.status)) {
        return {
          id: this.id,
          category: this.category,
          title: this.title,
          status: 'warn',
          detail: `context references assignment with terminal status "${parsed.status}"`,
          affected: [assignmentMd],
          remediation: {
            kind: 'manual',
            suggestion: 'Grab a new assignment or remove the stale .syntaur/context.json',
            command: null,
          },
          autoFixable: false,
        } satisfies CheckResult;
      }
      return pass(this);
    } catch {
      return skipped(this, 'could not parse assignment.md');
    }
  },
};

function terminalStatuses(ctx: CheckContext): Set<string> {
  const custom = ctx.config.statuses?.statuses?.filter((s) => s.terminal).map((s) => s.id) ?? [];
  if (custom.length > 0) return new Set(custom);
  return new Set(DEFAULT_TERMINAL_STATUSES);
}

export const workspaceChecks: Check[] = [contextValid, contextAssignmentResolves, contextTerminal];

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

function skipped(check: { id: string; category: string; title: string }, reason: string): CheckResult {
  return {
    id: check.id,
    category: check.category,
    title: check.title,
    status: 'skipped',
    detail: reason,
    autoFixable: false,
  };
}
