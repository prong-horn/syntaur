import { Router, type Request, type Response } from 'express';
import { resolve, basename, isAbsolute } from 'node:path';
import { rm, readFile, open as fsOpen, stat as fsStat, realpath as fsRealpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { executeTransition } from '../lifecycle/index.js';
import { isValidSlug, slugify } from '../utils/slug.js';
import { generateId } from '../utils/uuid.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { ensureDir, writeFileForce, fileExists } from '../utils/fs.js';
import {
  createWorktreeAndRecord,
  GitWorktreeError,
} from '../utils/git-worktree.js';
import { computeWorktreeDefaults } from '../utils/worktree-defaults.js';
import {
  getProjectRepositoryCandidates,
  getStandaloneRepositoryCandidates,
} from './repository-candidates.js';
import {
  parseAssignmentFull,
  parseDecisionRecord,
  parseHandoff,
  parseMemory,
  parseProject,
  parsePlan,
  parseResource,
  parseScratchpad,
} from './parser.js';
import { toggleAcceptanceCriterion } from './acceptance-criteria.js';
import {
  getAssignmentDetail,
  getAssignmentDetailById,
  getEditableDocument,
  getEditableDocumentById,
  getMemoryDetail,
  getProjectDetail,
  getResourceDetail,
  getStatusConfig,
  resolveProjectPath,
} from './api.js';
import { resolveAssignmentById } from '../utils/assignment-resolver.js';
import { renderProgress } from '../templates/index.js';
import { executeTransitionByDir } from '../lifecycle/index.js';
import {
  renderProject,
  renderManifest,
  renderIndexAssignments,
  renderIndexPlans,
  renderIndexDecisions,
  renderStatus,
  renderResourcesIndex,
  renderMemoriesIndex,
  renderMemoryStub,
  renderResourceStub,
  renderAssignment,
  renderScratchpad,
  renderHandoff,
  renderDecisionRecord,
  renderComments,
  formatCommentEntry,
  type Comment,
  type CommentType,
} from '../templates/index.js';
import { parseComments } from './parser.js';

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

function formatYamlValue(value: boolean | number | string | null): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return `"${value}"`;
  }
  if (value === '' || /[:#{}[\],&*?|>!%@`]/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function setTopLevelField(
  content: string,
  key: string,
  value: boolean | number | string | null,
): string {
  const formatted = formatYamlValue(value);
  const fieldRegex = new RegExp(`^(${escapeRegExp(key)}:)\\s*.*$`, 'm');

  if (fieldRegex.test(content)) {
    return content.replace(fieldRegex, `$1 ${formatted}`);
  }

  const closingIdx = content.indexOf('\n---', 4);
  if (closingIdx === -1) {
    return content;
  }

  return `${content.slice(0, closingIdx)}\n${key}: ${formatted}${content.slice(closingIdx)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function appendLogEntry(
  existingContent: string,
  countField: 'handoffCount' | 'decisionCount',
  nextCount: number,
  heading: string,
  body: string,
  emptyPlaceholder: string,
): string {
  const timestamp = nowTimestamp();
  let next = setTopLevelField(existingContent, 'updated', timestamp);
  next = setTopLevelField(next, countField, nextCount);

  const entryBody = body.trim();
  const entry = `## ${heading}\n\n**Recorded:** ${timestamp}\n\n${entryBody}\n`;

  if (next.includes(emptyPlaceholder)) {
    return next.replace(emptyPlaceholder, entry.trimEnd());
  }

  return `${next.trimEnd()}\n\n${entry}`;
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
  assignmentPath: string;
  projectSlug: string;
  assignmentSlug: string;
  reload: () => Promise<unknown>;
}

/**
 * Shared body for both worktree-create routes. Validates inputs, runs the
 * disk-collision and parent-branch pre-flights, then calls the same
 * `createWorktreeAndRecord` helper the CLI / browse TUI use. Returns
 * `{ assignment }` shaped via `reload` on success.
 */
async function handleWorktreeCreate(
  req: Request,
  res: Response,
  ctx: WorktreeCreateContext,
): Promise<void> {
  if (!(await fileExists(ctx.assignmentPath))) {
    res.status(404).json({ error: 'Assignment not found' });
    return;
  }

  const parsed = parseAssignmentFull(await readFile(ctx.assignmentPath, 'utf-8'));
  if (parsed.workspace.worktreePath) {
    res
      .status(409)
      .json({ error: 'Worktree already configured for this assignment' });
    return;
  }

  const { repository, branch: bodyBranch, parentBranch: bodyParent } = (req.body ?? {}) as {
    repository?: unknown;
    branch?: unknown;
    parentBranch?: unknown;
  };

  if (typeof repository !== 'string' || !repository.trim()) {
    res.status(400).json({ error: '`repository` is required.' });
    return;
  }
  if (!isAbsolute(repository)) {
    res
      .status(400)
      .json({ error: '`repository` must be an absolute path.' });
    return;
  }
  try {
    const st = await fsStat(repository);
    if (!st.isDirectory()) {
      res
        .status(400)
        .json({ error: `Repository path is not a directory: ${repository}` });
      return;
    }
  } catch {
    res
      .status(400)
      .json({ error: `Repository path does not exist: ${repository}` });
    return;
  }
  const topLevel = spawnSync('git', ['-C', repository, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf-8',
  });
  const topLevelOut = topLevel.stdout.trim();
  if (topLevel.status !== 0 || !topLevelOut) {
    res
      .status(400)
      .json({ error: `Repository path is not a git working tree: ${repository}` });
    return;
  }
  // The plan requires the request `repository` to be the repo root, not a
  // subdirectory. `git -C <subdir> rev-parse --show-toplevel` succeeds for
  // any path inside a working tree, so we have to compare paths. Use
  // `realpath` so symlinks (e.g. macOS `/var` → `/private/var`) don't
  // produce spurious mismatches.
  const [requestReal, topLevelReal] = await Promise.all([
    fsRealpath(repository),
    fsRealpath(topLevelOut),
  ]);
  if (requestReal !== topLevelReal) {
    res.status(400).json({
      error:
        `Repository path must be the git working-tree root. Got ${repository}; the enclosing repo root is ${topLevelOut}.`,
    });
    return;
  }

  const defaults = computeWorktreeDefaults({
    projectSlug: ctx.projectSlug,
    assignmentSlug: ctx.assignmentSlug,
    existing: parsed.workspace,
    cwd: repository,
  });
  const branch =
    typeof bodyBranch === 'string' && bodyBranch.trim() ? bodyBranch.trim() : defaults.branch!;
  const parentBranch =
    typeof bodyParent === 'string' && bodyParent.trim() ? bodyParent.trim() : defaults.parentBranch!;
  const worktreePath = resolve(repository, '.worktrees', branch);

  try {
    await fsStat(worktreePath);
    res.status(409).json({
      error: `A file or directory already exists at ${worktreePath}. Remove it or choose a different branch.`,
    });
    return;
  } catch {
    // ENOENT — good.
  }

  const parentCheck = spawnSync(
    'git',
    ['-C', repository, 'rev-parse', '--verify', '--quiet', parentBranch],
    { encoding: 'utf-8' },
  );
  if (parentCheck.status !== 0) {
    res.status(400).json({
      error: `Parent branch "${parentBranch}" does not exist in ${repository}.`,
    });
    return;
  }

  try {
    await createWorktreeAndRecord({
      assignmentPath: ctx.assignmentPath,
      repository,
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

  const assignment = await ctx.reload();
  res.json({ assignment });
}

export function createWriteRouter(
  projectsDir: string,
  assignmentsDir?: string,
  todosDir?: string,
): Router {
  const linkedTodosLookup = todosDir ? { todosDir, projectsDir } : undefined;
  const router = Router();

  router.get('/api/templates/project', (_req: Request, res: Response) => {
    const content = renderProject({
      id: generateId(),
      slug: 'my-new-project',
      title: 'My New Project',
      timestamp: nowTimestamp(),
    });
    res.json({ content });
  });

  router.get('/api/templates/assignment', (req: Request, res: Response) => {
    const standalone = req.query.standalone === '1';
    const workspaceParam = typeof req.query.workspace === 'string' ? req.query.workspace : '';
    if (workspaceParam && !isValidSlug(workspaceParam)) {
      res.status(400).json({
        error: `Invalid workspace slug "${workspaceParam}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
      });
      return;
    }
    const content = renderAssignment({
      id: generateId(),
      slug: 'my-new-assignment',
      title: 'My New Assignment',
      timestamp: nowTimestamp(),
      priority: 'medium',
      dependsOn: [],
      links: [],
      project: standalone ? null : undefined,
      workspaceGroup: standalone && workspaceParam ? workspaceParam : null,
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

  router.get('/api/projects/:slug/assignments/:aslug/edit', async (req: Request, res: Response) => {
    const slug = getParam(req.params.slug);
    const assignmentSlug = getParam(req.params.aslug);
    const document = await getEditableDocument(
      projectsDir,
      'assignment',
      slug,
      assignmentSlug,
    );
    if (!document) {
      res.status(404).json({ error: 'Assignment not found' });
      return;
    }
    res.json(document);
  });

  router.get('/api/projects/:slug/assignments/:aslug/plan/edit', async (req: Request, res: Response) => {
    const slug = getParam(req.params.slug);
    const assignmentSlug = getParam(req.params.aslug);
    const document = await getEditableDocument(
      projectsDir,
      'plan',
      slug,
      assignmentSlug,
    );
    if (!document) {
      res.status(404).json({ error: 'Plan not found' });
      return;
    }
    res.json(document);
  });

  router.get('/api/projects/:slug/assignments/:aslug/scratchpad/edit', async (req: Request, res: Response) => {
    const slug = getParam(req.params.slug);
    const assignmentSlug = getParam(req.params.aslug);
    const document = await getEditableDocument(
      projectsDir,
      'scratchpad',
      slug,
      assignmentSlug,
    );
    if (!document) {
      res.status(404).json({ error: 'Scratchpad not found' });
      return;
    }
    res.json(document);
  });

  router.get('/api/projects/:slug/assignments/:aslug/handoff/edit', async (req: Request, res: Response) => {
    const slug = getParam(req.params.slug);
    const assignmentSlug = getParam(req.params.aslug);
    const document = await getEditableDocument(
      projectsDir,
      'handoff',
      slug,
      assignmentSlug,
    );
    if (!document) {
      res.status(404).json({ error: 'Handoff log not found' });
      return;
    }
    res.json(document);
  });

  router.get('/api/projects/:slug/assignments/:aslug/decision-record/edit', async (req: Request, res: Response) => {
    const slug = getParam(req.params.slug);
    const assignmentSlug = getParam(req.params.aslug);
    const document = await getEditableDocument(
      projectsDir,
      'decision-record',
      slug,
      assignmentSlug,
    );
    if (!document) {
      res.status(404).json({ error: 'Decision record not found' });
      return;
    }
    res.json(document);
  });

  router.get('/api/projects/:slug/memories/:itemSlug/edit', async (req: Request, res: Response) => {
    const slug = getParam(req.params.slug);
    const itemSlug = getParam(req.params.itemSlug);
    if (!isValidSlug(itemSlug)) {
      res.status(400).json({ error: 'Invalid memory slug.' });
      return;
    }
    const projectDir = await resolveProjectPath(projectsDir, slug);
    if (!projectDir) {
      res.status(404).json({ error: `Project "${slug}" not found` });
      return;
    }
    const document = await getEditableDocument(projectsDir, 'memory', basename(projectDir), itemSlug);
    if (!document) {
      res.status(404).json({ error: 'Memory not found' });
      return;
    }
    res.json(document);
  });

  router.get('/api/projects/:slug/resources/:itemSlug/edit', async (req: Request, res: Response) => {
    const slug = getParam(req.params.slug);
    const itemSlug = getParam(req.params.itemSlug);
    if (!isValidSlug(itemSlug)) {
      res.status(400).json({ error: 'Invalid resource slug.' });
      return;
    }
    const projectDir = await resolveProjectPath(projectsDir, slug);
    if (!projectDir) {
      res.status(404).json({ error: `Project "${slug}" not found` });
      return;
    }
    const document = await getEditableDocument(projectsDir, 'resource', basename(projectDir), itemSlug);
    if (!document) {
      res.status(404).json({ error: 'Resource not found' });
      return;
    }
    res.json(document);
  });

  // ----- Memory / Resource CRUD ----------------------------------------------
  // The two types share an identical contract; `kind` parameterizes the folder
  // and stub renderer.

  type ItemKind = 'memory' | 'resource';

  function itemFolder(kind: ItemKind): 'memories' | 'resources' {
    return kind === 'memory' ? 'memories' : 'resources';
  }

  function renderItemStub(
    kind: ItemKind,
    params: { slug: string; name: string; projectSlug: string; timestamp: string },
  ): string {
    return kind === 'memory' ? renderMemoryStub(params) : renderResourceStub(params);
  }

  /** Replace the body of a stub (everything after the closing frontmatter) with a custom body. */
  function replaceStubBody(stub: string, body: string): string {
    const match = stub.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/);
    if (!match) return stub; // shouldn't happen — stub always has frontmatter
    return `${match[1]}\n${body.startsWith('\n') ? body.slice(1) : body}${body.endsWith('\n') ? '' : '\n'}`;
  }

  /** Extract the verbatim frontmatter block (including the surrounding `---` lines). */
  function extractFrontmatterBlock(content: string): string | null {
    const match = content.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/);
    return match ? match[1] : null;
  }

  function parseItem(kind: ItemKind, content: string) {
    return kind === 'memory' ? parseMemory(content) : parseResource(content);
  }

  async function getItemDetail(kind: ItemKind, projectSlug: string, itemSlug: string) {
    return kind === 'memory'
      ? await getMemoryDetail(projectsDir, projectSlug, itemSlug)
      : await getResourceDetail(projectsDir, projectSlug, itemSlug);
  }

  /**
   * Resolve the on-disk project directory for a slug.
   * Tries the directory-name match first (the typical case); falls back to scanning every
   * project for a frontmatter-slug match (covers fixtures/legacy projects whose folder name
   * differs from `project.md` `slug`).
   */
  async function resolveProjectDir(projectSlug: string): Promise<string | null> {
    return resolveProjectPath(projectsDir, projectSlug);
  }

  /** 400 if the slug param wouldn't pass `isValidSlug`. Returns true if the response was sent. */
  function rejectBadItemSlug(itemSlug: string, kind: ItemKind, res: Response): boolean {
    if (isValidSlug(itemSlug)) return false;
    res.status(400).json({
      error: `Invalid ${kind} slug "${itemSlug}". Slugs must be lowercase letters, numbers, and hyphens only.`,
    });
    return true;
  }

  // GET detail
  for (const kind of ['memory', 'resource'] as const) {
    const folder = itemFolder(kind);

    router.get(`/api/projects/:slug/${folder}/:itemSlug`, async (req: Request, res: Response) => {
      try {
        const projectSlug = getParam(req.params.slug);
        const itemSlug = getParam(req.params.itemSlug);
        if (rejectBadItemSlug(itemSlug, kind, res)) return;
        const detail = await getItemDetail(kind, projectSlug, itemSlug);
        if (!detail) {
          res.status(404).json({ error: `${kind === 'memory' ? 'Memory' : 'Resource'} not found` });
          return;
        }
        res.json(detail);
      } catch (error) {
        console.error(`Error fetching ${kind} detail:`, error);
        res.status(500).json({ error: `Failed to load ${kind}: ${(error as Error).message}` });
      }
    });

    // POST — create
    router.post(`/api/projects/:slug/${folder}`, async (req: Request, res: Response) => {
      try {
        const projectSlug = getParam(req.params.slug);
        const projectDir = await resolveProjectDir(projectSlug);
        if (!projectDir) {
          res.status(404).json({ error: `Project "${projectSlug}" not found` });
          return;
        }

        const body = req.body ?? {};
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) {
          res.status(400).json({ error: 'Name is required.' });
          return;
        }

        const requestedSlug =
          typeof body.slug === 'string' && body.slug.trim() ? body.slug.trim() : slugify(name);
        if (!requestedSlug || !isValidSlug(requestedSlug)) {
          res.status(400).json({
            error: `Slug "${requestedSlug}" is invalid. Slugs must be lowercase letters, numbers, and hyphens only.`,
          });
          return;
        }

        const folderPath = resolve(projectDir, folder);
        await ensureDir(folderPath);
        const filePath = resolve(folderPath, `${requestedSlug}.md`);

        const timestamp = nowTimestamp();
        let content = renderItemStub(kind, {
          slug: requestedSlug,
          name,
          projectSlug: basename(projectDir),
          timestamp,
        });

        const customBody = typeof body.body === 'string' ? body.body : '';
        if (customBody.trim()) {
          content = replaceStubBody(content, customBody);
        }

        // Atomic create (`wx` flag fails if the file already exists). Closes the race window
        // where two concurrent POSTs both pass an existence check and the later write wins.
        try {
          const handle = await fsOpen(filePath, 'wx');
          try {
            await handle.writeFile(content, 'utf-8');
          } finally {
            await handle.close();
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
            res.status(409).json({
              error: `${kind === 'memory' ? 'Memory' : 'Resource'} with slug "${requestedSlug}" already exists in project "${basename(projectDir)}".`,
            });
            return;
          }
          throw err;
        }

        res.status(201).json({ slug: requestedSlug, projectSlug: basename(projectDir), content });
      } catch (error) {
        console.error(`Error creating ${kind}:`, error);
        res.status(500).json({ error: `Failed to create ${kind}: ${(error as Error).message}` });
      }
    });

    // PATCH — body-only update
    router.patch(`/api/projects/:slug/${folder}/:itemSlug`, async (req: Request, res: Response) => {
      try {
        const projectSlug = getParam(req.params.slug);
        const itemSlug = getParam(req.params.itemSlug);
        if (rejectBadItemSlug(itemSlug, kind, res)) return;

        const projectDir = await resolveProjectDir(projectSlug);
        if (!projectDir) {
          res.status(404).json({ error: `Project "${projectSlug}" not found` });
          return;
        }
        const filePath = resolve(projectDir, folder, `${itemSlug}.md`);
        if (!(await fileExists(filePath))) {
          res.status(404).json({ error: `${kind === 'memory' ? 'Memory' : 'Resource'} not found` });
          return;
        }

        const nextContentRaw = requireContent(req, res);
        if (!nextContentRaw) return;

        const currentContent = await readFile(filePath, 'utf-8');
        const frontmatterBlock = extractFrontmatterBlock(currentContent);
        if (!frontmatterBlock) {
          res.status(500).json({ error: `${kind} file is malformed (no frontmatter)` });
          return;
        }

        const next = parseItem(kind, nextContentRaw);
        const nextBody = next.body.trimStart();

        let merged = `${frontmatterBlock}\n${nextBody}${nextBody.endsWith('\n') ? '' : '\n'}`;
        merged = setTopLevelField(merged, 'updated', nowTimestamp());

        await writeFileForce(filePath, merged);
        const detail = await getItemDetail(kind, basename(projectDir), itemSlug);
        res.json({ [kind]: detail, content: merged });
      } catch (error) {
        console.error(`Error updating ${kind}:`, error);
        res.status(500).json({ error: `Failed to update ${kind}: ${(error as Error).message}` });
      }
    });

    // DELETE
    router.delete(`/api/projects/:slug/${folder}/:itemSlug`, async (req: Request, res: Response) => {
      try {
        const projectSlug = getParam(req.params.slug);
        const itemSlug = getParam(req.params.itemSlug);
        if (rejectBadItemSlug(itemSlug, kind, res)) return;

        const projectDir = await resolveProjectDir(projectSlug);
        if (!projectDir) {
          res.status(404).json({ error: `Project "${projectSlug}" not found` });
          return;
        }
        const filePath = resolve(projectDir, folder, `${itemSlug}.md`);
        if (!(await fileExists(filePath))) {
          res.status(404).json({ error: `${kind === 'memory' ? 'Memory' : 'Resource'} not found` });
          return;
        }
        await rm(filePath);
        res.status(204).end();
      } catch (error) {
        console.error(`Error deleting ${kind}:`, error);
        res.status(500).json({ error: `Failed to delete ${kind}: ${(error as Error).message}` });
      }
    });
  }

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

      await ensureDir(resolve(projectDir, 'assignments'));
      await ensureDir(resolve(projectDir, 'resources'));
      await ensureDir(resolve(projectDir, 'memories'));

      await writeFileForce(resolve(projectDir, 'project.md'), content);

      try {
        const companions: Array<[string, string]> = [
          [resolve(projectDir, 'manifest.md'), renderManifest({ slug, timestamp })],
          [resolve(projectDir, '_index-assignments.md'), renderIndexAssignments({ slug, title, timestamp })],
          [resolve(projectDir, '_index-plans.md'), renderIndexPlans({ slug, title, timestamp })],
          [resolve(projectDir, '_index-decisions.md'), renderIndexDecisions({ slug, title, timestamp })],
          [resolve(projectDir, '_status.md'), renderStatus({ slug, title, timestamp })],
          [resolve(projectDir, 'resources', '_index.md'), renderResourcesIndex({ slug, title, timestamp })],
          [resolve(projectDir, 'memories', '_index.md'), renderMemoriesIndex({ slug, title, timestamp })],
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

  router.post('/api/projects/:slug/assignments', async (req: Request, res: Response) => {
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

      const assignmentSlug = fields.slug;
      if (!isValidSlug(assignmentSlug)) {
        res.status(400).json({ error: `Invalid slug "${assignmentSlug}". Must be lowercase and hyphen-separated.` });
        return;
      }

      const validPriorities = ['low', 'medium', 'high', 'critical'];
      const priority = fields.priority || 'medium';
      if (!validPriorities.includes(priority)) {
        res.status(400).json({ error: `Invalid priority "${priority}". Must be low, medium, high, or critical.` });
        return;
      }

      const assignmentDir = resolve(projectDir, 'assignments', assignmentSlug);
      if (await fileExists(assignmentDir)) {
        res.status(409).json({
          error: `Assignment "${assignmentSlug}" already exists in project "${projectSlug}"`,
        });
        return;
      }

      const timestamp = fields.created || nowTimestamp();

      await ensureDir(assignmentDir);
      await writeFileForce(resolve(assignmentDir, 'assignment.md'), content);

      try {
        const companions: Array<[string, string]> = [
          [resolve(assignmentDir, 'scratchpad.md'), renderScratchpad({ assignmentSlug, timestamp })],
          [resolve(assignmentDir, 'handoff.md'), renderHandoff({ assignmentSlug, timestamp })],
          [resolve(assignmentDir, 'decision-record.md'), renderDecisionRecord({ assignmentSlug, timestamp })],
        ];

        for (const [filePath, fileContent] of companions) {
          await writeFileForce(filePath, fileContent);
        }
      } catch (companionError) {
        try {
          await rm(assignmentDir, { recursive: true, force: true });
        } catch {
          // Best effort cleanup only.
        }
        throw companionError;
      }

      res.status(201).json({ slug: assignmentSlug, projectSlug });
    } catch (error) {
      console.error('Error creating assignment:', error);
      res.status(500).json({ error: `Failed to create assignment: ${(error as Error).message}` });
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

  router.patch('/api/projects/:slug/assignments/:aslug', async (req: Request, res: Response) => {
    try {
      const projectSlug = getParam(req.params.slug);
      const assignmentSlug = getParam(req.params.aslug);
      const assignmentPath = resolve(
        projectsDir,
        projectSlug,
        'assignments',
        assignmentSlug,
        'assignment.md',
      );
      const currentContent = await readCurrentDocument(assignmentPath);
      if (!currentContent) {
        res.status(404).json({ error: 'Assignment not found' });
        return;
      }

      const nextContentRaw = requireContent(req, res);
      if (!nextContentRaw) {
        return;
      }

      const current = parseAssignmentFull(currentContent);
      const next = parseAssignmentFull(nextContentRaw);

      if (!next.slug || !next.title) {
        res.status(400).json({ error: 'Assignment content must include slug and title.' });
        return;
      }

      if (next.slug !== current.slug) {
        res.status(400).json({ error: 'Assignment slug cannot be changed once created.' });
        return;
      }

      let nextContent = nextContentRaw;

      // Clear blockedReason when status moves away from blocked
      if (next.status !== current.status && current.status === 'blocked' && next.status !== 'blocked') {
        nextContent = setTopLevelField(nextContent, 'blockedReason', null);
      }

      nextContent = setTopLevelField(nextContent, 'updated', nowTimestamp());
      await writeFileForce(assignmentPath, nextContent);

      const assignment = await getAssignmentDetail(projectsDir, projectSlug, assignmentSlug);
      res.json({ assignment, content: nextContent });
    } catch (error) {
      console.error('Error updating assignment:', error);
      res.status(500).json({ error: `Failed to update assignment: ${(error as Error).message}` });
    }
  });

  router.patch('/api/projects/:slug/assignments/:aslug/acceptance-criteria/:index', async (req: Request, res: Response) => {
    try {
      const projectSlug = getParam(req.params.slug);
      const assignmentSlug = getParam(req.params.aslug);
      const assignmentPath = resolve(
        projectsDir,
        projectSlug,
        'assignments',
        assignmentSlug,
        'assignment.md',
      );
      const currentContent = await readCurrentDocument(assignmentPath);
      if (!currentContent) {
        res.status(404).json({ error: 'Assignment not found' });
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
      await writeFileForce(assignmentPath, nextContent);

      const assignment = await getAssignmentDetail(projectsDir, projectSlug, assignmentSlug);
      res.json({ assignment, content: nextContent });
    } catch (error) {
      console.error('Error toggling acceptance criterion:', error);
      res.status(500).json({ error: `Failed to toggle acceptance criterion: ${(error as Error).message}` });
    }
  });

  router.patch('/api/projects/:slug/assignments/:aslug/plan', async (req: Request, res: Response) => {
    try {
      const projectSlug = getParam(req.params.slug);
      const assignmentSlug = getParam(req.params.aslug);
      const planPath = resolve(
        projectsDir,
        projectSlug,
        'assignments',
        assignmentSlug,
        'plan.md',
      );
      const currentContent = await readCurrentDocument(planPath);
      if (!currentContent) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }

      const nextContentRaw = requireContent(req, res);
      if (!nextContentRaw) {
        return;
      }

      const next = parsePlan(nextContentRaw);
      if (!next.assignment) {
        res.status(400).json({ error: 'Plan content must include the assignment field.' });
        return;
      }

      if (next.assignment !== assignmentSlug) {
        res.status(400).json({ error: 'Plan assignment field must match the route assignment slug.' });
        return;
      }

      const nextContent = setTopLevelField(nextContentRaw, 'updated', nowTimestamp());
      await writeFileForce(planPath, nextContent);

      const assignment = await getAssignmentDetail(projectsDir, projectSlug, assignmentSlug);
      res.json({ assignment, content: nextContent });
    } catch (error) {
      console.error('Error updating plan:', error);
      res.status(500).json({ error: `Failed to update plan: ${(error as Error).message}` });
    }
  });

  router.patch('/api/projects/:slug/assignments/:aslug/scratchpad', async (req: Request, res: Response) => {
    try {
      const projectSlug = getParam(req.params.slug);
      const assignmentSlug = getParam(req.params.aslug);
      const scratchpadPath = resolve(
        projectsDir,
        projectSlug,
        'assignments',
        assignmentSlug,
        'scratchpad.md',
      );
      const currentContent = await readCurrentDocument(scratchpadPath);
      if (!currentContent) {
        res.status(404).json({ error: 'Scratchpad not found' });
        return;
      }

      const nextContentRaw = requireContent(req, res);
      if (!nextContentRaw) {
        return;
      }

      const next = parseScratchpad(nextContentRaw);
      if (!next.assignment) {
        res.status(400).json({ error: 'Scratchpad content must include the assignment field.' });
        return;
      }

      if (next.assignment !== assignmentSlug) {
        res.status(400).json({ error: 'Scratchpad assignment field must match the route assignment slug.' });
        return;
      }

      const nextContent = setTopLevelField(nextContentRaw, 'updated', nowTimestamp());
      await writeFileForce(scratchpadPath, nextContent);

      const assignment = await getAssignmentDetail(projectsDir, projectSlug, assignmentSlug);
      res.json({ assignment, content: nextContent });
    } catch (error) {
      console.error('Error updating scratchpad:', error);
      res.status(500).json({ error: `Failed to update scratchpad: ${(error as Error).message}` });
    }
  });

  router.post('/api/projects/:slug/assignments/:aslug/handoff/entries', async (req: Request, res: Response) => {
    try {
      const projectSlug = getParam(req.params.slug);
      const assignmentSlug = getParam(req.params.aslug);
      const handoffPath = resolve(
        projectsDir,
        projectSlug,
        'assignments',
        assignmentSlug,
        'handoff.md',
      );
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
      const assignment = await getAssignmentDetail(projectsDir, projectSlug, assignmentSlug);
      res.status(201).json({ assignment, content: nextContent });
    } catch (error) {
      console.error('Error appending handoff entry:', error);
      res.status(500).json({ error: `Failed to append handoff entry: ${(error as Error).message}` });
    }
  });

  router.post('/api/projects/:slug/assignments/:aslug/decision-record/entries', async (req: Request, res: Response) => {
    try {
      const projectSlug = getParam(req.params.slug);
      const assignmentSlug = getParam(req.params.aslug);
      const decisionPath = resolve(
        projectsDir,
        projectSlug,
        'assignments',
        assignmentSlug,
        'decision-record.md',
      );
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
      const assignment = await getAssignmentDetail(projectsDir, projectSlug, assignmentSlug);
      res.status(201).json({ assignment, content: nextContent });
    } catch (error) {
      console.error('Error appending decision entry:', error);
      res.status(500).json({ error: `Failed to append decision entry: ${(error as Error).message}` });
    }
  });

  // --- Comments Endpoints ---

  router.post('/api/projects/:slug/assignments/:aslug/comments', async (req: Request, res: Response) => {
    try {
      const projectSlug = getParam(req.params.slug);
      const assignmentSlug = getParam(req.params.aslug);
      const commentsPath = resolve(
        projectsDir,
        projectSlug,
        'assignments',
        assignmentSlug,
        'comments.md',
      );

      const { body, author, type, replyTo } = req.body || {};
      if (!body || typeof body !== 'string' || !body.trim()) {
        res.status(400).json({ error: 'body is required' });
        return;
      }
      const commentType: CommentType = type && ['question', 'note', 'feedback'].includes(type)
        ? type
        : 'note';
      const timestamp = nowTimestamp();
      const entryAuthor = (typeof author === 'string' && author.trim()) ? author.trim() : 'human';

      let currentContent: string;
      let currentCount = 0;
      if (await fileExists(commentsPath)) {
        currentContent = await readFile(commentsPath, 'utf-8');
        const countMatch = currentContent.match(/^entryCount:\s*(\d+)/m);
        if (countMatch) currentCount = parseInt(countMatch[1], 10);
      } else {
        currentContent = renderComments({
          assignment: assignmentSlug,
          timestamp,
        });
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
      next = setTopLevelField(next, 'updated', `"${timestamp}"`);
      if (next.includes('No comments yet.')) {
        next = next.replace('No comments yet.', entry.trimEnd());
      } else {
        next = `${next.trimEnd()}\n\n${entry}`;
      }

      await writeFileForce(commentsPath, next);
      const assignment = await getAssignmentDetail(projectsDir, projectSlug, assignmentSlug);
      res.status(201).json({ assignment, comment: { id: comment.id } });
    } catch (error) {
      console.error('Error appending comment:', error);
      res.status(500).json({ error: `Failed to append comment: ${(error as Error).message}` });
    }
  });

  router.patch('/api/projects/:slug/assignments/:aslug/comments/:commentId/resolved', async (req: Request, res: Response) => {
    try {
      const projectSlug = getParam(req.params.slug);
      const assignmentSlug = getParam(req.params.aslug);
      const commentId = getParam(req.params.commentId);
      const commentsPath = resolve(
        projectsDir,
        projectSlug,
        'assignments',
        assignmentSlug,
        'comments.md',
      );
      if (!(await fileExists(commentsPath))) {
        res.status(404).json({ error: 'Comments file not found' });
        return;
      }
      const { resolved } = req.body || {};
      if (typeof resolved !== 'boolean') {
        res.status(400).json({ error: 'resolved (boolean) is required' });
        return;
      }

      const content = await readFile(commentsPath, 'utf-8');
      const parsed = parseComments(content);
      const target = parsed.entries.find((e) => e.id === commentId);
      if (!target) {
        res.status(404).json({ error: `Comment ${commentId} not found` });
        return;
      }
      if (target.type !== 'question') {
        res.status(400).json({ error: 'Only questions can be resolved' });
        return;
      }

      // Toggle the `**Resolved:**` line in the entry's block.
      const entryBlockRegex = new RegExp(
        `(^## ${commentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?)(\\*\\*Resolved:\\*\\*\\s*(?:true|false))`,
        'm',
      );
      const next = content.replace(
        entryBlockRegex,
        (_m, preamble) => `${preamble}**Resolved:** ${resolved ? 'true' : 'false'}`,
      );
      if (next === content) {
        res.status(500).json({ error: 'Failed to update resolved flag' });
        return;
      }

      const withUpdated = setTopLevelField(next, 'updated', `"${nowTimestamp()}"`);
      await writeFileForce(commentsPath, withUpdated);
      const assignment = await getAssignmentDetail(projectsDir, projectSlug, assignmentSlug);
      res.json({ assignment });
    } catch (error) {
      console.error('Error toggling comment resolved flag:', error);
      res.status(500).json({ error: `Failed to toggle resolved: ${(error as Error).message}` });
    }
  });

  // --- Move Workspace Endpoint ---

  router.post('/api/projects/:slug/move-workspace', async (req: Request, res: Response) => {
    try {
      const projectSlug = getParam(req.params.slug);
      const projectPath = resolve(projectsDir, projectSlug, 'project.md');
      if (!(await fileExists(projectPath))) {
        res.status(404).json({ error: `Project "${projectSlug}" not found` });
        return;
      }

      const { workspace } = req.body || {};
      if (
        workspace !== null &&
        (typeof workspace !== 'string' || !workspace.trim() || !isValidSlug(workspace))
      ) {
        // isValidSlug forbids newlines, colons, and other YAML metacharacters,
        // so we can safely write the value into frontmatter without escaping.
        res.status(400).json({
          error:
            'workspace must be a valid slug (lowercase letters, numbers, hyphens) or null (for ungrouped).',
        });
        return;
      }

      let content = await readFile(projectPath, 'utf-8');
      content = setTopLevelField(content, 'workspace', workspace ?? null);
      content = setTopLevelField(content, 'updated', nowTimestamp());
      await writeFileForce(projectPath, content);

      const project = await getProjectDetail(projectsDir, projectSlug);
      res.json({ project });
    } catch (error) {
      console.error('Error moving project workspace:', error);
      res.status(500).json({ error: `Failed to move workspace: ${(error as Error).message}` });
    }
  });

  router.post('/api/assignments/:id/move-workspace', async (req: Request, res: Response) => {
    try {
      if (!assignmentsDir) {
        res.status(501).json({ error: 'Standalone assignments not configured on this server' });
        return;
      }

      const id = getParam(req.params.id);
      const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Assignment "${id}" not found` });
        return;
      }
      if (!resolved.standalone) {
        res.status(400).json({
          error:
            'Project-nested assignments inherit workspace from their parent project. Move the project instead.',
        });
        return;
      }

      const { workspaceGroup } = req.body || {};
      if (
        workspaceGroup !== null &&
        (typeof workspaceGroup !== 'string' || !workspaceGroup.trim() || !isValidSlug(workspaceGroup))
      ) {
        // See workspace move route above: isValidSlug guards against frontmatter injection.
        res.status(400).json({
          error:
            'workspaceGroup must be a valid slug (lowercase letters, numbers, hyphens) or null (for ungrouped).',
        });
        return;
      }

      const assignmentPath = resolve(resolved.assignmentDir, 'assignment.md');
      let content = await readFile(assignmentPath, 'utf-8');
      content = setTopLevelField(content, 'workspaceGroup', workspaceGroup ?? null);
      content = setTopLevelField(content, 'updated', nowTimestamp());
      await writeFileForce(assignmentPath, content);

      const assignment = await getAssignmentDetailById(projectsDir, assignmentsDir, id);
      res.json({ assignment });
    } catch (error) {
      console.error('Error moving assignment workspace:', error);
      res.status(500).json({ error: `Failed to move workspace: ${(error as Error).message}` });
    }
  });

  // --- Worktree creation + candidate discovery ---
  // Mirrors the existing CLI flow (`syntaur worktree create`) and the browse
  // TUI's `runCreate`. All three paths call `createWorktreeAndRecord` so the
  // assignment.md frontmatter ends up identical regardless of entry point.

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
    '/api/assignments/:id/repository-candidates',
    async (req: Request, res: Response) => {
      try {
        if (!assignmentsDir) {
          res
            .status(501)
            .json({ error: 'Standalone assignments not configured on this server' });
          return;
        }
        const id = getParam(req.params.id);
        const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, id);
        if (!resolved) {
          res.status(404).json({ error: `Assignment "${id}" not found` });
          return;
        }
        const candidates = resolved.standalone
          ? await getStandaloneRepositoryCandidates(assignmentsDir, id)
          : await getProjectRepositoryCandidates(projectsDir, resolved.projectSlug!);
        res.json({ candidates });
      } catch (error) {
        console.error('Error listing repository candidates:', error);
        res.status(500).json({
          error: `Failed to list repository candidates: ${(error as Error).message}`,
        });
      }
    },
  );

  router.post(
    '/api/projects/:slug/assignments/:aslug/worktree',
    async (req: Request, res: Response) => {
      try {
        const projectSlug = getParam(req.params.slug);
        const assignmentSlug = getParam(req.params.aslug);
        const assignmentPath = resolve(
          projectsDir,
          projectSlug,
          'assignments',
          assignmentSlug,
          'assignment.md',
        );
        await handleWorktreeCreate(req, res, {
          assignmentPath,
          projectSlug,
          assignmentSlug,
          reload: () => getAssignmentDetail(projectsDir, projectSlug, assignmentSlug),
        });
      } catch (error) {
        console.error('Error creating worktree:', error);
        res
          .status(500)
          .json({ error: `Failed to create worktree: ${(error as Error).message}` });
      }
    },
  );

  router.post(
    '/api/assignments/:id/worktree',
    async (req: Request, res: Response) => {
      try {
        if (!assignmentsDir) {
          res
            .status(501)
            .json({ error: 'Standalone assignments not configured on this server' });
          return;
        }
        const id = getParam(req.params.id);
        const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, id);
        if (!resolved) {
          res.status(404).json({ error: `Assignment "${id}" not found` });
          return;
        }
        const assignmentPath = resolve(resolved.assignmentDir, 'assignment.md');
        // Standalone: resolveAssignmentById returns the UUID as `assignmentSlug`.
        // For branch naming we need the user-visible slug from frontmatter, so
        // parse it here and pass that down. parseAssignmentFull falls back to
        // empty string, hence the `|| resolved.id` belt-and-suspenders.
        const parsedForSlug = parseAssignmentFull(await readFile(assignmentPath, 'utf-8'));
        const assignmentSlugForBranch = parsedForSlug.slug || resolved.id;
        await handleWorktreeCreate(req, res, {
          assignmentPath,
          projectSlug: resolved.projectSlug ?? '',
          assignmentSlug: assignmentSlugForBranch,
          reload: () => getAssignmentDetailById(projectsDir, assignmentsDir!, id),
        });
      } catch (error) {
        console.error('Error creating worktree:', error);
        res
          .status(500)
          .json({ error: `Failed to create worktree: ${(error as Error).message}` });
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
      const validStatuses = ['active', 'archived', ...config.statuses.map((s) => s.id)];
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

  router.post('/api/projects/:slug/assignments/:aslug/status-override', async (req: Request, res: Response) => {
    try {
      const projectSlug = getParam(req.params.slug);
      const assignmentSlug = getParam(req.params.aslug);
      const assignmentPath = resolve(
        projectsDir,
        projectSlug,
        'assignments',
        assignmentSlug,
        'assignment.md',
      );
      if (!(await fileExists(assignmentPath))) {
        res.status(404).json({ error: 'Assignment not found' });
        return;
      }

      const { status } = req.body || {};
      const config = await getStatusConfig();
      const validStatuses = config.statuses.map((s) => s.id);
      if (typeof status !== 'string' || !validStatuses.includes(status)) {
        res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}.` });
        return;
      }

      let content = await readFile(assignmentPath, 'utf-8');
      content = setTopLevelField(content, 'status', status);
      content = setTopLevelField(content, 'updated', nowTimestamp());

      // Clear blockedReason when moving away from blocked
      if (status !== 'blocked') {
        content = setTopLevelField(content, 'blockedReason', null);
      }

      await writeFileForce(assignmentPath, content);

      const assignment = await getAssignmentDetail(projectsDir, projectSlug, assignmentSlug);
      res.json({ assignment });
    } catch (error) {
      console.error('Error overriding assignment status:', error);
      res.status(500).json({ error: `Failed to override status: ${(error as Error).message}` });
    }
  });

  router.patch('/api/projects/:slug/assignments/:aslug/assignee', async (req: Request, res: Response) => {
    try {
      const projectSlug = getParam(req.params.slug);
      const assignmentSlug = getParam(req.params.aslug);
      const assignmentPath = resolve(
        projectsDir,
        projectSlug,
        'assignments',
        assignmentSlug,
        'assignment.md',
      );
      if (!(await fileExists(assignmentPath))) {
        res.status(404).json({ error: 'Assignment not found' });
        return;
      }
      const validation = validateAssigneeBody(req.body);
      if (!validation.ok) {
        res.status(400).json({ error: validation.error });
        return;
      }
      let content = await readFile(assignmentPath, 'utf-8');
      content = setTopLevelField(content, 'assignee', validation.value);
      content = setTopLevelField(content, 'updated', nowTimestamp());
      await writeFileForce(assignmentPath, content);
      const assignment = await getAssignmentDetail(projectsDir, projectSlug, assignmentSlug);
      res.json({ assignment });
    } catch (error) {
      console.error('Error updating assignee:', error);
      res.status(500).json({ error: `Failed to update assignee: ${(error as Error).message}` });
    }
  });

  // --- Lifecycle Transitions ---

  router.post('/api/projects/:slug/assignments/:aslug/transitions/:command', async (req: Request, res: Response) => {
    try {
      const projectSlug = getParam(req.params.slug);
      const assignmentSlug = getParam(req.params.aslug);
      const command = req.params.command as Parameters<typeof executeTransition>[2];
      const config = await getStatusConfig();
      const validCommands = [...new Set(config.transitions.map((t) => t.command))];
      if (!validCommands.includes(command)) {
        res.status(400).json({ error: `Unsupported transition command "${req.params.command}"` });
        return;
      }

      const projectDir = resolve(projectsDir, projectSlug);
      const assignmentPath = resolve(projectDir, 'assignments', assignmentSlug, 'assignment.md');
      if (!(await fileExists(assignmentPath))) {
        res.status(404).json({ error: 'Assignment not found' });
        return;
      }

      const { reason } = req.body || {};
      const result = await executeTransition(projectDir, assignmentSlug, command, {
        reason: typeof reason === 'string' ? reason : undefined,
        transitionTable: config.custom ? config.transitionTable : undefined,
        terminalStatuses: config.custom ? config.terminalStatuses : undefined,
        linkedTodosLookup,
      });

      if (!result.success) {
        res.status(400).json({ error: result.message });
        return;
      }

      const assignment = await getAssignmentDetail(projectsDir, projectSlug, assignmentSlug);
      res.json({ assignment, transition: result });
    } catch (error) {
      console.error('Error running assignment transition:', error);
      res.status(500).json({ error: `Failed to transition assignment: ${(error as Error).message}` });
    }
  });

  router.delete('/api/projects/:slug/assignments/:aslug', async (req: Request, res: Response) => {
    try {
      const projectSlug = getParam(req.params.slug);
      const assignmentSlug = getParam(req.params.aslug);
      const assignmentDir = resolve(projectsDir, projectSlug, 'assignments', assignmentSlug);
      const assignmentPath = resolve(assignmentDir, 'assignment.md');

      if (!(await fileExists(assignmentPath))) {
        res.status(404).json({ error: `Assignment "${assignmentSlug}" not found in project "${projectSlug}"` });
        return;
      }

      await rm(assignmentDir, { recursive: true, force: true });
      res.json({ deleted: assignmentSlug, projectSlug });
    } catch (error) {
      console.error('Error deleting assignment:', error);
      res.status(500).json({ error: `Failed to delete assignment: ${(error as Error).message}` });
    }
  });

  // =========================================================================
  // Standalone (by-id) routes — `~/.syntaur/assignments/<uuid>/`
  // Active only when the write router was constructed with an assignmentsDir.
  // =========================================================================

  router.post('/api/assignments', async (req: Request, res: Response) => {
    try {
      if (!assignmentsDir) {
        res.status(501).json({ error: 'Standalone assignments not configured on this server' });
        return;
      }

      // Two body shapes are supported:
      //   1) { content: <markdown> } — same shape as POST /api/projects/:slug/assignments. Used by the dashboard UI.
      //   2) { title, slug?, priority?, type? } — original structured form, retained for back-compat.
      const rawContent = typeof req.body?.content === 'string' ? req.body.content : '';
      if (rawContent.trim()) {
        const fields = extractFrontmatter(rawContent);
        if (!fields) {
          res.status(400).json({ error: 'Invalid frontmatter: missing --- delimiters' });
          return;
        }
        const validation = validateRequired(fields, ['slug', 'title']);
        if (!validation.valid) {
          res.status(400).json({ error: `Missing required fields: ${validation.missing.join(', ')}` });
          return;
        }
        const submittedSlug = fields.slug;
        if (!isValidSlug(submittedSlug)) {
          res.status(400).json({ error: `Invalid slug "${submittedSlug}". Must be lowercase and hyphen-separated.` });
          return;
        }
        const validPriorities = ['low', 'medium', 'high', 'critical'];
        const submittedPriority = fields.priority || 'medium';
        if (!validPriorities.includes(submittedPriority)) {
          res.status(400).json({ error: `Invalid priority "${submittedPriority}". Must be low, medium, high, or critical.` });
          return;
        }

        // Standalone-specific guards: no project, optional workspaceGroup.
        if (fields.project && fields.project !== 'null') {
          res.status(400).json({
            error: 'Standalone assignments cannot have a project; remove "project" or set it to null.',
          });
          return;
        }
        const submittedWorkspaceGroup = fields.workspaceGroup && fields.workspaceGroup !== 'null'
          ? fields.workspaceGroup
          : '';
        if (submittedWorkspaceGroup && !isValidSlug(submittedWorkspaceGroup)) {
          res.status(400).json({
            error: `Invalid workspace slug "${submittedWorkspaceGroup}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
          });
          return;
        }

        const id = generateId();
        const assignmentDir = resolve(assignmentsDir, id);
        if (await fileExists(assignmentDir)) {
          res.status(500).json({ error: 'UUID collision — try again' });
          return;
        }

        const timestamp = fields.created || nowTimestamp();
        await ensureDir(assignmentDir);
        // Normalize the frontmatter id to the freshly-generated UUID — the template ships a placeholder.
        const normalizedContent = setTopLevelField(rawContent, 'id', id);
        await writeFileForce(resolve(assignmentDir, 'assignment.md'), normalizedContent);
        await writeFileForce(
          resolve(assignmentDir, 'scratchpad.md'),
          renderScratchpad({ assignmentSlug: id, timestamp }),
        );
        await writeFileForce(
          resolve(assignmentDir, 'handoff.md'),
          renderHandoff({ assignmentSlug: id, timestamp }),
        );
        await writeFileForce(
          resolve(assignmentDir, 'decision-record.md'),
          renderDecisionRecord({ assignmentSlug: id, timestamp }),
        );
        await writeFileForce(
          resolve(assignmentDir, 'progress.md'),
          renderProgress({ assignment: id, timestamp }),
        );
        await writeFileForce(
          resolve(assignmentDir, 'comments.md'),
          renderComments({ assignment: id, timestamp }),
        );

        const detail = await getAssignmentDetailById(projectsDir, assignmentsDir, id);
        res.status(201).json({ assignment: detail });
        return;
      }

      // Structured-form path (back-compat).
      const { title, slug, priority, type } = req.body || {};
      if (!title || typeof title !== 'string' || !title.trim()) {
        res.status(400).json({ error: 'title is required' });
        return;
      }
      const { dependsOn } = req.body || {};
      if (Array.isArray(dependsOn) && dependsOn.length > 0) {
        res.status(400).json({ error: 'Standalone assignments cannot declare dependsOn.' });
        return;
      }

      const id = generateId();
      const assignmentDir = resolve(assignmentsDir, id);
      if (await fileExists(assignmentDir)) {
        res.status(500).json({ error: 'UUID collision — try again' });
        return;
      }

      const timestamp = nowTimestamp();
      const resolvedSlug = typeof slug === 'string' && slug.trim() ? slug.trim() : slugifyLocal(title);
      const resolvedPriority = (typeof priority === 'string' && ['low', 'medium', 'high', 'critical'].includes(priority))
        ? (priority as 'low' | 'medium' | 'high' | 'critical')
        : 'medium';

      await ensureDir(assignmentDir);
      const assignmentContent = renderAssignment({
        id,
        slug: resolvedSlug,
        title: title.trim(),
        timestamp,
        priority: resolvedPriority,
        dependsOn: [],
        links: [],
        project: null,
        type: typeof type === 'string' ? type : undefined,
      });
      await writeFileForce(resolve(assignmentDir, 'assignment.md'), assignmentContent);
      await writeFileForce(
        resolve(assignmentDir, 'scratchpad.md'),
        renderScratchpad({ assignmentSlug: id, timestamp }),
      );
      await writeFileForce(
        resolve(assignmentDir, 'handoff.md'),
        renderHandoff({ assignmentSlug: id, timestamp }),
      );
      await writeFileForce(
        resolve(assignmentDir, 'decision-record.md'),
        renderDecisionRecord({ assignmentSlug: id, timestamp }),
      );
      await writeFileForce(
        resolve(assignmentDir, 'progress.md'),
        renderProgress({ assignment: id, timestamp }),
      );
      await writeFileForce(
        resolve(assignmentDir, 'comments.md'),
        renderComments({ assignment: id, timestamp }),
      );

      const detail = await getAssignmentDetailById(projectsDir, assignmentsDir, id);
      res.status(201).json({ assignment: detail });
    } catch (error) {
      console.error('Error creating standalone assignment:', error);
      res.status(500).json({ error: `Failed to create standalone assignment: ${(error as Error).message}` });
    }
  });

  router.post('/api/assignments/:id/comments', async (req: Request, res: Response) => {
    try {
      if (!assignmentsDir) {
        res.status(501).json({ error: 'Standalone assignments not configured on this server' });
        return;
      }
      const id = getParam(req.params.id);
      const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Assignment "${id}" not found` });
        return;
      }
      await appendCommentTo(resolved.assignmentDir, resolved.standalone ? resolved.id : resolved.assignmentSlug, req, res, async () => {
        return resolved.standalone
          ? getAssignmentDetailById(projectsDir, assignmentsDir, id)
          : getAssignmentDetail(projectsDir, resolved.projectSlug!, resolved.assignmentSlug);
      });
    } catch (error) {
      console.error('Error appending comment (by id):', error);
      res.status(500).json({ error: `Failed to append comment: ${(error as Error).message}` });
    }
  });

  router.patch('/api/assignments/:id/comments/:commentId/resolved', async (req: Request, res: Response) => {
    try {
      if (!assignmentsDir) {
        res.status(501).json({ error: 'Standalone assignments not configured on this server' });
        return;
      }
      const id = getParam(req.params.id);
      const commentId = getParam(req.params.commentId);
      const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Assignment "${id}" not found` });
        return;
      }
      await toggleCommentResolvedAt(resolved.assignmentDir, commentId, req, res, async () => {
        return resolved.standalone
          ? getAssignmentDetailById(projectsDir, assignmentsDir, id)
          : getAssignmentDetail(projectsDir, resolved.projectSlug!, resolved.assignmentSlug);
      });
    } catch (error) {
      console.error('Error toggling comment resolved (by id):', error);
      res.status(500).json({ error: `Failed to toggle resolved: ${(error as Error).message}` });
    }
  });

  router.get('/api/assignments/:id/edit', async (req: Request, res: Response) => {
    if (!assignmentsDir) {
      res.status(501).json({ error: 'Standalone assignments not configured on this server' });
      return;
    }
    const id = getParam(req.params.id);
    const doc = await getEditableDocumentById(projectsDir, assignmentsDir, 'assignment', id);
    if (!doc) {
      res.status(404).json({ error: 'Assignment not found' });
      return;
    }
    res.json(doc);
  });

  router.get('/api/assignments/:id/plan/edit', async (req: Request, res: Response) => {
    if (!assignmentsDir) {
      res.status(501).json({ error: 'Standalone assignments not configured on this server' });
      return;
    }
    const id = getParam(req.params.id);
    const doc = await getEditableDocumentById(projectsDir, assignmentsDir, 'plan', id);
    if (!doc) {
      res.status(404).json({ error: 'Plan not found' });
      return;
    }
    res.json(doc);
  });

  router.get('/api/assignments/:id/scratchpad/edit', async (req: Request, res: Response) => {
    if (!assignmentsDir) {
      res.status(501).json({ error: 'Standalone assignments not configured on this server' });
      return;
    }
    const id = getParam(req.params.id);
    const doc = await getEditableDocumentById(projectsDir, assignmentsDir, 'scratchpad', id);
    if (!doc) {
      res.status(404).json({ error: 'Scratchpad not found' });
      return;
    }
    res.json(doc);
  });

  router.get('/api/assignments/:id/handoff/edit', async (req: Request, res: Response) => {
    if (!assignmentsDir) {
      res.status(501).json({ error: 'Standalone assignments not configured on this server' });
      return;
    }
    const id = getParam(req.params.id);
    const doc = await getEditableDocumentById(projectsDir, assignmentsDir, 'handoff', id);
    if (!doc) {
      res.status(404).json({ error: 'Handoff log not found' });
      return;
    }
    res.json(doc);
  });

  router.get('/api/assignments/:id/decision-record/edit', async (req: Request, res: Response) => {
    if (!assignmentsDir) {
      res.status(501).json({ error: 'Standalone assignments not configured on this server' });
      return;
    }
    const id = getParam(req.params.id);
    const doc = await getEditableDocumentById(projectsDir, assignmentsDir, 'decision-record', id);
    if (!doc) {
      res.status(404).json({ error: 'Decision record not found' });
      return;
    }
    res.json(doc);
  });

  router.patch('/api/assignments/:id', async (req: Request, res: Response) => {
    try {
      if (!assignmentsDir) {
        res.status(501).json({ error: 'Standalone assignments not configured on this server' });
        return;
      }
      const id = getParam(req.params.id);
      const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Assignment "${id}" not found` });
        return;
      }

      const assignmentPath = resolve(resolved.assignmentDir, 'assignment.md');
      const currentContent = await readCurrentDocument(assignmentPath);
      if (!currentContent) {
        res.status(404).json({ error: 'Assignment not found' });
        return;
      }

      const nextContentRaw = requireContent(req, res);
      if (!nextContentRaw) return;

      const current = parseAssignmentFull(currentContent);
      const next = parseAssignmentFull(nextContentRaw);

      if (!next.title) {
        res.status(400).json({ error: 'Assignment content must include a title.' });
        return;
      }

      // Standalone: restore id + project + slug frontmatter (all immutable after create).
      let nextContent = nextContentRaw;
      if (current.id) nextContent = setTopLevelField(nextContent, 'id', current.id);
      nextContent = setTopLevelField(nextContent, 'project', null);
      if (current.slug) nextContent = setTopLevelField(nextContent, 'slug', current.slug);

      if (next.status !== current.status && current.status === 'blocked' && next.status !== 'blocked') {
        nextContent = setTopLevelField(nextContent, 'blockedReason', null);
      }

      nextContent = setTopLevelField(nextContent, 'updated', nowTimestamp());
      await writeFileForce(assignmentPath, nextContent);

      const assignment = await getAssignmentDetailById(projectsDir, assignmentsDir, id);
      res.json({ assignment, content: nextContent });
    } catch (error) {
      console.error('Error updating standalone assignment:', error);
      res.status(500).json({ error: `Failed to update assignment: ${(error as Error).message}` });
    }
  });

  router.patch('/api/assignments/:id/plan', async (req: Request, res: Response) => {
    try {
      if (!assignmentsDir) {
        res.status(501).json({ error: 'Standalone assignments not configured on this server' });
        return;
      }
      const id = getParam(req.params.id);
      const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Assignment "${id}" not found` });
        return;
      }

      const planPath = resolve(resolved.assignmentDir, 'plan.md');
      const currentContent = await readCurrentDocument(planPath);
      if (!currentContent) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }
      const nextContentRaw = requireContent(req, res);
      if (!nextContentRaw) return;

      const parsed = parsePlan(nextContentRaw);
      if (!parsed.assignment) {
        res.status(400).json({ error: 'Plan content must include the assignment field.' });
        return;
      }

      const nextContent = setTopLevelField(nextContentRaw, 'updated', nowTimestamp());
      await writeFileForce(planPath, nextContent);

      const assignment = await getAssignmentDetailById(projectsDir, assignmentsDir, id);
      res.json({ assignment, content: nextContent });
    } catch (error) {
      console.error('Error updating standalone plan:', error);
      res.status(500).json({ error: `Failed to update plan: ${(error as Error).message}` });
    }
  });

  router.patch('/api/assignments/:id/scratchpad', async (req: Request, res: Response) => {
    try {
      if (!assignmentsDir) {
        res.status(501).json({ error: 'Standalone assignments not configured on this server' });
        return;
      }
      const id = getParam(req.params.id);
      const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Assignment "${id}" not found` });
        return;
      }

      const scratchpadPath = resolve(resolved.assignmentDir, 'scratchpad.md');
      const currentContent = await readCurrentDocument(scratchpadPath);
      if (!currentContent) {
        res.status(404).json({ error: 'Scratchpad not found' });
        return;
      }
      const nextContentRaw = requireContent(req, res);
      if (!nextContentRaw) return;

      const parsed = parseScratchpad(nextContentRaw);
      if (!parsed.assignment) {
        res.status(400).json({ error: 'Scratchpad content must include the assignment field.' });
        return;
      }

      const nextContent = setTopLevelField(nextContentRaw, 'updated', nowTimestamp());
      await writeFileForce(scratchpadPath, nextContent);

      const assignment = await getAssignmentDetailById(projectsDir, assignmentsDir, id);
      res.json({ assignment, content: nextContent });
    } catch (error) {
      console.error('Error updating standalone scratchpad:', error);
      res.status(500).json({ error: `Failed to update scratchpad: ${(error as Error).message}` });
    }
  });

  router.post('/api/assignments/:id/handoff/entries', async (req: Request, res: Response) => {
    try {
      if (!assignmentsDir) {
        res.status(501).json({ error: 'Standalone assignments not configured on this server' });
        return;
      }
      const id = getParam(req.params.id);
      const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Assignment "${id}" not found` });
        return;
      }
      const handoffPath = resolve(resolved.assignmentDir, 'handoff.md');
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
      const assignment = await getAssignmentDetailById(projectsDir, assignmentsDir, id);
      res.status(201).json({ assignment, content: nextContent });
    } catch (error) {
      console.error('Error appending standalone handoff entry:', error);
      res.status(500).json({ error: `Failed to append handoff entry: ${(error as Error).message}` });
    }
  });

  router.post('/api/assignments/:id/decision-record/entries', async (req: Request, res: Response) => {
    try {
      if (!assignmentsDir) {
        res.status(501).json({ error: 'Standalone assignments not configured on this server' });
        return;
      }
      const id = getParam(req.params.id);
      const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Assignment "${id}" not found` });
        return;
      }
      const decisionPath = resolve(resolved.assignmentDir, 'decision-record.md');
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
      const assignment = await getAssignmentDetailById(projectsDir, assignmentsDir, id);
      res.status(201).json({ assignment, content: nextContent });
    } catch (error) {
      console.error('Error appending standalone decision entry:', error);
      res.status(500).json({ error: `Failed to append decision entry: ${(error as Error).message}` });
    }
  });

  router.post('/api/assignments/:id/status-override', async (req: Request, res: Response) => {
    try {
      if (!assignmentsDir) {
        res.status(501).json({ error: 'Standalone assignments not configured on this server' });
        return;
      }
      const id = getParam(req.params.id);
      const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Assignment "${id}" not found` });
        return;
      }
      const assignmentPath = resolve(resolved.assignmentDir, 'assignment.md');
      if (!(await fileExists(assignmentPath))) {
        res.status(404).json({ error: 'Assignment not found' });
        return;
      }
      const { status } = req.body || {};
      const config = await getStatusConfig();
      const validStatuses = config.statuses.map((s) => s.id);
      if (typeof status !== 'string' || !validStatuses.includes(status)) {
        res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}.` });
        return;
      }
      let content = await readFile(assignmentPath, 'utf-8');
      content = setTopLevelField(content, 'status', status);
      content = setTopLevelField(content, 'updated', nowTimestamp());
      if (status !== 'blocked') {
        content = setTopLevelField(content, 'blockedReason', null);
      }
      await writeFileForce(assignmentPath, content);
      const assignment = await getAssignmentDetailById(projectsDir, assignmentsDir, id);
      res.json({ assignment });
    } catch (error) {
      console.error('Error overriding standalone status:', error);
      res.status(500).json({ error: `Failed to override status: ${(error as Error).message}` });
    }
  });

  router.patch('/api/assignments/:id/assignee', async (req: Request, res: Response) => {
    try {
      if (!assignmentsDir) {
        res.status(501).json({ error: 'Standalone assignments not configured on this server' });
        return;
      }
      const id = getParam(req.params.id);
      const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Assignment "${id}" not found` });
        return;
      }
      const assignmentPath = resolve(resolved.assignmentDir, 'assignment.md');
      if (!(await fileExists(assignmentPath))) {
        res.status(404).json({ error: 'Assignment not found' });
        return;
      }
      const validation = validateAssigneeBody(req.body);
      if (!validation.ok) {
        res.status(400).json({ error: validation.error });
        return;
      }
      let content = await readFile(assignmentPath, 'utf-8');
      content = setTopLevelField(content, 'assignee', validation.value);
      content = setTopLevelField(content, 'updated', nowTimestamp());
      await writeFileForce(assignmentPath, content);
      const assignment = await getAssignmentDetailById(projectsDir, assignmentsDir, id);
      res.json({ assignment });
    } catch (error) {
      console.error('Error updating standalone assignee:', error);
      res.status(500).json({ error: `Failed to update assignee: ${(error as Error).message}` });
    }
  });

  router.post('/api/assignments/bulk-status-override', async (req: Request, res: Response) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || !Array.isArray(body.items)) {
        res.status(400).json({ error: 'Request body must include `items` (array).' });
        return;
      }
      const items = body.items as Array<unknown>;
      if (items.length === 0) {
        res.status(400).json({ error: '`items` must contain at least one entry.' });
        return;
      }
      if (items.length > 200) {
        res.status(400).json({ error: '`items` is capped at 200 entries per call.' });
        return;
      }

      const config = await getStatusConfig();
      const validStatuses = new Set(config.statuses.map((s) => s.id));
      const timestamp = nowTimestamp();
      const results: Array<{ key: string; ok: boolean; error?: string }> = [];
      let succeeded = 0;
      let failed = 0;

      for (let index = 0; index < items.length; index += 1) {
        const raw = items[index];
        const itemKey = buildBulkItemKey(raw, index);
        try {
          if (!raw || typeof raw !== 'object') {
            throw new Error('item must be an object');
          }
          const item = raw as Record<string, unknown>;
          const status = typeof item.status === 'string' ? item.status : null;
          if (!status || !validStatuses.has(status)) {
            throw new Error(`invalid status "${status ?? ''}"`);
          }

          let assignmentPath: string | null = null;
          if (typeof item.id === 'string' && item.id.trim()) {
            if (!assignmentsDir) {
              throw new Error('standalone assignments are not configured on this server');
            }
            const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, item.id);
            if (!resolved) {
              throw new Error(`assignment "${item.id}" not found`);
            }
            assignmentPath = resolve(resolved.assignmentDir, 'assignment.md');
          } else if (
            typeof item.projectSlug === 'string'
            && typeof item.assignmentSlug === 'string'
            && item.projectSlug
            && item.assignmentSlug
          ) {
            assignmentPath = resolve(
              projectsDir,
              item.projectSlug,
              'assignments',
              item.assignmentSlug,
              'assignment.md',
            );
          } else {
            throw new Error('must supply either `id` or both `projectSlug` and `assignmentSlug`');
          }

          if (!(await fileExists(assignmentPath))) {
            throw new Error('assignment file not found');
          }

          let content = await readFile(assignmentPath, 'utf-8');
          content = setTopLevelField(content, 'status', status);
          content = setTopLevelField(content, 'updated', timestamp);
          if (status !== 'blocked') {
            content = setTopLevelField(content, 'blockedReason', null);
          }
          await writeFileForce(assignmentPath, content);

          results.push({ key: itemKey, ok: true });
          succeeded += 1;
        } catch (error) {
          results.push({ key: itemKey, ok: false, error: (error as Error).message });
          failed += 1;
        }
      }

      res.json({ results, succeeded, failed });
    } catch (error) {
      console.error('Error in bulk-status-override:', error);
      res.status(500).json({ error: `Bulk status override failed: ${(error as Error).message}` });
    }
  });

  router.patch('/api/assignments/:id/acceptance-criteria/:index', async (req: Request, res: Response) => {
    try {
      if (!assignmentsDir) {
        res.status(501).json({ error: 'Standalone assignments not configured on this server' });
        return;
      }
      const id = getParam(req.params.id);
      const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Assignment "${id}" not found` });
        return;
      }
      const assignmentPath = resolve(resolved.assignmentDir, 'assignment.md');
      const currentContent = await readCurrentDocument(assignmentPath);
      if (!currentContent) {
        res.status(404).json({ error: 'Assignment not found' });
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
      await writeFileForce(assignmentPath, nextContent);
      const assignment = await getAssignmentDetailById(projectsDir, assignmentsDir, id);
      res.json({ assignment, content: nextContent });
    } catch (error) {
      console.error('Error toggling standalone acceptance criterion:', error);
      res.status(500).json({ error: `Failed to toggle acceptance criterion: ${(error as Error).message}` });
    }
  });

  router.post('/api/assignments/:id/transitions/:command', async (req: Request, res: Response) => {
    try {
      if (!assignmentsDir) {
        res.status(501).json({ error: 'Standalone assignments not configured on this server' });
        return;
      }
      const id = getParam(req.params.id);
      const command = getParam(req.params.command);
      const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Assignment "${id}" not found` });
        return;
      }

      const { reason } = req.body || {};
      const transitionResult = await executeTransitionByDir(
        resolved.assignmentDir,
        command as any,
        {
          standalone: resolved.standalone,
          reason: typeof reason === 'string' ? reason : undefined,
          linkedTodosLookup,
        },
      );
      if (!transitionResult.success) {
        res.status(400).json({ error: transitionResult.message, fromStatus: transitionResult.fromStatus });
        return;
      }

      const detail = resolved.standalone
        ? await getAssignmentDetailById(projectsDir, assignmentsDir, id)
        : await getAssignmentDetail(projectsDir, resolved.projectSlug!, resolved.assignmentSlug);
      res.json({ assignment: detail, warnings: transitionResult.warnings ?? [] });
    } catch (error) {
      console.error('Error transitioning by id:', error);
      res.status(500).json({ error: `Failed to transition: ${(error as Error).message}` });
    }
  });

  return router;
}

function slugifyLocal(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'untitled';
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

function buildBulkItemKey(raw: unknown, index: number): string {
  if (raw && typeof raw === 'object') {
    const item = raw as Record<string, unknown>;
    if (typeof item.id === 'string' && item.id.trim()) return item.id;
    if (typeof item.projectSlug === 'string' && typeof item.assignmentSlug === 'string') {
      return `${item.projectSlug}/${item.assignmentSlug}`;
    }
  }
  return `#${index}`;
}

async function appendCommentTo(
  assignmentDir: string,
  assignmentRef: string,
  req: Request,
  res: Response,
  reloadDetail: () => Promise<unknown>,
): Promise<void> {
  const commentsPath = resolve(assignmentDir, 'comments.md');
  const { body, author, type, replyTo } = req.body || {};
  if (!body || typeof body !== 'string' || !body.trim()) {
    res.status(400).json({ error: 'body is required' });
    return;
  }
  const commentType: CommentType = type && ['question', 'note', 'feedback'].includes(type) ? type : 'note';
  const timestamp = nowTimestamp();
  const entryAuthor = (typeof author === 'string' && author.trim()) ? author.trim() : 'human';

  let currentContent: string;
  let currentCount = 0;
  if (await fileExists(commentsPath)) {
    currentContent = await readFile(commentsPath, 'utf-8');
    const countMatch = currentContent.match(/^entryCount:\s*(\d+)/m);
    if (countMatch) currentCount = parseInt(countMatch[1], 10);
  } else {
    currentContent = renderComments({ assignment: assignmentRef, timestamp });
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
  next = setTopLevelField(next, 'updated', `"${timestamp}"`);
  if (next.includes('No comments yet.')) {
    next = next.replace('No comments yet.', entry.trimEnd());
  } else {
    next = `${next.trimEnd()}\n\n${entry}`;
  }
  await writeFileForce(commentsPath, next);
  const assignment = await reloadDetail();
  res.status(201).json({ assignment, comment: { id: comment.id } });
}

async function toggleCommentResolvedAt(
  assignmentDir: string,
  commentId: string,
  req: Request,
  res: Response,
  reloadDetail: () => Promise<unknown>,
): Promise<void> {
  const commentsPath = resolve(assignmentDir, 'comments.md');
  if (!(await fileExists(commentsPath))) {
    res.status(404).json({ error: 'Comments file not found' });
    return;
  }
  const { resolved: desired } = req.body || {};
  if (typeof desired !== 'boolean') {
    res.status(400).json({ error: 'resolved (boolean) is required' });
    return;
  }
  const content = await readFile(commentsPath, 'utf-8');
  const parsed = parseComments(content);
  const target = parsed.entries.find((e) => e.id === commentId);
  if (!target) {
    res.status(404).json({ error: `Comment ${commentId} not found` });
    return;
  }
  if (target.type !== 'question') {
    res.status(400).json({ error: 'Only questions can be resolved' });
    return;
  }
  const entryBlockRegex = new RegExp(
    `(^## ${commentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?)(\\*\\*Resolved:\\*\\*\\s*(?:true|false))`,
    'm',
  );
  const next = content.replace(entryBlockRegex, (_m, preamble) => `${preamble}**Resolved:** ${desired ? 'true' : 'false'}`);
  if (next === content) {
    res.status(500).json({ error: 'Failed to update resolved flag' });
    return;
  }
  const withUpdated = setTopLevelField(next, 'updated', `"${nowTimestamp()}"`);
  await writeFileForce(commentsPath, withUpdated);
  const assignment = await reloadDetail();
  res.json({ assignment });
}
