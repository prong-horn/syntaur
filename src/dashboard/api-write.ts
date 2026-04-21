import { Router, type Request, type Response } from 'express';
import { resolve } from 'node:path';
import { rm, readFile } from 'node:fs/promises';
import { executeTransition } from '../lifecycle/index.js';
import { isValidSlug } from '../utils/slug.js';
import { generateId } from '../utils/uuid.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { ensureDir, writeFileForce, fileExists } from '../utils/fs.js';
import {
  parseAssignmentFull,
  parseDecisionRecord,
  parseHandoff,
  parseProject,
  parsePlan,
  parseScratchpad,
} from './parser.js';
import { toggleAcceptanceCriterion } from './acceptance-criteria.js';
import {
  getAssignmentDetail,
  getEditableDocument,
  getProjectDetail,
  getStatusConfig,
} from './api.js';
import {
  renderProject,
  renderManifest,
  renderIndexAssignments,
  renderIndexPlans,
  renderIndexDecisions,
  renderStatus,
  renderResourcesIndex,
  renderMemoriesIndex,
  renderAssignment,
  renderScratchpad,
  renderHandoff,
  renderDecisionRecord,
} from '../templates/index.js';

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

export function createWriteRouter(projectsDir: string): Router {
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

  router.get('/api/templates/assignment', (_req: Request, res: Response) => {
    const content = renderAssignment({
      id: generateId(),
      slug: 'my-new-assignment',
      title: 'My New Assignment',
      timestamp: nowTimestamp(),
      priority: 'medium',
      dependsOn: [],
      links: [],
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
      if (workspace !== null && (typeof workspace !== 'string' || !workspace.trim())) {
        res.status(400).json({ error: 'workspace must be a non-empty string or null (for ungrouped).' });
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

  return router;
}
