import { Router, type Request, type Response } from 'express';
import { resolve, basename, isAbsolute } from 'node:path';
import { rm, readFile, stat as fsStat, realpath as fsRealpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { executeTransition, unambiguousCommandTarget } from '../lifecycle/index.js';
import { appendStatusHistoryEntry } from '../lifecycle/frontmatter.js';
import { recordEvent } from '../db/events-db.js';
import { isValidSlug, slugify } from '../utils/slug.js';
import { generateId } from '../utils/uuid.js';
import { allocateTicketId, derivePrefix } from '../utils/ticket-ids.js';
import { formatTicketFolderName } from '../utils/ticket-folder.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { ensureDir, writeFileForce, fileExists } from '../utils/fs.js';
import {
  createWorktreeAndRecord,
  GitWorktreeError,
  listBranches,
  detectDefaultBranch,
} from '../utils/git-worktree.js';
import { computeWorktreeDefaults } from '../utils/worktree-defaults.js';
import { validateBranchName } from '../utils/branch-name.js';
import { recreateForTarget, recreateOutcomeToHttp } from './worktree-recreate.js';
import {
  getProjectRepositoryCandidates,
  getProjectSourceTickets,
} from './repository-candidates.js';
import {
  parseTicketFull,
  parseDecisionRecord,
  parseHandoff,
  parseProject,
  parsePlan,
  parseScratchpad,
} from './parser.js';
import { toggleAcceptanceCriterion } from './acceptance-criteria.js';
import {
  getTicketDetail,
  getTicketDetailById,
  getEditableDocument,
  getEditableDocumentById,
  getProjectDetail,
  getStatusConfig,
  installRecordsInvalidation,
  resolveProjectPath,
} from './api.js';
import { resolveTicketById } from '../utils/ticket-resolver.js';
import { renderProgress } from '../templates/index.js';
import { executeTransitionByDir } from '../lifecycle/index.js';
import { runEngineTransition, runEngineOverride } from '../lifecycle/engine-transition.js';
import {
  renderProject,
  renderManifest,
  renderIndexTickets,
  renderIndexPlans,
  renderIndexDecisions,
  renderStatus,
  renderTicket,
  renderScratchpad,
  renderHandoff,
  renderDecisionRecord,
  renderComments,
  formatCommentEntry,
  type Comment,
  type CommentType,
} from '../templates/index.js';
import { parseComments } from './parser.js';
import { appendLogEntry, setTopLevelField } from '../lifecycle/log-append.js';
import { setCommentResolved } from '../lifecycle/comment-resolve.js';

export { setTopLevelField } from '../lifecycle/log-append.js';

/**
 * Dashboard audit emit (best-effort): all dashboard mutations are attributed to
 * `'human'`. `recordEvent` is best-effort and never throws, so a failed emit
 * never 500s the route.
 */
function emitDashboardEvent(
  ticketId: string,
  projectSlug: string | null,
  type: string,
  details: Record<string, unknown>,
): void {
  if (!ticketId) return; // can't attribute without an id — skip silently
  recordEvent({ ticketId, projectSlug, type, actor: 'human', details });
}

/**
 * WS-2 (codex r3 blocker / r5): on a MIGRATED ticket the raw whole-document
 * PATCH must not be a hidden mover. Default-deny allow-list — only inert
 * scalar-metadata edits pass; any field that moves a ticket or alters derived/
 * gate/pause state is rejected (the caller uses the move/transition path). `null`
 * = no violation. `blockedReason` is NOT inert (it derives the `blocked` fact the
 * engine's `isPaused` reads), so it is rejected too.
 */
export function rawPatchMoverViolation(
  current: ReturnType<typeof parseTicketFull>,
  next: ReturnType<typeof parseTicketFull>,
): string | null {
  const j = (v: unknown): string => JSON.stringify(v ?? null);
  if (next.status !== current.status) return 'status';
  if (next.disposition !== current.disposition) return 'disposition';
  if (next.phase !== current.phase) return 'phase';
  if (next.parked !== current.parked) return 'parked';
  if (next.blockedReason !== current.blockedReason) return 'blockedReason';
  // WS-3 T9: the retired session-stage scalars stay rejected post-migration —
  // they are ENGINE-FED (set/cleared inside the work-start CAS payload), so a
  // raw edit would desync the compiled gates' `NOT reworkRequested:true` hold.
  if (next.reviewRequested !== current.reviewRequested) return 'reviewRequested';
  if (next.reworkRequested !== current.reworkRequested) return 'reworkRequested';
  if (next.implementationStarted !== current.implementationStarted) return 'implementationStarted';
  if (j(next.override) !== j(current.override)) return 'override';
  if (j(next.plan) !== j(current.plan)) return 'plan';
  if (j(next.facts) !== j(current.facts)) return 'facts';
  if (j(next.attestations) !== j(current.attestations)) return 'attestations';
  if (j(next.statusHistory) !== j(current.statusHistory)) return 'statusHistory';
  // WS-2 stage-engine state (codex review blocker 1) — a raw edit must not
  // pause/resume (`hold`) or rewrite any engine bookkeeping locklessly.
  if (next.hold !== current.hold) return 'hold';
  if (j(next.gateOverrides) !== j(current.gateOverrides)) return 'gateOverrides';
  if (j(next.frozenChecks) !== j(current.frozenChecks)) return 'frozenChecks';
  if (j(next.firedVerdicts) !== j(current.firedVerdicts)) return 'firedVerdicts';
  if (j(next.solicitations) !== j(current.solicitations)) return 'solicitations';
  return null;
}

interface TrackedFields {
  id: string;
  project: string | null;
  status: string;
  priority: string;
  assignee: string | null;
  archived: boolean;
}

/**
 * Emit events for every tracked frontmatter field that changed between `before`
 * and `after` on a raw-edit/create route (R1 diff path). `status-change` is
 * already emitted inline at the four raw-edit sites (it needs the seeded
 * statusHistory `command`), so it is NOT re-emitted here. All actor `'human'`.
 */
function emitTrackedFieldDiffs(
  before: TrackedFields,
  after: TrackedFields,
  projectSlug: string | null,
): void {
  const id = after.id || before.id;
  if (after.priority !== before.priority) {
    emitDashboardEvent(id, projectSlug, 'priority-change', {
      from: before.priority,
      to: after.priority,
    });
  }
  if (after.assignee !== before.assignee) {
    emitDashboardEvent(id, projectSlug, 'assignee-change', {
      from: before.assignee,
      to: after.assignee,
    });
  }
  if (after.archived !== before.archived) {
    emitDashboardEvent(id, projectSlug, after.archived ? 'archived' : 'restored', {});
  }
}

function extractFrontmatter(content: string): Record<string, string> | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---\n') && !trimmed.startsWith('---\r\n')) {
    return null;
  }

  const afterFirst = trimmed.indexOf('\n') + 1;
  const closingIdx = trimmed.indexOf('\n---', afterFirst);
  if (closingIdx === -1) {
    return null;
  }

  const yamlBlock = trimmed.slice(afterFirst, closingIdx);
  const fields: Record<string, string> = {};

  for (const line of yamlBlock.split('\n')) {
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!match) {
      continue;
    }

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[match[1]] = value;
  }

  return fields;
}

function validateRequired(
  fields: Record<string, string>,
  required: string[],
): { valid: true } | { valid: false; missing: string[] } {
  const missing = required.filter((key) => !fields[key] || fields[key] === 'null');
  if (missing.length > 0) {
    return { valid: false, missing };
  }
  return { valid: true };
}

/**
 * Apply (or clear) the orthogonal archive fields on a project.md / ticket.md
 * frontmatter string. On archive: stamps `archivedAt` + optional `archivedReason`.
 * On restore: clears all three. Always bumps `updated`. `status` is never touched,
 * so restore preserves the prior status exactly.
 */
function applyArchiveFields(content: string, archived: boolean, reason: string | null): string {
  let next = setTopLevelField(content, 'archived', archived);
  next = setTopLevelField(next, 'archivedAt', archived ? nowTimestamp() : null);
  next = setTopLevelField(next, 'archivedReason', archived ? reason : null);
  next = setTopLevelField(next, 'updated', nowTimestamp());
  return next;
}

function requireContent(req: Request, res: Response): string | null {
  const { content } = req.body || {};
  if (!content || typeof content !== 'string' || !content.trim()) {
    res.status(400).json({ error: 'content is required' });
    return null;
  }
  return content;
}

function getParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

async function readCurrentDocument(filePath: string): Promise<string | null> {
  if (!(await fileExists(filePath))) {
    return null;
  }
  return readFile(filePath, 'utf-8');
}

