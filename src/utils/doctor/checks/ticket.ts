import { resolve } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { fileExists } from '../../fs.js';
import { parseTicketFull } from '../../../dashboard/parser.js';
import { STAGE_ORDER } from '../../../ticket-templates/stages.js';
import { isTerminalStage } from '../../../ticket-templates/stages.js';
import { syntaurRoot } from '../../paths.js';
import { listTicketsByProject, type TicketEntry } from '../../ticket-walk.js';
import { listTemplates, resolveTemplateForTicket } from '../../../ticket-templates/registry.js';
import type { CheckContext, Check, CheckResult } from '../types.js';

const CATEGORY = 'ticket';

const STATUSES_REQUIRING_HANDOFF = new Set(['review', 'done']);

const PRE_WORKSPACE_STATUSES = new Set(['backlog', 'planning', 'ready']);

const OBJECTIVE_PLACEHOLDER_PATTERNS = [
  /<!--\s*placeholder\s*-->/i,
  /<!--\s*Clear description of what needs to be done and why\.?\s*-->/i,
];

function objectiveBodyIsEmpty(content: string): boolean {
  const lines = content.split('\n');
  let inObjective = false;
  const bodyLines: string[] = [];
  for (const line of lines) {
    if (/^##\s+Objective\b/.test(line)) {
      inObjective = true;
      continue;
    }
    if (inObjective && /^##\s+/.test(line)) break;
    if (inObjective) bodyLines.push(line);
  }
  if (!inObjective) return true;
  const body = bodyLines.map((l) => l.trim()).filter((l) => l.length > 0).join('\n').trim();
  if (body.length === 0) return true;
  return OBJECTIVE_PLACEHOLDER_PATTERNS.some((p) => p.test(body));
}

async function listTickets(ctx: CheckContext): Promise<{
  withTicketMd: TicketEntry[];
  orphanFolders: TicketEntry[];
}> {
  return listTicketsByProject(ctx.config.defaultProjectDir);
}

function configuredStatuses(_ctx: CheckContext): Set<string> {
  return new Set(STAGE_ORDER);
}

/** projectDir for a walked ticket entry — its project root for a nested
 * ticket (`<projectDir>/tickets/<slug>`), null for standalone. */
function projectDirFor(a: TicketEntry): string | null {
  return a.projectSlug ? resolve(a.ticketDir, '..', '..') : null;
}

const requiredFiles: Check = {
  id: 'ticket.required-files',
  category: CATEGORY,
  title: 'Each ticket folder has a ticket.md',
  async run(ctx) {
    const { withTicketMd } = await listTickets(ctx);
    if (withTicketMd.length === 0) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'skipped',
        detail: 'no tickets found',
        autoFixable: false,
      } satisfies CheckResult;
    }
    return pass(this, `${withTicketMd.length} ticket.md files present`);
  },
};

const orphanedFolder: Check = {
  id: 'ticket.orphaned-folder',
  category: CATEGORY,
  title: 'No ticket folders without ticket.md',
  async run(ctx) {
    const { orphanFolders } = await listTickets(ctx);
    if (orphanFolders.length === 0) return pass(this);
    return orphanFolders.map((o) => ({
      id: this.id,
      category: this.category,
      title: this.title,
      status: 'error' as const,
      detail: `folder ${o.ticketDir} has no ticket.md`,
      affected: [o.ticketDir],
      remediation: {
        kind: 'manual' as const,
        suggestion: 'Either create a ticket.md inside the folder or delete it',
        command: null,
      },
      autoFixable: false,
    }));
  },
};

