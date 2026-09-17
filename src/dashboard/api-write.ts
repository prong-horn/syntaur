import { Router, type Request, type Response } from 'express';
import { resolve, basename, isAbsolute } from 'node:path';
import { rm, readFile, stat as fsStat, realpath as fsRealpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import {
  moveTicket,
  flagTicket,
  VerbRefusedError,
  GateFailedError,
  resolveLifecycleActor,
  type MoveVerb,
  type FlagVerb,
} from '../lifecycle/verbs.js';
import {
  completeStageEntry,
  completeStageEntryAfterRecordFailure,
  recordStageEntryLocked,
} from '../lifecycle/stage-entry.js';
import { withTicketMutationLock } from '../utils/ticket-mutation-lock.js';
import { createInProcessStageDispatch } from '../chat/dispatch-client.js';
import type { ChatBroker } from '../chat/broker.js';
import { PROJECT_ROLLUP_STATUSES } from './stage-config.js';
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
  withWorktreePath,
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
  installRecordsInvalidation,
  resolveProjectPath,
} from './api.js';
import { resolveTicketById } from '../utils/ticket-resolver.js';
import { renderProgress } from '../templates/index.js';
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
} from '../templates/index.js';
import { appendTypedLogEntry, setTopLevelField } from '../lifecycle/log-append.js';
import { LOG_ENTRY_TYPES, logRoleFile, type LogEntryType } from '../ticket-templates/manifest.js';
import { parseLogEntries } from '../ticket-templates/log-reader.js';
import { buildShow } from '../ticket-templates/show.js';
import { parseTicketFrontmatter, updatePlanBlock } from '../lifecycle/frontmatter.js';
import { syntaurRoot } from '../utils/paths.js';
import {
  listTemplates,
  loadTemplate,
  resolveTemplateContentDir,
  resolveTemplateForTicket,
} from '../ticket-templates/registry.js';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';
import {
  scaffoldTemplateFiles,
  scaffoldedPlanPaths,
} from '../ticket-templates/scaffold.js';
import { planFileFor } from '../ticket-templates/roles.js';

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
 * = no violation. The `blocked` flag is NOT inert (the engine's `isPaused` reads
 * it), so it is rejected too.
 */
export function rawPatchMoverViolation(
  current: ReturnType<typeof parseTicketFull>,
  next: ReturnType<typeof parseTicketFull>,
): string | null {
  const j = (v: unknown): string => JSON.stringify(v ?? null);
  if (next.status !== current.status) return 'status';
  if (next.parked !== current.parked) return 'parked';
  if (next.blocked !== current.blocked) return 'blocked';
  if (j(next.plan) !== j(current.plan)) return 'plan';
  return null;
}

interface TrackedFields {
  id: string;
  project: string | null;
  status: string;
  priority: string;
  assignee: string | null;
  archived?: boolean;
}