interface WorktreeCreateContext {
  ticketPath: string;
  projectSlug: string;
  ticketSlug: string;
  reload: () => Promise<unknown>;
}

/**
 * Ticket-file paths with a worktree creation currently in flight. Guards
 * the double-submit race that `git worktree add` does NOT catch: two concurrent
 * POSTs for the same ticket with *different* branch names would otherwise
 * both succeed — creating two worktrees and a last-write-wins `workspace.*`.
 * Exported so tests can deterministically assert the 409 path.
 */
export const worktreeInFlight = new Set<string>();

/**
 * Validate a repository input end-to-end: present + non-empty, absolute,
 * exists, is a directory, is a git working tree, and is the work-tree ROOT (not
 * a subdirectory — compared via realpath so symlinks like macOS `/var` →
 * `/private/var` don't cause spurious mismatches). Returns the trimmed repo on
 * success, or a `{ status, error }` envelope using the same messages the
 * worktree-create flow has always produced. Shared by `handleWorktreeCreate`
 * and the `repository-branches` read endpoints so they enforce one contract.
 */
export async function assertRepoRoot(
  repoInput: unknown,
): Promise<{ ok: true; repo: string } | { ok: false; status: number; error: string }> {
  if (typeof repoInput !== 'string' || !repoInput.trim()) {
    return { ok: false, status: 400, error: '`repository` is required.' };
  }
  const repo = repoInput.trim();
  if (!isAbsolute(repo)) {
    return { ok: false, status: 400, error: '`repository` must be an absolute path.' };
  }
  try {
    const st = await fsStat(repo);
    if (!st.isDirectory()) {
      return { ok: false, status: 400, error: `Repository path is not a directory: ${repo}` };
    }
  } catch {
    return { ok: false, status: 400, error: `Repository path does not exist: ${repo}` };
  }
  const topLevel = spawnSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf-8',
  });
  const topLevelOut = topLevel.stdout.trim();
  if (topLevel.status !== 0 || !topLevelOut) {
    return {
      ok: false,
      status: 400,
      error: `Repository path is not a git working tree: ${repo}`,
    };
  }
  const [requestReal, topLevelReal] = await Promise.all([
    fsRealpath(repo),
    fsRealpath(topLevelOut),
  ]);
  if (requestReal !== topLevelReal) {
    return {
      ok: false,
      status: 400,
      error: `Repository path must be the git working-tree root. Got ${repo}; the enclosing repo root is ${topLevelOut}.`,
    };
  }
  return { ok: true, repo };
}

/**
 * Shared body for both worktree-create routes. Validates inputs, runs the
 * disk-collision and parent-branch pre-flights, then calls the same
 * `createWorktreeAndRecord` helper the CLI uses. Returns
 * `{ ticket }` shaped via `reload` on success.
 */
async function handleWorktreeCreate(
  req: Request,
  res: Response,
  ctx: WorktreeCreateContext,
): Promise<void> {
  if (!(await fileExists(ctx.ticketPath))) {
    res.status(404).json({ error: 'Ticket not found' });
    return;
  }

  // Double-submit guard: reject a second concurrent create for this ticket.
  if (worktreeInFlight.has(ctx.ticketPath)) {
    res
      .status(409)
      .json({ error: 'A worktree is already being created for this ticket.' });
    return;
  }
  worktreeInFlight.add(ctx.ticketPath);

  try {
    const parsed = parseTicketFull(await readFile(ctx.ticketPath, 'utf-8'));
    if (parsed.workspace.worktreePath) {
      res
        .status(409)
        .json({ error: 'Worktree already configured for this ticket' });
      return;
    }

    const { repository, branch: bodyBranch, parentBranch: bodyParent } = (req.body ?? {}) as {
      repository?: unknown;
      branch?: unknown;
      parentBranch?: unknown;
    };

    // Branch-name format check on user-supplied input — before ANY git command.
    if (typeof bodyBranch === 'string' && bodyBranch.trim()) {
      const branchError = validateBranchName(bodyBranch.trim());
      if (branchError) {
        res.status(400).json({ error: branchError });
        return;
      }
    }

    // Full repository-input validation (absolute, exists, directory, git root).
    const repoResult = await assertRepoRoot(repository);
    if (!repoResult.ok) {
      res.status(repoResult.status).json({ error: repoResult.error });
      return;
    }
    const repo = repoResult.repo;

    const defaults = computeWorktreeDefaults({
      projectSlug: ctx.projectSlug,
      ticketSlug: ctx.ticketSlug,
      existing: parsed.workspace,
      cwd: repo,
    });
    const branch =
      typeof bodyBranch === 'string' && bodyBranch.trim() ? bodyBranch.trim() : defaults.branch!;
    const parentBranch =
      typeof bodyParent === 'string' && bodyParent.trim() ? bodyParent.trim() : defaults.parentBranch!;
    const worktreePath = resolve(repo, '.worktrees', branch);

    // Authoritative branch-name validation (catches anything the JS validator
    // misses, and covers a server-derived default branch) — before any mutation.
    const refCheck = spawnSync('git', ['-C', repo, 'check-ref-format', '--branch', branch], {
      encoding: 'utf-8',
    });
    if (refCheck.status !== 0) {
      res.status(400).json({
        error: `Invalid branch name "${branch}". Use letters, numbers, "-", "_", "/" and "." (no spaces or special characters).`,
      });
      return;
    }

    // Branch-exists pre-flight: a plain-language error instead of raw git stderr.
    const branchExists = spawnSync(
      'git',
      ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      { encoding: 'utf-8' },
    );
    if (branchExists.status === 0) {
      res.status(409).json({
        error: `Branch "${branch}" already exists in this repository. Choose a different name.`,
      });
      return;
    }

    // Worktree-path disk collision.
    try {
      await fsStat(worktreePath);
      res.status(409).json({
        error: `A file or directory already exists at ${worktreePath}. Remove it or choose a different branch.`,
      });
      return;
    } catch {
      // ENOENT — good.
    }

    // Parent-branch existence.
    const parentCheck = spawnSync(
      'git',
      ['-C', repo, 'rev-parse', '--verify', '--quiet', parentBranch],
      { encoding: 'utf-8' },
    );
    if (parentCheck.status !== 0) {
      res.status(400).json({
        error: `Parent branch "${parentBranch}" does not exist in ${repo}.`,
      });
      return;
    }

    try {
      await createWorktreeAndRecord({
        ticketPath: ctx.ticketPath,
        repository: repo,
        branch,
        worktreePath,
        parentBranch,
      });
    } catch (error) {
      if (error instanceof GitWorktreeError) {
        res.status(400).json({ error: error.message, stderr: error.stderr });
        return;
      }
      res.status(500).json({ error: (error as Error).message });
      return;
    }

    const ticket = await ctx.reload();
    res.json({ ticket });
  } finally {
    worktreeInFlight.delete(ctx.ticketPath);
  }
}