const invalidStatus: Check = {
  id: 'ticket.invalid-status',
  category: CATEGORY,
  title: 'Ticket statuses are valid',
  async run(ctx) {
    const { withTicketMd } = await listTickets(ctx);
    const allowed = configuredStatuses(ctx);
    const results: CheckResult[] = [];
    for (const a of withTicketMd) {
      const path = resolve(a.ticketDir, 'ticket.md');
      const parsed = await parseSafe(path);
      if (!parsed) continue;
      if (!allowed.has(parsed.status)) {
        results.push({
          id: this.id,
          category: this.category,
          title: this.title,
          status: 'error',
          detail: `${a.projectSlug}/${a.ticketSlug}: status "${parsed.status}" is not a valid stage (${[...allowed].join(', ')})`,
          affected: [path],
          remediation: {
            kind: 'manual',
            suggestion: 'Update the ticket status to a valid value',
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
  id: 'ticket.workspace-missing',
  category: CATEGORY,
  title: 'Non-terminal tickets have workspace fields set',
  async run(ctx) {
    const { withTicketMd } = await listTickets(ctx);
    const results: CheckResult[] = [];
    for (const a of withTicketMd) {
      const path = resolve(a.ticketDir, 'ticket.md');
      const parsed = await parseSafe(path);
      if (!parsed) continue;
      if (isTerminalStage(parsed.status as (typeof STAGE_ORDER)[number])) continue;
      if (PRE_WORKSPACE_STATUSES.has(parsed.status)) continue; // workspace not yet expected
      const { repository, worktree } = parsed.workspace;
      if (repository === null && worktree === null) {
        results.push({
          id: this.id,
          category: this.category,
          title: this.title,
          status: 'error',
          detail: `${a.projectSlug}/${a.ticketSlug} (status: ${parsed.status}) has no workspace.repository or workspace.worktree set — the PreToolUse hook will block implementation work`,
          affected: [path],
          remediation: {
            kind: 'manual',
            suggestion: 'Set workspace.repository and workspace.worktree in the ticket frontmatter before continuing implementation',
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
  id: 'ticket.required-files-by-status',
  category: CATEGORY,
  title: 'Handoff file matches ticket status',
  async run(ctx) {
    const allowed = configuredStatuses(ctx);
    const defaultsCovered = STAGE_ORDER.every((s) => allowed.has(s));
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
    const { withTicketMd } = await listTickets(ctx);
    const results: CheckResult[] = [];
    for (const a of withTicketMd) {
      const ticketPath = resolve(a.ticketDir, 'ticket.md');
      const parsed = await parseSafe(ticketPath);
      if (!parsed) continue;
      const templateId = resolveTemplateForTicket({ template: parsed.template });
      if (templateId !== 'legacy') continue;
      const missing: string[] = [];
      if (STATUSES_REQUIRING_HANDOFF.has(parsed.status)) {
        const handoffPath = resolve(a.ticketDir, 'handoff.md');
        if (!(await fileExists(handoffPath))) missing.push('handoff.md');
      }
      if (missing.length === 0) continue;
      results.push({
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'warn',
        detail: `${a.projectSlug}/${a.ticketSlug} (status: ${parsed.status}) is missing ${missing.join(', ')}`,
        affected: missing.map((m) => resolve(a.ticketDir, m)),
        remediation: {
          kind: 'manual',
          suggestion: `Create the missing ${missing.join(' and ')} files for this ticket`,
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
  id: 'ticket.companion-files',
  category: CATEGORY,
  title: 'progress.md and comments.md scaffolded (v2.0)',
  async run(ctx) {
    const { withTicketMd } = await listTickets(ctx);
    const results: CheckResult[] = [];
    for (const a of withTicketMd) {
      const ticketPath = resolve(a.ticketDir, 'ticket.md');
      const parsed = await parseSafe(ticketPath);
      if (!parsed) continue;
      if (resolveTemplateForTicket({ template: parsed.template }) !== 'legacy') continue;
      const missing: string[] = [];
      for (const filename of ['progress.md', 'comments.md']) {
        if (!(await fileExists(resolve(a.ticketDir, filename)))) {
          missing.push(filename);
        }
      }
      if (missing.length === 0) continue;
      const label = a.standalone ? `standalone/${a.ticketSlug}` : `${a.projectSlug}/${a.ticketSlug}`;
      results.push({
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'warn',
        detail: `${label} is missing ${missing.join(' and ')} (pre-v2.0 ticket — not required, but scaffolding them keeps the dashboard and CLIs consistent)`,
        affected: missing.map((m) => resolve(a.ticketDir, m)),
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

const templateMissing: Check = {
  id: 'ticket.template-missing',
  category: CATEGORY,
  title: 'Ticket has a template field',
  async run(ctx) {
    const { withTicketMd } = await listTickets(ctx);
    const results: CheckResult[] = [];
    for (const a of withTicketMd) {
      const path = resolve(a.ticketDir, 'ticket.md');
      const raw = await readFile(path, 'utf-8').catch(() => null);
      if (!raw) continue;
      if (/^template:\s*/m.test(raw)) continue;
      const label = a.standalone ? `standalone/${a.ticketSlug}` : `${a.projectSlug}/${a.ticketSlug}`;
      results.push({
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'warn',
        detail: `${label}: missing template: (renders as legacy)`,
        affected: [path],
        remediation: {
          kind: 'manual',
          suggestion: 'Add template: <id> to ticket.md or run migrate v2',
          command: null,
        },
        autoFixable: false,
      });
    }
    if (results.length === 0) return pass(this);
    return results;
  },
};

const templateKnown: Check = {
  id: 'ticket.template-known',
  category: CATEGORY,
  title: 'Ticket template id is installed',
  async run(ctx) {
    const installed = new Set((await listTemplates(ctx.syntaurRoot)).map((t) => t.id));
    const { withTicketMd } = await listTickets(ctx);
    const results: CheckResult[] = [];
    for (const a of withTicketMd) {
      const path = resolve(a.ticketDir, 'ticket.md');
      const parsed = await parseSafe(path);
      if (!parsed) continue;
      const templateId = resolveTemplateForTicket({ template: parsed.template });
      if (installed.has(templateId)) continue;
      const label = a.standalone ? `standalone/${a.ticketSlug}` : `${a.projectSlug}/${a.ticketSlug}`;
      results.push({
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'warn',
        detail: `${label}: template "${templateId}" not found (syntaur template list)`,
        affected: [path],
        remediation: {
          kind: 'manual',
          suggestion: 'Run syntaur template list and set a known template id',
          command: 'syntaur template list',
        },
        autoFixable: false,
      });
    }
    if (results.length === 0) return pass(this);
    return results;
  },
};

const projectFrontmatterMatchesContainer: Check = {
  id: 'ticket.project-matches-container',
  category: CATEGORY,
  title: '`project` frontmatter matches containing project slug (or null for standalone)',
  async run(ctx) {
    const { withTicketMd } = await listTickets(ctx);
    const results: CheckResult[] = [];
    for (const a of withTicketMd) {
      const path = resolve(a.ticketDir, 'ticket.md');
      const parsed = await parseSafe(path);
      if (!parsed) continue;
      if (a.standalone) {
        if (parsed.project !== null) {
          results.push({
            id: this.id,
            category: this.category,
            title: this.title,
            status: 'error',
            detail: `standalone/${a.ticketSlug}: frontmatter declares project "${parsed.project}" but the folder is under ~/.syntaur/tickets/ (project must be null)`,
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
            detail: `${a.projectSlug}/${a.ticketSlug}: frontmatter declares project "${parsed.project ?? 'null'}" but the folder is inside project "${a.projectSlug}"`,
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

const draftMissingObjective: Check = {
  id: 'ticket.draft-missing-objective',
  category: CATEGORY,
  title: 'Backlog tickets have a non-empty Objective',
  async run(ctx) {
    const { withTicketMd } = await listTickets(ctx);
    const results: CheckResult[] = [];
    for (const a of withTicketMd) {
      const path = resolve(a.ticketDir, 'ticket.md');
      const parsed = await parseSafe(path);
      if (!parsed) continue;
      if (parsed.status !== 'backlog') continue;
      let raw: string;
      try {
        raw = await readFile(path, 'utf-8');
      } catch {
        continue;
      }
      if (!objectiveBodyIsEmpty(raw)) continue;
      const label = a.standalone ? `standalone/${a.ticketSlug}` : `${a.projectSlug}/${a.ticketSlug}`;
      results.push({
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'warn',
        detail: `${label} (status: backlog) has an empty or placeholder ## Objective`,
        affected: [path],
        remediation: {
          kind: 'manual',
          suggestion: `Flesh out the Objective and Acceptance Criteria, then run 'syntaur plan create ${a.ticketId ?? a.ticketSlug}'`,
          command: null,
        },
        autoFixable: false,
      });
    }
    if (results.length === 0) return pass(this);
    return results;
  },
};

const readyToImplementMissingPlan: Check = {
  id: 'ticket.ready-to-implement-missing-plan',
  category: CATEGORY,
  title: 'ready tickets have a plan.md (or plan-v<N>.md)',
  async run(ctx) {
    const { withTicketMd } = await listTickets(ctx);
    const results: CheckResult[] = [];
    for (const a of withTicketMd) {
      const path = resolve(a.ticketDir, 'ticket.md');
      const parsed = await parseSafe(path);
      if (!parsed) continue;
      if (parsed.status !== 'ready') continue;
      const entries = await readdir(a.ticketDir).catch(() => [] as string[]);
      const planFiles = entries.filter((f) => /^plan(?:-v\d+)?\.md$/i.test(f));
      let hasPlanContent = false;
      for (const f of planFiles) {
        try {
          const c = await readFile(resolve(a.ticketDir, f), 'utf-8');
          if (c.trim().length > 0) {
            hasPlanContent = true;
            break;
          }
        } catch {
          // ignore
        }
      }
      if (hasPlanContent) continue;
      const label = a.standalone ? `standalone/${a.ticketSlug}` : `${a.projectSlug}/${a.ticketSlug}`;
      results.push({
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'warn',
        detail: `${label} (status: ready) has no plan.md or plan-v<N>.md`,
        affected: [resolve(a.ticketDir, 'plan.md')],
        remediation: {
          kind: 'manual',
          suggestion: `Write a plan with 'syntaur plan create ${a.ticketId ?? a.ticketSlug}'`,
          command: null,
        },
        autoFixable: false,
      });
    }
    if (results.length === 0) return pass(this);
    return results;
  },
};

export const ticketChecks: Check[] = [
  requiredFiles,
  orphanedFolder,
  invalidStatus,
  workspaceMissing,
  requiredFilesByStatus,
  companionFilesScaffolded,
  templateMissing,
  templateKnown,
  projectFrontmatterMatchesContainer,
  draftMissingObjective,
  readyToImplementMissingPlan,
];

async function parseSafe(path: string): Promise<ReturnType<typeof parseTicketFull> | null> {
  try {
    const content = await readFile(path, 'utf-8');
    return parseTicketFull(content);
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
