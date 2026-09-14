import { basename, dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileExists } from '../../fs.js';
import { parseTicketFull } from '../../../dashboard/parser.js';
import { isTerminalStage } from '../../../ticket-templates/stages.js';
import type { StageId } from '../../../ticket-templates/manifest.js';
import type { CheckContext, Check, CheckResult } from '../types.js';

const CATEGORY = 'workspace';

interface ContextFile {
  sessionId?: string;
  transcriptPath?: string;
  ticketId?: string;
  ticketDir?: string;
  workspaceRoot?: string;
  branch?: string;
  worktree?: string;
  repository?: string;
  boundAt?: string;
}

const TICKET_FIELDS = ['ticketId', 'ticketDir'] as const;
// context.json is a WORKSPACE MARKER now — these are the fields the launcher/grab
// flow writes. The active ticket resolves from the session's open engagement,
// NOT from this file (the legacy ticket scalars were removed).
const WORKSPACE_MARKER_FIELDS = ['repository', 'worktree', 'workspaceRoot', 'branch'] as const;

function hasAnyTicketField(ctx: ContextFile | null): boolean {
  if (!ctx) return false;
  return TICKET_FIELDS.some((k) => typeof ctx[k] === 'string' && ctx[k]!.length > 0);
}

function hasWorkspaceMarker(ctx: ContextFile | null): boolean {
  if (!ctx) return false;
  return WORKSPACE_MARKER_FIELDS.some((k) => typeof ctx[k] === 'string' && ctx[k]!.length > 0);
}

function isStandaloneSession(ctx: ContextFile | null): boolean {
  if (!ctx) return false;
  // Presence of session metadata (sessionId or transcriptPath), not the id
  // value — the value is a clobberable hint, presence-vs-absence is stable.
  const hasSessionMeta =
    (typeof ctx.sessionId === 'string' && ctx.sessionId.length > 0) ||
    (typeof ctx.transcriptPath === 'string' && ctx.transcriptPath.length > 0);
  return !hasAnyTicketField(ctx) && hasSessionMeta;
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
          suggestion: 'Fix or regenerate the context file by re-grabbing the ticket',
          command: null,
        },
        autoFixable: false,
      } satisfies CheckResult;
    }
    if (isStandaloneSession(data)) {
      return pass(this, 'standalone session context (sessionId only)');
    }
    // context.json is a workspace marker — a file carrying workspace markers
    // (or legacy ticket scalars from before the demotion) is valid. The
    // active ticket resolves from the session's open engagement, so the
    // ticket scalars are no longer a required part of this file's contract.
    if (hasWorkspaceMarker(data) || hasAnyTicketField(data)) {
      return pass(this, 'workspace marker context');
    }
    return {
      id: this.id,
      category: this.category,
      title: this.title,
      status: 'error',
      detail:
        '.syntaur/context.json has no recognized fields (workspace markers or session)',
      affected: [path],
      autoFixable: false,
    } satisfies CheckResult;
  },
};

const contextTicketResolves: Check = {
  id: 'workspace.context-ticket-resolves',
  category: CATEGORY,
  title: 'Context references a ticket that exists on disk',
  async run(ctx) {
    const { data, path, exists } = await loadContext(ctx);
    if (!exists) return skipped(this, 'no context to resolve');
    if (isStandaloneSession(data)) return skipped(this, 'standalone session context — no ticket to resolve');
    if (!data?.ticketDir) return skipped(this, 'context has no ticketDir');
    const ticketMd = resolve(data.ticketDir, 'ticket.md');
    if (!(await fileExists(ticketMd))) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: `context points to ${data.ticketDir} but ticket.md is missing`,
        affected: [ticketMd, path],
        remediation: {
          kind: 'manual',
          suggestion: 'Remove the stale .syntaur/context.json or restore the ticket',
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
  title: 'Context ticket is not in a terminal status',
  async run(ctx) {
    const { data, exists } = await loadContext(ctx);
    if (!exists) return skipped(this, 'no context to check');
    if (isStandaloneSession(data)) return skipped(this, 'standalone session context — no ticket to check');
    if (!data?.ticketDir) return skipped(this, 'context has no ticketDir');
    const ticketMd = resolve(data.ticketDir, 'ticket.md');
    if (!(await fileExists(ticketMd))) return skipped(this, 'ticket file missing');
    try {
      const content = await readFile(ticketMd, 'utf-8');
      const parsed = parseTicketFull(content);
      if (isTerminalStage(parsed.status as StageId | 'dropped')) {
        return {
          id: this.id,
          category: this.category,
          title: this.title,
          status: 'warn',
          detail: `context references ticket with terminal status "${parsed.status}"`,
          affected: [ticketMd],
          remediation: {
            kind: 'manual',
            suggestion: 'Grab a new ticket or remove the stale .syntaur/context.json',
            command: null,
          },
          autoFixable: false,
        } satisfies CheckResult;
      }
      return pass(this);
    } catch {
      return skipped(this, 'could not parse ticket.md');
    }
  },
};

export const workspaceChecks: Check[] = [contextValid, contextTicketResolves, contextTerminal];

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