export function createWriteRouter(projectsDir: string): Router {
  const router = Router();
  // Every mutation here writes a record file; clear the shared records cache
  // once each handler resolves so the next read reflects the change.
  installRecordsInvalidation(router);

  router.get('/api/templates/project', (_req: Request, res: Response) => {
    const content = renderProject({
      id: generateId(),
      slug: 'my-new-project',
      title: 'My New Project',
      timestamp: nowTimestamp(),
      prefix: derivePrefix('my-new-project'),
      nextTicket: 1,
      defaultTemplate: 'feature',
    });
    res.json({ content });
  });

  router.get('/api/templates/ticket', (_req: Request, res: Response) => {
    const content = renderTicket({
      id: generateId(),
      slug: 'my-new-ticket',
      title: 'My New Ticket',
      timestamp: nowTimestamp(),
      priority: 'medium',
      depends_on: [],
      links: [],
      template: 'feature',
    });
    res.json({ content });
  });

  router.get('/api/projects/:slug/edit', async (req: Request, res: Response) => {
    const slug = getParam(req.params.slug);
    const document = await getEditableDocument(projectsDir, 'project', slug);
    if (!document) {
      res.status(404).json({ error: `Project "${slug}" not found` });
      return;
    }
    res.json(document);
  });






  router.post('/api/projects', async (req: Request, res: Response) => {
    try {
      const content = requireContent(req, res);
      if (!content) {
        return;
      }

      const fields = extractFrontmatter(content);
      if (!fields) {
        res.status(400).json({ error: 'Invalid frontmatter: missing --- delimiters' });
        return;
      }

      const validation = validateRequired(fields, ['slug', 'title']);
      if (!validation.valid) {
        res.status(400).json({ error: `Missing required fields: ${validation.missing.join(', ')}` });
        return;
      }

      const slug = fields.slug;
      if (!isValidSlug(slug)) {
        res.status(400).json({ error: `Invalid slug "${slug}". Must be lowercase and hyphen-separated.` });
        return;
      }

      const projectDir = resolve(projectsDir, slug);
      if (await fileExists(projectDir)) {
        res.status(409).json({ error: `Project "${slug}" already exists` });
        return;
      }

      const title = fields.title;
      const timestamp = fields.created || nowTimestamp();

      await ensureDir(resolve(projectDir, 'tickets'));

      await writeFileForce(resolve(projectDir, 'project.md'), content);

      try {
        const companions: Array<[string, string]> = [
          [resolve(projectDir, 'manifest.md'), renderManifest({ slug, timestamp })],
          [resolve(projectDir, '_index-tickets.md'), renderIndexTickets({ slug, title, timestamp })],
          [resolve(projectDir, '_index-plans.md'), renderIndexPlans({ slug, title, timestamp })],
          [resolve(projectDir, '_index-decisions.md'), renderIndexDecisions({ slug, title, timestamp })],
          [resolve(projectDir, '_status.md'), renderStatus({ slug, title, timestamp })],
        ];

        for (const [filePath, fileContent] of companions) {
          await writeFileForce(filePath, fileContent);
        }
      } catch (companionError) {
        try {
          await rm(projectDir, { recursive: true, force: true });
        } catch {
          // Best effort cleanup only.
        }
        throw companionError;
      }

      res.status(201).json({ slug });
    } catch (error) {
      console.error('Error creating project:', error);
      res.status(500).json({ error: `Failed to create project: ${(error as Error).message}` });
    }
  });

  router.post('/api/projects/:slug/tickets', async (req: Request, res: Response) => {
    try {
      const projectSlug = getParam(req.params.slug);
      const projectDir = resolve(projectsDir, projectSlug);
      const projectMdPath = resolve(projectDir, 'project.md');

      if (!(await fileExists(projectMdPath))) {
        res.status(404).json({ error: `Project "${projectSlug}" not found` });
        return;
      }

      const content = requireContent(req, res);
      if (!content) {
        return;
      }

      const fields = extractFrontmatter(content);
      if (!fields) {
        res.status(400).json({ error: 'Invalid frontmatter: missing --- delimiters' });
        return;
      }

      const validation = validateRequired(fields, ['slug', 'title']);
      if (!validation.valid) {
        res.status(400).json({ error: `Missing required fields: ${validation.missing.join(', ')}` });
        return;
      }

      const ticketSlug = fields.slug;
      if (!isValidSlug(ticketSlug)) {
        res.status(400).json({ error: `Invalid slug "${ticketSlug}". Must be lowercase and hyphen-separated.` });
        return;
      }

      const validPriorities = ['low', 'medium', 'high', 'critical'];
      const priority = fields.priority || 'medium';
      if (!validPriorities.includes(priority)) {
        res.status(400).json({ error: `Invalid priority "${priority}". Must be low, medium, high, or critical.` });
        return;
      }

      const timestamp = fields.created || nowTimestamp();
      const ticketId = await allocateTicketId(projectDir);
      const ticketDir = resolve(
        projectDir,
        'tickets',
        formatTicketFolderName(ticketId, ticketSlug),
      );
      if (await fileExists(ticketDir)) {
        res.status(409).json({
          error: `Ticket "${ticketSlug}" already exists in project "${projectSlug}"`,
        });
        return;
      }
      const contentWithId = /^id:\s/m.test(content)
        ? content.replace(/^id:\s*.*$/m, `id: ${ticketId}`)
        : content.replace(/^(---\n)/, `---\nid: ${ticketId}\n`);

      await ensureDir(ticketDir);
      // Raw create bypasses renderTicket, so seed the statusHistory here
      // (only when the body didn't already supply one — never double-seed).
      const parsedCreate = parseTicketFull(contentWithId);
      const seededHere = parsedCreate.statusHistory.length === 0;
      const seededContent = seededHere
        ? appendStatusHistoryEntry(contentWithId, {
            at: timestamp,
            from: null,
            to: parsedCreate.status,
            command: 'create',
            by: null,
          })
        : contentWithId;
      await writeFileForce(resolve(ticketDir, 'ticket.md'), seededContent);

      try {
        const companions: Array<[string, string]> = [
          [resolve(ticketDir, 'scratchpad.md'), renderScratchpad({ ticketSlug, timestamp })],
          [resolve(ticketDir, 'handoff.md'), renderHandoff({ ticketSlug, timestamp })],
          [resolve(ticketDir, 'decision-record.md'), renderDecisionRecord({ ticketSlug, timestamp })],
        ];

        for (const [filePath, fileContent] of companions) {
          await writeFileForce(filePath, fileContent);
        }
      } catch (companionError) {
        try {
          await rm(ticketDir, { recursive: true, force: true });
        } catch {
          // Best effort cleanup only.
        }
        throw companionError;
      }

      // Audit event (best-effort): emit AFTER all companion files are written
      // (FIX 2) — a companion failure removes the dir, so a pre-companion emit
      // would leave a false event. Only when we seeded the statusHistory here.
      if (seededHere) {
        emitDashboardEvent(parsedCreate.id, projectSlug, 'status-change', {
          from: null,
          to: parsedCreate.status,
          command: 'create',
        });
      }

      res.status(201).json({ slug: ticketSlug, projectSlug });
    } catch (error) {
      console.error('Error creating ticket:', error);
      res.status(500).json({ error: `Failed to create ticket: ${(error as Error).message}` });
    }
  });

  router.patch('/api/projects/:slug', async (req: Request, res: Response) => {
    try {
      const projectSlug = getParam(req.params.slug);
      const projectPath = resolve(projectsDir, projectSlug, 'project.md');
      const currentContent = await readCurrentDocument(projectPath);
      if (!currentContent) {
        res.status(404).json({ error: `Project "${projectSlug}" not found` });
        return;
      }

      const nextContentRaw = requireContent(req, res);
      if (!nextContentRaw) {
        return;
      }

      const current = parseProject(currentContent);
      const next = parseProject(nextContentRaw);

      if (!next.slug || !next.title) {
        res.status(400).json({ error: 'Project content must include slug and title.' });
        return;
      }

      if (next.slug !== current.slug) {
        res.status(400).json({ error: 'Project slug cannot be changed once created.' });
        return;
      }

      const nextContent = setTopLevelField(nextContentRaw, 'updated', nowTimestamp());
      await writeFileForce(projectPath, nextContent);

      const project = await getProjectDetail(projectsDir, projectSlug);
      res.json({ project, content: nextContent });
    } catch (error) {
      console.error('Error updating project:', error);
      res.status(500).json({ error: `Failed to update project: ${(error as Error).message}` });
    }
  });


  // Replace a project's workflow binding (defaultWorkflow scalar + workflowByType
  // map). Both are validated against the workflow library; an empty/omitted
  // value clears that part. Used by the ProjectDetail Workflow section (Task 13).
  router.put('/api/projects/:slug/workflow-binding', async (req: Request, res: Response) => {
    try {
      const projectSlug = getParam(req.params.slug);
      const projectDir = resolve(projectsDir, projectSlug);
      if (!(await fileExists(resolve(projectDir, 'project.md')))) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const { readConfig } = await import('../utils/config.js');
      const { getWorkflowLibrary } = await import('../utils/workflow-resolve.js');
      const { setProjectWorkflowBinding } = await import('../utils/project-binding.js');
      const known = new Set(Object.keys(getWorkflowLibrary(await readConfig())));

      const body = req.body ?? {};
      const defaultWorkflow =
        body.defaultWorkflow === undefined || body.defaultWorkflow === null || body.defaultWorkflow === ''
          ? null
          : String(body.defaultWorkflow);
      if (defaultWorkflow !== null && !known.has(defaultWorkflow)) {
        res.status(400).json({ error: `Unknown workflow "${defaultWorkflow}"` });
        return;
      }
      const workflowByType: Record<string, string> = {};
      if (body.workflowByType && typeof body.workflowByType === 'object') {
        for (const [type, wf] of Object.entries(body.workflowByType)) {
          if (typeof wf !== 'string' || wf === '') continue;
          if (!known.has(wf)) {
            res.status(400).json({ error: `Unknown workflow "${wf}" for type "${type}"` });
            return;
          }
          workflowByType[type] = wf;
        }
      }

      await setProjectWorkflowBinding(projectDir, { defaultWorkflow, workflowByType });
      const project = await getProjectDetail(projectsDir, projectSlug);
      res.json({ project });
    } catch (error) {
      console.error('Error updating project workflow binding:', error);
      res.status(500).json({ error: `Failed to update binding: ${(error as Error).message}` });
    }
  });

  // Set (or clear) a single ticket's `workflow:` override, then re-derive
  // against the newly-resolved workflow. Used by the TicketDetail workflow
  // dropdown (Task 13). The field is written BEFORE recompute so the derive runs
  // against the NEW workflow (recompute resolves the binding from disk).
  router.put('/api/tickets/:id/workflow', async (req: Request, res: Response) => {
    try {
const id = getParam(req.params.id);
      const resolved = await resolveTicketById(projectsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Ticket "${id}" not found` });
        return;
      }
      const ticketPath = resolve(resolved.ticketDir, 'ticket.md');
      if (!(await fileExists(ticketPath))) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      const workflow = (req.body ?? {}).workflow;
      const clearing = workflow === null || workflow === undefined || workflow === '';
      if (!clearing) {
        if (typeof workflow !== 'string') {
          res.status(400).json({ error: 'workflow must be a string or null' });
          return;
        }
        const { readConfig } = await import('../utils/config.js');
        const { getWorkflowLibrary } = await import('../utils/workflow-resolve.js');
        const known = new Set(Object.keys(getWorkflowLibrary(await readConfig())));
        if (!known.has(workflow)) {
          res.status(400).json({ error: `Unknown workflow "${workflow}"` });
          return;
        }
      }

      let content = await readFile(ticketPath, 'utf-8');
      if (clearing) {
        const closingIdx = content.indexOf('\n---', 4);
        if (closingIdx !== -1) {
          const fm = content.slice(0, closingIdx).replace(/^workflow:.*\n?/m, '');
          content = fm + content.slice(closingIdx);
        }
      } else {
        content = setTopLevelField(content, 'workflow', workflow as string);
      }
      content = setTopLevelField(content, 'updated', nowTimestamp());
      await writeFileForce(ticketPath, content);

      const { recomputeTicketDir } = await import('../lifecycle/recompute.js');
      await recomputeTicketDir(resolve(ticketPath, '..'), 'workflow-change', 'human');

      const ticket = await getTicketDetailById(projectsDir, id);
      res.json({ ticket });
    } catch (error) {
      console.error('Error setting ticket workflow:', error);
      res.status(500).json({ error: `Failed to set workflow: ${(error as Error).message}` });
    }
  });




  // --- Comments Endpoints ---



  // --- Worktree creation + candidate discovery ---
  // Mirrors the existing CLI flow (`syntaur worktree create`) and the
  // TUI's `runCreate`. All three paths call `createWorktreeAndRecord` so the
  // ticket.md frontmatter ends up identical regardless of entry point.

  router.get(
    '/api/projects/:slug/repository-candidates',
    async (req: Request, res: Response) => {
      try {
        const projectSlug = getParam(req.params.slug);
        const projectPath = resolve(projectsDir, projectSlug, 'project.md');
        if (!(await fileExists(projectPath))) {
          res.status(404).json({ error: `Project "${projectSlug}" not found` });
          return;
        }
        const candidates = await getProjectRepositoryCandidates(projectsDir, projectSlug);
        res.json({ candidates });
      } catch (error) {
        console.error('Error listing repository candidates:', error);
        res.status(500).json({
          error: `Failed to list repository candidates: ${(error as Error).message}`,
        });
      }
    },
  );

  router.get(
    '/api/tickets/:id/repository-candidates',
    async (req: Request, res: Response) => {
      try {
const id = getParam(req.params.id);
        const resolved = await resolveTicketById(projectsDir, id);
        if (!resolved) {
          res.status(404).json({ error: `Ticket "${id}" not found` });
          return;
        }
        const candidates = await getProjectRepositoryCandidates(
          projectsDir,
          resolved.projectSlug,
        );
        res.json({ candidates });
      } catch (error) {
        console.error('Error listing repository candidates:', error);
        res.status(500).json({
          error: `Failed to list repository candidates: ${(error as Error).message}`,
        });
      }
    },
  );

  // List a repository's local branches + best-effort default branch. `repo` is
  // an internal UI value (the selected/derived repo path), not user-typed text.
  async function handleRepositoryBranches(req: Request, res: Response): Promise<void> {
    const repoResult = await assertRepoRoot(
      typeof req.query.repo === 'string' ? req.query.repo : undefined,
    );
    if (!repoResult.ok) {
      res.status(repoResult.status).json({ error: repoResult.error });
      return;
    }
    const [branches, defaultBranch] = await Promise.all([
      listBranches(repoResult.repo),
      detectDefaultBranch(repoResult.repo),
    ]);
    res.json({ branches, defaultBranch });
  }

  router.get(
    '/api/tickets/:id/repository-branches',
    async (req: Request, res: Response) => {
      try {
const id = getParam(req.params.id);
        const resolved = await resolveTicketById(projectsDir, id);
        if (!resolved) {
          res.status(404).json({ error: `Ticket "${id}" not found` });
          return;
        }
        await handleRepositoryBranches(req, res);
      } catch (error) {
        console.error('Error listing repository branches:', error);
        res.status(500).json({
          error: `Failed to list repository branches: ${(error as Error).message}`,
        });
      }
    },
  );

  router.get(
    '/api/tickets/:id/source-tickets',
    async (req: Request, res: Response) => {
      try {
const id = getParam(req.params.id);
        const resolved = await resolveTicketById(projectsDir, id);
        if (!resolved) {
          res.status(404).json({ error: `Ticket "${id}" not found` });
          return;
        }
        const sourceTickets = await getProjectSourceTickets(
          projectsDir,
          resolved.projectSlug,
          resolved.ticketSlug,
        );
        res.json({ sourceTickets });
      } catch (error) {
        console.error('Error listing source tickets:', error);
        res.status(500).json({
          error: `Failed to list source tickets: ${(error as Error).message}`,
        });
      }
    },
  );

  router.post(
    '/api/tickets/:id/worktree',
    async (req: Request, res: Response) => {
      try {
const id = getParam(req.params.id);
        const resolved = await resolveTicketById(projectsDir, id);
        if (!resolved) {
          res.status(404).json({ error: `Ticket "${id}" not found` });
          return;
        }
        const ticketPath = resolve(resolved.ticketDir, 'ticket.md');
        // Standalone: resolveTicketById returns the UUID as `ticketSlug`.
        // For branch naming we need the user-visible slug from frontmatter, so
        // parse it here and pass that down. parseTicketFull falls back to
        // empty string, hence the `|| resolved.id` belt-and-suspenders.
        const parsedForSlug = parseTicketFull(await readFile(ticketPath, 'utf-8'));
        const ticketSlugForBranch = parsedForSlug.slug || resolved.id;
        await handleWorktreeCreate(req, res, {
          ticketPath,
          projectSlug: resolved.projectSlug ?? '',
          ticketSlug: ticketSlugForBranch,
          reload: () => getTicketDetailById(projectsDir!, id),
        });
      } catch (error) {
        console.error('Error creating worktree:', error);
        res
          .status(500)
          .json({ error: `Failed to create worktree: ${(error as Error).message}` });
      }
    },
  );

  // --- Worktree recreate (rebuild a deleted worktree at its exact path) ---
  // Server-authoritative: the path/repo/branch come from persisted state, never
  // the request body. Bypasses the create-flow's "already configured" / "branch
  // exists" 409 guards since recreate intentionally rebuilds an existing record.

  router.post(
    '/api/tickets/:id/worktree/recreate',
    async (req: Request, res: Response) => {
      try {
const id = getParam(req.params.id);
        const outcome = await recreateForTarget(
          { projectsDir },
          { kind: 'ticket', id },
        );
        const { httpStatus, body } = recreateOutcomeToHttp(outcome);
        res.status(httpStatus).json(body);
      } catch (error) {
        console.error('Error recreating worktree:', error);
        res
          .status(500)
          .json({ error: `Failed to recreate worktree: ${(error as Error).message}` });
      }
    },
  );

  // --- Status Override Endpoints ---

  router.post('/api/projects/:slug/status-override', async (req: Request, res: Response) => {
    try {
      const projectSlug = getParam(req.params.slug);
      const projectPath = resolve(projectsDir, projectSlug, 'project.md');
      if (!(await fileExists(projectPath))) {
        res.status(404).json({ error: `Project "${projectSlug}" not found` });
        return;
      }

      const { status } = req.body || {};
      const config = await getStatusConfig();
      // `archived` is no longer a status — use the dedicated /archive endpoints.
      const validStatuses = ['active', ...config.statuses.map((s) => s.id)];
      if (status !== null && (typeof status !== 'string' || !validStatuses.includes(status))) {
        res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}, or null to clear.` });
        return;
      }

      let content = await readFile(projectPath, 'utf-8');
      content = setTopLevelField(content, 'statusOverride', status ?? null);
      content = setTopLevelField(content, 'updated', nowTimestamp());
      await writeFileForce(projectPath, content);

      const project = await getProjectDetail(projectsDir, projectSlug);
      res.json({ project });
    } catch (error) {
      console.error('Error setting project status override:', error);
      res.status(500).json({ error: `Failed to set status override: ${(error as Error).message}` });
    }
  });


  // --- Archive / Restore Endpoints (orthogonal `archived` flag) ---
  // Archiving never touches `status`; restore preserves the prior status. Project
  // archive does NOT stamp child tickets — cascade-hide is computed at read time.

  function archiveReason(body: unknown): string | null {
    const reason = (body as { reason?: unknown } | null)?.reason;
    return typeof reason === 'string' && reason.trim() ? reason : null;
  }

  router.post('/api/projects/:slug/archive', async (req: Request, res: Response) => {
    try {
      const projectSlug = getParam(req.params.slug);
      const projectPath = resolve(projectsDir, projectSlug, 'project.md');
      if (!(await fileExists(projectPath))) {
        res.status(404).json({ error: `Project "${projectSlug}" not found` });
        return;
      }
      const content = await readFile(projectPath, 'utf-8');
      await writeFileForce(projectPath, applyArchiveFields(content, true, archiveReason(req.body)));
      const project = await getProjectDetail(projectsDir, projectSlug);
      res.json({ project });
    } catch (error) {
      console.error('Error archiving project:', error);
      res.status(500).json({ error: `Failed to archive project: ${(error as Error).message}` });
    }
  });

  router.post('/api/projects/:slug/unarchive', async (req: Request, res: Response) => {
    try {
      const projectSlug = getParam(req.params.slug);
      const projectPath = resolve(projectsDir, projectSlug, 'project.md');
      if (!(await fileExists(projectPath))) {
        res.status(404).json({ error: `Project "${projectSlug}" not found` });
        return;
      }
      const content = await readFile(projectPath, 'utf-8');
      await writeFileForce(projectPath, applyArchiveFields(content, false, null));
      const project = await getProjectDetail(projectsDir, projectSlug);
      res.json({ project });
    } catch (error) {
      console.error('Error restoring project:', error);
      res.status(500).json({ error: `Failed to restore project: ${(error as Error).message}` });
    }
  });

  async function handleTicketArchiveById(
    req: Request,
    res: Response,
    archived: boolean,
  ): Promise<void> {
const id = getParam(req.params.id);
    const resolved = await resolveTicketById(projectsDir, id);
    if (!resolved) {
      res.status(404).json({ error: `Ticket "${id}" not found` });
      return;
    }
    const ticketPath = resolve(resolved.ticketDir, 'ticket.md');
    const content = await readFile(ticketPath, 'utf-8');
    const reason = archived ? archiveReason(req.body) : null;
    await writeFileForce(ticketPath, applyArchiveFields(content, archived, reason));

    const parsed = parseTicketFull(content);
    emitDashboardEvent(
      parsed.id || resolved.id,
      resolved.projectSlug,
      archived ? 'archived' : 'restored',
      reason ? { reason } : {},
    );

    const ticket = await getTicketDetailById(projectsDir, id);
    res.json({ ticket });
  }

  router.delete('/api/tickets/:id', async (req: Request, res: Response) => {
    try {
const id = getParam(req.params.id);
      const resolved = await resolveTicketById(projectsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Ticket "${id}" not found` });
        return;
      }
      await rm(resolved.ticketDir, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (error) {
      console.error('Error deleting ticket:', error);
      res.status(500).json({ error: `Failed to delete ticket: ${(error as Error).message}` });
    }
  });

  router.post('/api/tickets/:id/archive', async (req: Request, res: Response) => {
    try {
      await handleTicketArchiveById(req, res, true);
    } catch (error) {
      console.error('Error archiving ticket:', error);
      res.status(500).json({ error: `Failed to archive ticket: ${(error as Error).message}` });
    }
  });

  router.post('/api/tickets/:id/unarchive', async (req: Request, res: Response) => {
    try {
      await handleTicketArchiveById(req, res, false);
    } catch (error) {
      console.error('Error restoring ticket:', error);
      res.status(500).json({ error: `Failed to restore ticket: ${(error as Error).message}` });
    }
  });



  // --- Lifecycle Transitions ---




  router.post('/api/tickets/:id/comments', async (req: Request, res: Response) => {
    try {
const id = getParam(req.params.id);
      const resolved = await resolveTicketById(projectsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Ticket "${id}" not found` });
        return;
      }
      await appendCommentTo(resolved.ticketDir, resolved.ticketSlug, req, res, async () => {
        return getTicketDetailById(projectsDir, id);
      });
    } catch (error) {
      console.error('Error appending comment (by id):', error);
      res.status(500).json({ error: `Failed to append comment: ${(error as Error).message}` });
    }
  });

  router.patch('/api/tickets/:id/comments/:commentId/resolved', async (req: Request, res: Response) => {
    try {
const id = getParam(req.params.id);
      const commentId = getParam(req.params.commentId);
      const resolved = await resolveTicketById(projectsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Ticket "${id}" not found` });
        return;
      }
      await toggleCommentResolvedAt(resolved.ticketDir, commentId, req, res, async () => {
        return getTicketDetailById(projectsDir, id);
      });
    } catch (error) {
      console.error('Error toggling comment resolved (by id):', error);
      res.status(500).json({ error: `Failed to toggle resolved: ${(error as Error).message}` });
    }
  });

  router.get('/api/tickets/:id/edit', async (req: Request, res: Response) => {
const id = getParam(req.params.id);
    const doc = await getEditableDocumentById(projectsDir, 'ticket', id);
    if (!doc) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }
    res.json(doc);
  });

  router.get('/api/tickets/:id/plan/edit', async (req: Request, res: Response) => {
const id = getParam(req.params.id);
    const doc = await getEditableDocumentById(projectsDir, 'plan', id);
    if (!doc) {
      res.status(404).json({ error: 'Plan not found' });
      return;
    }
    res.json(doc);
  });

  router.get('/api/tickets/:id/scratchpad/edit', async (req: Request, res: Response) => {
const id = getParam(req.params.id);
    const doc = await getEditableDocumentById(projectsDir, 'scratchpad', id);
    if (!doc) {
      res.status(404).json({ error: 'Scratchpad not found' });
      return;
    }
    res.json(doc);
  });

  router.get('/api/tickets/:id/handoff/edit', async (req: Request, res: Response) => {
const id = getParam(req.params.id);
    const doc = await getEditableDocumentById(projectsDir, 'handoff', id);
    if (!doc) {
      res.status(404).json({ error: 'Handoff log not found' });
      return;
    }
    res.json(doc);
  });

  router.get('/api/tickets/:id/decision-record/edit', async (req: Request, res: Response) => {
const id = getParam(req.params.id);
    const doc = await getEditableDocumentById(projectsDir, 'decision-record', id);
    if (!doc) {
      res.status(404).json({ error: 'Decision record not found' });
      return;
    }
    res.json(doc);
  });

  router.patch('/api/tickets/:id', async (req: Request, res: Response) => {
    try {
const id = getParam(req.params.id);
      const resolved = await resolveTicketById(projectsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Ticket "${id}" not found` });
        return;
      }

      const ticketPath = resolve(resolved.ticketDir, 'ticket.md');
      const currentContent = await readCurrentDocument(ticketPath);
      if (!currentContent) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }

      const nextContentRaw = requireContent(req, res);
      if (!nextContentRaw) return;

      const current = parseTicketFull(currentContent);
      const next = parseTicketFull(nextContentRaw);

      if (!next.title) {
        res.status(400).json({ error: 'Ticket content must include a title.' });
        return;
      }

      // WS-2: same engine-active-mover guard as the project raw PATCH (both
      // routes; codex review blocker 4 — gate on a resolved workflow, not the
      // marker alone).
      const byIdProjectDir = resolve(resolved.ticketDir, '..', '..');
      const { isEngineActiveForTicket } = await import('../lifecycle/engine-transition.js');
      if (await isEngineActiveForTicket(ticketPath, byIdProjectDir)) {
        const violation = rawPatchMoverViolation(current, next);
        if (violation) {
          res.status(400).json({
            error: `Field "${violation}" cannot be changed via a raw edit on a stage-managed ticket — use a move/transition.`,
          });
          return;
        }
      }

      // Restore id + project + slug frontmatter (immutable after create).
      let nextContent = nextContentRaw;
      if (current.id) nextContent = setTopLevelField(nextContent, 'id', current.id);
      nextContent = setTopLevelField(nextContent, 'project', resolved.projectSlug);
      if (current.slug) nextContent = setTopLevelField(nextContent, 'slug', current.slug);

      const now = nowTimestamp();

      if (next.status !== current.status && current.status === 'blocked' && next.status !== 'blocked') {
        nextContent = setTopLevelField(nextContent, 'blockedReason', null);
      }

      nextContent = setTopLevelField(nextContent, 'updated', now);

      // Record a transition when a raw edit changes the status (conditional).
      if (next.status !== current.status) {
        nextContent = appendStatusHistoryEntry(nextContent, {
          at: now,
          from: current.status,
          to: next.status,
          command: 'edit',
          by: null,
        });
      }

      await writeFileForce(ticketPath, nextContent);

      const ticketId = current.id || next.id;
      if (next.status !== current.status) {
        emitDashboardEvent(ticketId, resolved.projectSlug, 'status-change', {
          from: current.status,
          to: next.status,
          command: 'edit',
        });
      }
      emitTrackedFieldDiffs(
        { id: current.id, project: resolved.projectSlug, status: current.status, priority: current.priority, assignee: current.assignee, archived: current.archived },
        { id: current.id, project: resolved.projectSlug, status: next.status, priority: next.priority, assignee: next.assignee, archived: next.archived },
        resolved.projectSlug,
      );

      const ticket = await getTicketDetailById(projectsDir, id);
      res.json({ ticket, content: nextContent });
    } catch (error) {
      console.error('Error updating ticket:', error);
      res.status(500).json({ error: `Failed to update ticket: ${(error as Error).message}` });
    }
  });

  router.patch('/api/tickets/:id/plan', async (req: Request, res: Response) => {
    try {
const id = getParam(req.params.id);
      const resolved = await resolveTicketById(projectsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Ticket "${id}" not found` });
        return;
      }

      const planPath = resolve(resolved.ticketDir, 'plan.md');
      const currentContent = await readCurrentDocument(planPath);
      if (!currentContent) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }
      const nextContentRaw = requireContent(req, res);
      if (!nextContentRaw) return;

      const parsed = parsePlan(nextContentRaw);
      if (!parsed.ticket) {
        res.status(400).json({ error: 'Plan content must include the ticket field.' });
        return;
      }

      const nextContent = setTopLevelField(nextContentRaw, 'updated', nowTimestamp());
      await writeFileForce(planPath, nextContent);

      const ticket = await getTicketDetailById(projectsDir, id);
      res.json({ ticket, content: nextContent });
    } catch (error) {
      console.error('Error updating standalone plan:', error);
      res.status(500).json({ error: `Failed to update plan: ${(error as Error).message}` });
    }
  });

  router.patch('/api/tickets/:id/scratchpad', async (req: Request, res: Response) => {
    try {
const id = getParam(req.params.id);
      const resolved = await resolveTicketById(projectsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Ticket "${id}" not found` });
        return;
      }

      const scratchpadPath = resolve(resolved.ticketDir, 'scratchpad.md');
      const currentContent = await readCurrentDocument(scratchpadPath);
      if (!currentContent) {
        res.status(404).json({ error: 'Scratchpad not found' });
        return;
      }
      const nextContentRaw = requireContent(req, res);
      if (!nextContentRaw) return;

      const parsed = parseScratchpad(nextContentRaw);
      if (!parsed.ticket) {
        res.status(400).json({ error: 'Scratchpad content must include the ticket field.' });
        return;
      }

      const nextContent = setTopLevelField(nextContentRaw, 'updated', nowTimestamp());
      await writeFileForce(scratchpadPath, nextContent);

      const ticket = await getTicketDetailById(projectsDir, id);
      res.json({ ticket, content: nextContent });
    } catch (error) {
      console.error('Error updating standalone scratchpad:', error);
      res.status(500).json({ error: `Failed to update scratchpad: ${(error as Error).message}` });
    }
  });

  router.post('/api/tickets/:id/handoff/entries', async (req: Request, res: Response) => {
    try {
const id = getParam(req.params.id);
      const resolved = await resolveTicketById(projectsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Ticket "${id}" not found` });
        return;
      }
      const handoffPath = resolve(resolved.ticketDir, 'handoff.md');
      const currentContent = await readCurrentDocument(handoffPath);
      if (!currentContent) {
        res.status(404).json({ error: 'Handoff log not found' });
        return;
      }
      const { title, body } = req.body || {};
      if (!body || typeof body !== 'string' || !body.trim()) {
        res.status(400).json({ error: 'body is required' });
        return;
      }
      const parsed = parseHandoff(currentContent);
      const nextContent = appendLogEntry(
        currentContent,
        'handoffCount',
        parsed.handoffCount + 1,
        title && typeof title === 'string' && title.trim() ? title.trim() : `Handoff ${parsed.handoffCount + 1}`,
        body,
        'No handoffs recorded yet.',
      );
      await writeFileForce(handoffPath, nextContent);
      const ticket = await getTicketDetailById(projectsDir, id);
      res.status(201).json({ ticket, content: nextContent });
    } catch (error) {
      console.error('Error appending standalone handoff entry:', error);
      res.status(500).json({ error: `Failed to append handoff entry: ${(error as Error).message}` });
    }
  });

  router.post('/api/tickets/:id/decision-record/entries', async (req: Request, res: Response) => {
    try {
const id = getParam(req.params.id);
      const resolved = await resolveTicketById(projectsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Ticket "${id}" not found` });
        return;
      }
      const decisionPath = resolve(resolved.ticketDir, 'decision-record.md');
      const currentContent = await readCurrentDocument(decisionPath);
      if (!currentContent) {
        res.status(404).json({ error: 'Decision record not found' });
        return;
      }
      const { title, body } = req.body || {};
      if (!body || typeof body !== 'string' || !body.trim()) {
        res.status(400).json({ error: 'body is required' });
        return;
      }
      const parsed = parseDecisionRecord(currentContent);
      const nextContent = appendLogEntry(
        currentContent,
        'decisionCount',
        parsed.decisionCount + 1,
        title && typeof title === 'string' && title.trim() ? title.trim() : `Decision ${parsed.decisionCount + 1}`,
        body,
        'No decisions recorded yet.',
      );
      await writeFileForce(decisionPath, nextContent);
      const ticket = await getTicketDetailById(projectsDir, id);
      res.status(201).json({ ticket, content: nextContent });
    } catch (error) {
      console.error('Error appending standalone decision entry:', error);
      res.status(500).json({ error: `Failed to append decision entry: ${(error as Error).message}` });
    }
  });

  router.post('/api/tickets/:id/status-override', async (req: Request, res: Response) => {
    try {
const id = getParam(req.params.id);
      const resolved = await resolveTicketById(projectsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Ticket "${id}" not found` });
        return;
      }
      const ticketPath = resolve(resolved.ticketDir, 'ticket.md');
      if (!(await fileExists(ticketPath))) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      const { status } = req.body || {};
      const clearing = status === null;
      const projectDirForId = resolve(resolved.ticketDir, '..', '..');

      // WS-2 (Decision 1): engine-active → `manual-override` engine move (parity
      // with the project route). Try it BEFORE the legacy status-id validation —
      // a valid stage id need not be a legacy status id (codex review major 5).
      // `null` ⇒ not engine-active → the legacy pin path below.
      if (clearing || typeof status === 'string') {
        const engineOverride = await runEngineOverride({
          ticketPath,
          projectDir: projectDirForId,
          status: clearing ? null : status,
          by: 'human',
        });
        if (engineOverride) {
          if (!engineOverride.ok) {
            res.status(engineOverride.code).json({ error: engineOverride.message });
            return;
          }
          const ticket = await getTicketDetailById(projectsDir, id);
          res.json({ ticket });
          return;
        }
      }

      const config = await getStatusConfig();
      const validStatuses = config.statuses.map((s) => s.id);
      if (!clearing && (typeof status !== 'string' || !validStatuses.includes(status))) {
        res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}.` });
        return;
      }
      // Derived-status v3: PIN semantics, same contract as the project route
      // (codex r2 finding 2 — the by-id route had been left imperative).
      if (!clearing && config.terminalStatuses.has(status)) {
        res.status(400).json({
          error: `"${status}" is terminal — use the complete/fail transition (gated), not an override.`,
        });
        return;
      }
      const { recomputeAndWrite, resolveRecomputeContext } = await import('../lifecycle/recompute.js');
      const { updateOverride } = await import('../lifecycle/frontmatter.js');
      const { context, workflowResolver } = await resolveRecomputeContext();
      const result = await recomputeAndWrite(ticketPath, {
        cause: clearing ? 'unpin' : 'pin',
        by: 'human',
        projectDir: projectDirForId,
        context,
        workflowResolver,
        mutate: (content) => {
          if (clearing) return updateOverride(content, null);
          const current = parseTicketFull(content);
          if (current.override?.status === status) return content; // idempotent
          return updateOverride(content, { status, source: 'human', reason: null, at: nowTimestamp() });
        },
      });
      if (result.deferredTerminal) {
        res.status(409).json({ error: 'Ticket is terminal — reopen it first.' });
        return;
      }
      if (result.warning) {
        res.status(503).json({ error: result.warning });
        return;
      }
      const ticket = await getTicketDetailById(projectsDir, id);
      res.json({ ticket });
    } catch (error) {
      console.error('Error overriding standalone status:', error);
      res.status(500).json({ error: `Failed to override status: ${(error as Error).message}` });
    }
  });

  router.patch('/api/tickets/:id/assignee', async (req: Request, res: Response) => {
    try {
const id = getParam(req.params.id);
      const resolved = await resolveTicketById(projectsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Ticket "${id}" not found` });
        return;
      }
      const ticketPath = resolve(resolved.ticketDir, 'ticket.md');
      if (!(await fileExists(ticketPath))) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      const validation = validateAssigneeBody(req.body);
      if (!validation.ok) {
        res.status(400).json({ error: validation.error });
        return;
      }
      let content = await readFile(ticketPath, 'utf-8');
      const prior = parseTicketFull(content);
      content = setTopLevelField(content, 'assignee', validation.value);
      content = setTopLevelField(content, 'updated', nowTimestamp());
      await writeFileForce(ticketPath, content);

      if (prior.assignee !== validation.value) {
        emitDashboardEvent(prior.id || id, resolved.projectSlug, 'assignee-change', {
          from: prior.assignee,
          to: validation.value,
        });
      }

      const ticket = await getTicketDetailById(projectsDir, id);
      res.json({ ticket });
    } catch (error) {
      console.error('Error updating standalone assignee:', error);
      res.status(500).json({ error: `Failed to update assignee: ${(error as Error).message}` });
    }
  });

  router.patch('/api/tickets/:id/title', async (req: Request, res: Response) => {
    try {
const id = getParam(req.params.id);
      const resolved = await resolveTicketById(projectsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Ticket "${id}" not found` });
        return;
      }
      const ticketPath = resolve(resolved.ticketDir, 'ticket.md');
      if (!(await fileExists(ticketPath))) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      const validation = validateTitleBody(req.body);
      if (!validation.ok) {
        res.status(400).json({ error: validation.error });
        return;
      }
      let content = await readFile(ticketPath, 'utf-8');
      content = setTopLevelField(content, 'title', validation.value);
      content = setTopLevelField(content, 'updated', nowTimestamp());
      await writeFileForce(ticketPath, content);
      const ticket = await getTicketDetailById(projectsDir, id);
      res.json({ ticket });
    } catch (error) {
      console.error('Error updating standalone title:', error);
      res.status(500).json({ error: `Failed to update title: ${(error as Error).message}` });
    }
  });

  router.patch('/api/tickets/:id/acceptance-criteria/:index', async (req: Request, res: Response) => {
    try {
const id = getParam(req.params.id);
      const resolved = await resolveTicketById(projectsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Ticket "${id}" not found` });
        return;
      }
      const ticketPath = resolve(resolved.ticketDir, 'ticket.md');
      const currentContent = await readCurrentDocument(ticketPath);
      if (!currentContent) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      const { checked } = req.body || {};
      if (typeof checked !== 'boolean') {
        res.status(400).json({ error: 'checked must be a boolean' });
        return;
      }
      const index = Number.parseInt(getParam(req.params.index), 10);
      const result = toggleAcceptanceCriterion(currentContent, index, checked);
      if ('error' in result) {
        res.status(400).json({ error: result.error });
        return;
      }
      const nextContent = setTopLevelField(result.content, 'updated', nowTimestamp());
      await writeFileForce(ticketPath, nextContent);
      const ticket = await getTicketDetailById(projectsDir, id);
      res.json({ ticket, content: nextContent });
    } catch (error) {
      console.error('Error toggling standalone acceptance criterion:', error);
      res.status(500).json({ error: `Failed to toggle acceptance criterion: ${(error as Error).message}` });
    }
  });

  router.post('/api/tickets/:id/transitions/:command', async (req: Request, res: Response) => {
    try {
const id = getParam(req.params.id);
      const command = getParam(req.params.command);
      const resolved = await resolveTicketById(projectsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Ticket "${id}" not found` });
        return;
      }

      const { reason } = req.body || {};
      const config = await getStatusConfig();
      // Parity with the project route (codex r3 finding 2): only configured
      // commands are executable.
      const validCommandsById = [...new Set(config.transitions.map((t) => t.command))];
      if (!validCommandsById.includes(command)) {
        res.status(400).json({ error: `Unsupported transition command "${command}"` });
        return;
      }
      const { recomputeAndWrite, recomputeDependents, resolveRecomputeContext } = await import(
        '../lifecycle/recompute.js'
      );
      const { context, workflowResolver } = await resolveRecomputeContext();
      const byIdPath = resolve(resolved.ticketDir, 'ticket.md');
      const byIdProjectDir = resolve(resolved.ticketDir, '..', '..');

      // Same derived-status routing as the project route (codex r2 finding 2):
      // block/unblock = fact mutations in-lock; terminal commands honor the
      // custom target and settle; everything else settles after the transition.
      if (command === 'block' || command === 'unblock') {
        const { updateTicketFile } = await import('../lifecycle/frontmatter.js');
        const result = await recomputeAndWrite(byIdPath, {
          cause: command,
          by: 'human',
          projectDir: byIdProjectDir,
          context,
          workflowResolver,
          reason: typeof reason === 'string' ? reason : undefined,
          mutate: (content) =>
            updateTicketFile(content, {
              blockedReason:
                command === 'block' ? (typeof reason === 'string' && reason ? reason : '(unspecified)') : null,
            }),
        });
        if (result.deferredTerminal) {
          res.status(409).json({ error: 'Ticket is terminal — reopen it first.' });
          return;
        }
        if (result.warning) {
          res.status(503).json({ error: result.warning });
          return;
        }
        const detail = await getTicketDetailById(projectsDir, id);
        res.json({ ticket: detail, warnings: [] });
        return;
      }

      // WS-2 (Decision 1): migrated complete/fail/reopen → ENGINE move (parity
      // with the project route and the CLI). `null` ⇒ ladder fall-through below.
      const engineResult = await runEngineTransition({
        ticketPath: byIdPath,
        projectDir: byIdProjectDir,
        command,
        by: 'human',
        reason: typeof reason === 'string' ? reason : undefined,
      });
      if (engineResult) {
        if (!engineResult.success) {
          res.status(400).json({ error: engineResult.message, fromStatus: engineResult.fromStatus });
          return;
        }
        if (byIdProjectDir) {
          await recomputeDependents(byIdProjectDir, resolved.ticketSlug, {
            cause: 'dep-terminal',
            by: 'system',
            context,
            workflowResolver,
          });
        }
        const detail = await getTicketDetailById(projectsDir, id);
        res.json({ ticket: detail, warnings: engineResult.warnings ?? [] });
        return;
      }

      // WS-2 (codex review blocker 2): reject engine-active commands the engine
      // didn't handle rather than falling through to the lockless legacy path.
      const { isEngineActiveForTicket } = await import('../lifecycle/engine-transition.js');
      if (await isEngineActiveForTicket(byIdPath, byIdProjectDir)) {
        res.status(400).json({
          error: `"${command}" is not available on a stage-managed ticket — use complete/fail/reopen, block/unblock, or a board move.`,
        });
        return;
      }

      const GATED_TERMINAL = new Set(['complete', 'fail', 'reopen']);
      const gatedFallbackById = GATED_TERMINAL.has(command)
        ? unambiguousCommandTarget(config.transitions, command)
        : undefined;
      const transitionResult = await executeTransitionByDir(
        resolved.ticketDir,
        command as any,
        {
          reason: typeof reason === 'string' ? reason : undefined,
          // Dashboard click → audit actor 'human' (independent of assignee). FIX 1.
          auditActor: 'human',
          // Same resolution as the project route: from-specific mapping wins,
          // unambiguous command target as guard-free fallback for gated
          // terminal commands. NOTE: by-id historically ran guard-free for
          // all commands; the custom from-table now applies only to gated
          // commands' resolution (their fallback), keeping non-terminal by-id
          // behavior guard-free as before.
          commandTargets:
            config.custom && gatedFallbackById ? new Map([[command, gatedFallbackById]]) : undefined,
          transitionTable: config.custom && GATED_TERMINAL.has(command) ? config.transitionTable : undefined,
          terminalStatuses: config.custom ? config.terminalStatuses : undefined,
        },
      );
      if (!transitionResult.success) {
        res.status(400).json({ error: transitionResult.message, fromStatus: transitionResult.fromStatus });
        return;
      }

      // Settle BEFORE responding (incl. the reopen convergence event).
      const settledById = await recomputeAndWrite(byIdPath, {
        cause: command,
        by: 'human',
        projectDir: byIdProjectDir,
        context,
        workflowResolver,
      });
      if (settledById.warning) {
        res.status(503).json({ error: settledById.warning });
        return;
      }
      if (byIdProjectDir) {
        const wasTerminal = config.terminalStatuses.has(transitionResult.fromStatus);
        const isTerminal = transitionResult.toStatus
          ? config.terminalStatuses.has(transitionResult.toStatus)
          : false;
        if (wasTerminal !== isTerminal) {
          await recomputeDependents(byIdProjectDir, resolved.ticketSlug, {
            cause: 'dep-terminal',
            by: 'system',
            context,
            workflowResolver,
          });
        }
      }

      const detail = await getTicketDetailById(projectsDir, id);
      res.json({ ticket: detail, warnings: transitionResult.warnings ?? [] });
    } catch (error) {
      console.error('Error transitioning by id:', error);
      res.status(500).json({ error: `Failed to transition: ${(error as Error).message}` });
    }
  });

  router.post('/api/tickets/:id/plan/approve', async (req: Request, res: Response) => {
    try {
const id = getParam(req.params.id);
      const resolved = await resolveTicketById(projectsDir, id);
      if (!resolved) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      const { planApproveCommand } = await import('../commands/derive-verbs.js');
      await planApproveCommand(resolved.id, {
        project: resolved.projectSlug ?? undefined,
      });
      const ticket = await getTicketDetailById(projectsDir, id);
      res.json({ ticket });
    } catch (error) {
      const message = (error as Error).message;
      res.status(409).json({ error: message });
    }
  });

  return router;
}