/**
 * Emit events for every tracked frontmatter field that changed between `before`
 * and `after` on a raw-edit/create route (R1 diff path). `status-change` is
 * already emitted inline at the four raw-edit sites, so it is NOT re-emitted
 * here. All actor `'human'`.
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
    if (parsed.workspace.worktree) {
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
    const wtDir = resolve(repo, '.worktrees', branch);

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
      await fsStat(wtDir);
      res.status(409).json({
        error: `A file or directory already exists at ${wtDir}. Remove it or choose a different branch.`,
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
        parentBranch,
        ...withWorktreePath(wtDir),
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


export interface WriteRouterOptions {
  broker?: ChatBroker;
}

export function createWriteRouter(projectsDir: string, opts: WriteRouterOptions = {}): Router {
  const inProcessDispatch = opts.broker
    ? createInProcessStageDispatch(opts.broker, projectsDir)
    : undefined;
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
      const projectContent = await readFile(projectMdPath, 'utf-8');
      const project = parseProject(projectContent);
      const root = syntaurRoot();
      await seedMissingBuiltins(root);
      const availableTemplates = await listTemplates(root);
      const templateId = fields.template || project.defaultTemplate || 'feature';
      if (!availableTemplates.some((t) => t.id === templateId)) {
        res.status(400).json({
          error: `Unknown template "${templateId}". Available: ${availableTemplates.map((t) => t.id).join(', ')}`,
        });
        return;
      }

      const manifest = await loadTemplate(root, templateId);
      const validPriorities = ['low', 'medium', 'high', 'critical'];
      const priority = fields.priority || manifest.defaultPriority;
      if (!validPriorities.includes(priority)) {
        res.status(400).json({ error: `Invalid priority "${priority}". Must be low, medium, high, or critical.` });
        return;
      }

      let contentWithId = /^id:\s/m.test(content)
        ? content.replace(/^id:\s*.*$/m, `id: ${ticketId}`)
        : content.replace(/^(---\n)/, `---\nid: ${ticketId}\n`);

      if (!/^template:\s/m.test(contentWithId)) {
        contentWithId = contentWithId.replace(/^(---\n)/, `---\ntemplate: ${templateId}\n`);
      }

      if (!/^priority:\s/m.test(contentWithId)) {
        contentWithId = contentWithId.replace(/^(---\n)/, `---\npriority: ${priority}\n`);
      }

      await ensureDir(ticketDir);
      const parsedCreate = parseTicketFull(contentWithId);
      let seededContent = contentWithId;

      try {
        const templateDir = await resolveTemplateContentDir(root, templateId);
        const scaffolded = await scaffoldTemplateFiles({
          ticketDir,
          templateDir,
          template: manifest,
          ticketSlug,
          ticketTitle: fields.title,
          timestamp,
          when: 'ticket-creation',
        });
        const planWritten = scaffoldedPlanPaths(scaffolded, manifest);
        if (planWritten.length > 0) {
          seededContent = updatePlanBlock(seededContent, {
            file: planWritten[0],
            approvedDigest: null,
            approvedAt: null,
            approvedBy: null,
          });
        }

        await writeFileForce(resolve(ticketDir, 'ticket.md'), seededContent);
      } catch (companionError) {
        try {
          await rm(ticketDir, { recursive: true, force: true });
        } catch {
          // Best effort cleanup only.
        }
        throw companionError;
      }

      const initialStatus = manifest.stages[0]?.id ?? 'backlog';
      const ticketPath = resolve(ticketDir, 'ticket.md');
      type PendingCreation =
        | { kind: 'recorded'; entry: ReturnType<typeof recordStageEntryLocked> }
        | { kind: 'failed'; error: string };
      let pending: PendingCreation | undefined;

      await withTicketMutationLock(ticketPath, async () => {
        try {
          pending = {
            kind: 'recorded',
            entry: recordStageEntryLocked({
              ticketId: parsedCreate.id,
              projectSlug,
              actor: 'human',
              at: timestamp,
              eventType: 'created',
              stage: initialStatus,
              manifest,
            }),
          };
        } catch (err) {
          pending = {
            kind: 'failed',
            error: err instanceof Error ? err.message : String(err),
          };
        }
      });

      if (pending?.kind === 'recorded') {
        await completeStageEntry({
          ticketId: parsedCreate.id,
          ticketDir,
          projectSlug,
          ticketSlug,
          entry: pending.entry,
          actor: 'human',
          dispatch: inProcessDispatch,
        });
      } else if (pending?.kind === 'failed') {
        await completeStageEntryAfterRecordFailure({
          ticketId: parsedCreate.id,
          ticketDir,
          projectSlug,
          ticketSlug,
          actor: 'human',
          dispatch: inProcessDispatch,
          stage: initialStatus,
          error: pending.error,
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
      const validStatuses = [...PROJECT_ROLLUP_STATUSES];
      if (
        status !== null &&
        (typeof status !== 'string' ||
          !(PROJECT_ROLLUP_STATUSES as readonly string[]).includes(status))
      ) {
        res.status(400).json({
          error: `Invalid status. Must be one of: ${validStatuses.join(', ')}, or null to clear.`,
        });
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

  // --- Lifecycle Transitions ---




  router.post('/api/tickets/:id/log', async (req: Request, res: Response) => {
    try {
      const id = getParam(req.params.id);
      const resolved = await resolveTicketById(projectsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Ticket "${id}" not found` });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const typeRaw = typeof body.type === 'string' ? body.type.trim() : '';
      const text = typeof body.body === 'string' ? body.body.trim() : '';
      if (!typeRaw || !(LOG_ENTRY_TYPES as readonly string[]).includes(typeRaw)) {
        res.status(400).json({ error: 'type is required and must be a valid log entry type' });
        return;
      }
      if (!text) {
        res.status(400).json({ error: 'body is required' });
        return;
      }
      const type = typeRaw as LogEntryType;
      const ticketMd = await readFile(resolve(resolved.ticketDir, 'ticket.md'), 'utf-8');
      const fm = parseTicketFrontmatter(ticketMd);
      const manifest = await loadTemplate(syntaurRoot(), resolveTemplateForTicket(fm));
      const logRole = logRoleFile(manifest);
      if (!logRole) {
        res.status(400).json({ error: 'template has no log role' });
        return;
      }
      if (!logRole.entryTypes.includes(type)) {
        res.status(400).json({ error: `entry type "${type}" is not allowed on this template` });
        return;
      }
      const keys: Record<string, string> = {};
      if (type === 'review') {
        const verdict = typeof body.verdict === 'string' ? body.verdict.trim() : '';
        const openRaw = typeof body.open === 'string' ? body.open.trim() : '';
        if (!verdict || !openRaw) {
          res.status(400).json({ error: 'review requires verdict and open' });
          return;
        }
        if (verdict !== 'approve' && verdict !== 'changes') {
          res.status(400).json({ error: 'review verdict must be approve or changes' });
          return;
        }
        const parts = openRaw.split(',').map((s) => s.trim());
        let high: number | null = null;
        let medium: number | null = null;
        for (const part of parts) {
          const hm = part.match(/^high=(\d+)$/);
          const mm = part.match(/^medium=(\d+)$/);
          if (hm) high = parseInt(hm[1], 10);
          else if (mm) medium = parseInt(mm[1], 10);
          else {
            res.status(400).json({ error: `Invalid open value: ${openRaw}` });
            return;
          }
        }
        if (high === null || medium === null) {
          res.status(400).json({ error: 'review requires verdict and open' });
          return;
        }
        keys.verdict = `${verdict} · open: high=${high} medium=${medium}`;
      }
      if (type === 'answer') {
        const answers = typeof body.answers === 'string' ? body.answers.trim() : '';
        if (!answers) {
          res.status(400).json({ error: 'answer requires answers timestamp' });
          return;
        }
        const logPath = resolve(resolved.ticketDir, logRole.path);
        if (!(await fileExists(logPath))) {
          res.status(400).json({ error: `No question entry at ${answers}` });
          return;
        }
        const entries = parseLogEntries(await readFile(logPath, 'utf-8'));
        if (!entries.some((e) => e.type === 'question' && e.timestamp === answers)) {
          res.status(400).json({ error: `No question entry at ${answers}` });
          return;
        }
        keys.answers = answers;
      }
      const result = await appendTypedLogEntry({
        ticketDir: resolved.ticketDir,
        ticketId: id,
        projectSlug: resolved.projectSlug,
        type,
        body: text,
        author: 'human',
        keys: Object.keys(keys).length > 0 ? keys : undefined,
      });
      const showModel = await buildShow(syntaurRoot(), resolved.ticketDir);
      res.status(201).json({
        entry: { timestamp: result.timestamp, type, author: 'human', firstLine: text.split('\n')[0] ?? '' },
        next: showModel.next,
      });
    } catch (error) {
      console.error('Error appending log entry:', error);
      res.status(500).json({ error: `Failed to append log entry: ${(error as Error).message}` });
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

      const violation = rawPatchMoverViolation(current, next);
      if (violation) {
        res.status(400).json({
          error: `Field "${violation}" cannot be changed via a raw edit — use a lifecycle verb.`,
        });
        return;
      }

      // Restore id + project + slug frontmatter (immutable after create).
      let nextContent = nextContentRaw;
      if (current.id) nextContent = setTopLevelField(nextContent, 'id', current.id);
      nextContent = setTopLevelField(nextContent, 'project', resolved.projectSlug);
      if (current.slug) nextContent = setTopLevelField(nextContent, 'slug', current.slug);

      const now = nowTimestamp();

      nextContent = setTopLevelField(nextContent, 'updated', now);

      await writeFileForce(ticketPath, nextContent);

      const ticketId = current.id || next.id;
      emitTrackedFieldDiffs(
        { id: current.id, project: resolved.projectSlug, status: current.status, priority: current.priority, assignee: current.assignee },
        { id: current.id, project: resolved.projectSlug, status: next.status, priority: next.priority, assignee: next.assignee },
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

      const ticketMdPath = resolve(resolved.ticketDir, 'ticket.md');
      const ticketFm = parseTicketFull(await readFile(ticketMdPath, 'utf-8'));
      const root = syntaurRoot();
      const manifest = await loadTemplate(root, ticketFm.template ?? 'legacy');
      const planRel = planFileFor(ticketFm, manifest);
      if (!planRel) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }
      const planPath = resolve(resolved.ticketDir, planRel);
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

  const MOVE_VERBS = new Set<string>([
    'plan',
    'approve',
    'start',
    'review',
    'done',
    'drop',
    'reopen',
  ]);
  const FLAG_VERBS = new Set<string>(['block', 'unblock', 'park', 'unpark']);

  router.post('/api/tickets/:id/verbs/:verb', async (req: Request, res: Response) => {
    try {
      const id = getParam(req.params.id);
      const verb = getParam(req.params.verb);
      const resolved = await resolveTicketById(projectsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Ticket "${id}" not found` });
        return;
      }

      const body = req.body ?? {};
      const reason = typeof body.reason === 'string' ? body.reason : undefined;
      const by = typeof body.by === 'string' ? body.by : undefined;
      const dispatchAgent =
        verb === 'start' && typeof body.agent === 'string' ? body.agent : undefined;
      if (typeof body.agent === 'string' && verb !== 'start') {
        res.status(400).json({ error: 'agent override is only valid for start' });
        return;
      }
      const force = Boolean(body.force);
      const actor = resolveLifecycleActor({ actor: by });
      const options = {
        force,
        reason,
        actor,
        dispatchAgent,
        dispatch: inProcessDispatch,
        project: resolved.projectSlug ?? undefined,
      };

      let moveResult: Awaited<ReturnType<typeof moveTicket>> | undefined;
      if (MOVE_VERBS.has(verb)) {
        moveResult = await moveTicket(id, verb as MoveVerb, options);
      } else if (FLAG_VERBS.has(verb)) {
        await flagTicket(id, verb as FlagVerb, reason ?? null, options);
      } else {
        res.status(400).json({ error: `Unsupported verb "${verb}"` });
        return;
      }

      const ticket = await getTicketDetailById(projectsDir, id);
      res.json({
        ticket,
        next: ticket?.next ?? null,
        ...(moveResult?.dispatch ? { dispatch: moveResult.dispatch } : {}),
        ...(moveResult?.warnings?.length ? { warnings: moveResult.warnings } : {}),
      });
    } catch (error) {
      if (error instanceof GateFailedError) {
        res.status(409).json({ error: error.message, next: error.next });
        return;
      }
      if (error instanceof VerbRefusedError) {
        res.status(400).json({ error: error.message });
        return;
      }
      console.error('Error running verb:', error);
      res.status(500).json({ error: `Failed to run verb: ${(error as Error).message}` });
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
