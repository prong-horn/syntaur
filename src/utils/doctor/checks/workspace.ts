import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileExists } from '../../fs.js';
import { parseAssignmentFull } from '../../../dashboard/parser.js';
import { DEFAULT_TERMINAL_STATUSES } from '../../../lifecycle/types.js';
import type { CheckContext, Check, CheckResult } from '../types.js';

const CATEGORY = 'workspace';

interface ContextFile {
  sessionId?: string;
  missionSlug?: string;
  assignmentSlug?: string;
  missionDir?: string;
  assignmentDir?: string;
  workspaceRoot?: string;
}

const ASSIGNMENT_FIELDS = ['missionSlug', 'assignmentSlug', 'missionDir', 'assignmentDir'] as const;

function hasAnyAssignmentField(ctx: ContextFile | null): boolean {
  if (!ctx) return false;
  return ASSIGNMENT_FIELDS.some((k) => typeof ctx[k] === 'string' && ctx[k]!.length > 0);
}

function isStandaloneSession(ctx: ContextFile | null): boolean {
  if (!ctx) return false;
  return !hasAnyAssignmentField(ctx) && typeof ctx.sessionId === 'string' && ctx.sessionId.length > 0;
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
    if (!hasAnyAssignmentField(data)) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: '.syntaur/context.json has no sessionId and no assignment fields',
        affected: [path],
        autoFixable: false,
      } satisfies CheckResult;
    }
    const missing: string[] = [];
    for (const key of ['missionSlug', 'assignmentSlug', 'assignmentDir'] as const) {
      if (!data?.[key]) missing.push(key);
    }
    if (missing.length > 0) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: `.syntaur/context.json has partial assignment fields but is missing: ${missing.join(', ')}`,
        affected: [path],
        autoFixable: false,
      } satisfies CheckResult;
    }
    return pass(this);
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