type AssigneeValidation =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

function validateAssigneeBody(body: unknown): AssigneeValidation {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Body must include `assignee` (string or null).' };
  }
  const assignee = (body as Record<string, unknown>).assignee;
  if (assignee === null) return { ok: true, value: null };
  if (typeof assignee !== 'string') {
    return { ok: false, error: '`assignee` must be a string or null.' };
  }
  const trimmed = assignee.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > 120) {
    return { ok: false, error: '`assignee` must be 120 characters or fewer.' };
  }
  return { ok: true, value: trimmed };
}

type TitleValidation =
  | { ok: true; value: string }
  | { ok: false; error: string };

function validateTitleBody(body: unknown): TitleValidation {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Body must include `title` (non-empty string).' };
  }
  const title = (body as Record<string, unknown>).title;
  if (typeof title !== 'string') {
    return { ok: false, error: '`title` must be a string.' };
  }
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: '`title` is required.' };
  }
  if (trimmed.length > 200) {
    return { ok: false, error: '`title` must be 200 characters or fewer.' };
  }
  // The frontmatter parser does not unescape \" and setTopLevelField rewrites
  // a single matched line via ^…$/m — newlines and embedded double-quotes
  // would corrupt the frontmatter block. Cleanest mitigation: reject.
  if (/["\r\n]/.test(trimmed)) {
    return { ok: false, error: '`title` may not contain double quotes or line breaks.' };
  }
  return { ok: true, value: trimmed };
}

async function appendCommentTo(
  ticketDir: string,
  ticketRef: string,
  req: Request,
  res: Response,
  reloadDetail: () => Promise<unknown>,
): Promise<void> {
  const commentsPath = resolve(ticketDir, 'comments.md');
  const { body, author, type, replyTo } = req.body || {};
  if (!body || typeof body !== 'string' || !body.trim()) {
    res.status(400).json({ error: 'body is required' });
    return;
  }
  const commentType: CommentType = type && ['question', 'note', 'feedback'].includes(type) ? type : 'note';
  const timestamp = nowTimestamp();
  // author/replyTo are single-line metadata. A newline breaks parseComments'
  // single-line header regex and makes the whole comment unreadable, so reject it.
  if (typeof author === 'string' && /[\r\n]/.test(author)) {
    res.status(400).json({ error: 'author must not contain newlines' });
    return;
  }
  if (typeof replyTo === 'string' && /[\r\n]/.test(replyTo)) {
    res.status(400).json({ error: 'replyTo must not contain newlines' });
    return;
  }
  const entryAuthor = (typeof author === 'string' && author.trim()) ? author.trim() : 'human';

  let currentContent: string;
  let currentCount = 0;
  if (await fileExists(commentsPath)) {
    currentContent = await readFile(commentsPath, 'utf-8');
    const countMatch = currentContent.match(/^entryCount:\s*(\d+)/m);
    if (countMatch) currentCount = parseInt(countMatch[1], 10);
  } else {
    currentContent = renderComments({ ticket: ticketRef, timestamp });
  }

  const comment: Comment = {
    id: generateId().split('-')[0],
    timestamp,
    author: entryAuthor,
    type: commentType,
    body,
    replyTo: typeof replyTo === 'string' && replyTo.trim() ? replyTo.trim() : undefined,
    resolved: commentType === 'question' ? false : undefined,
  };
  const entry = formatCommentEntry(comment);
  let next = setTopLevelField(currentContent, 'entryCount', String(currentCount + 1));
  next = setTopLevelField(next, 'updated', timestamp);
  if (next.includes('No comments yet.')) {
    next = next.replace('No comments yet.', entry.trimEnd());
  } else {
    next = `${next.trimEnd()}\n\n${entry}`;
  }
  await writeFileForce(commentsPath, next);

  // Audit event (best-effort): comment-added. Author + excerpt ONLY.
  try {
    const ticketMdPath = resolve(ticketDir, 'ticket.md');
    if (await fileExists(ticketMdPath)) {
      const fm = parseTicketFull(await readFile(ticketMdPath, 'utf-8'));
      emitDashboardEvent(fm.id, fm.project, 'comment-added', {
        commentId: comment.id,
        author: entryAuthor,
        commentType,
        length: body.length,
        excerpt: body.slice(0, 80),
      });
    }
  } catch {
    /* best-effort */
  }

  const ticket = await reloadDetail();
  res.status(201).json({ ticket, comment: { id: comment.id } });
}

async function toggleCommentResolvedAt(
  ticketDir: string,
  commentId: string,
  req: Request,
  res: Response,
  reloadDetail: () => Promise<unknown>,
): Promise<void> {
  const commentsPath = resolve(ticketDir, 'comments.md');
  if (!(await fileExists(commentsPath))) {
    res.status(404).json({ error: 'Comments file not found' });
    return;
  }
  const { resolved: desired } = req.body || {};
  if (typeof desired !== 'boolean') {
    res.status(400).json({ error: 'resolved (boolean) is required' });
    return;
  }

  const { changed, previous } = await setCommentResolved(ticketDir, commentId, desired);
  if (previous === null) {
    const content = await readFile(commentsPath, 'utf-8');
    const parsed = parseComments(content);
    const target = parsed.entries.find((e) => e.id === commentId);
    if (!target) {
      res.status(404).json({ error: `Comment ${commentId} not found` });
      return;
    }
    res.status(400).json({ error: 'Only questions can be resolved' });
    return;
  }
  if (!changed && previous !== desired) {
    res.status(500).json({ error: 'Failed to update resolved flag' });
    return;
  }

  // Audit event (best-effort): only on the actual unresolved→resolved
  // transition (FIX 6) — an idempotent PATCH must not emit a duplicate.
  if (changed && previous === false && desired === true) {
    try {
      const ticketMdPath = resolve(ticketDir, 'ticket.md');
      if (await fileExists(ticketMdPath)) {
        const fm = parseTicketFull(await readFile(ticketMdPath, 'utf-8'));
        emitDashboardEvent(fm.id, fm.project, 'comment-resolved', { commentId });
      }
    } catch {
      /* best-effort */
    }
  }

  const ticket = await reloadDetail();
  res.json({ ticket });
}
