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
  parseMission,
  parsePlan,
  parseScratchpad,
} from './parser.js';
import { toggleAcceptanceCriterion } from './acceptance-criteria.js';
import {
  getAssignmentDetail,
  getEditableDocument,
  getMissionDetail,
  getStatusConfig,
} from './api.js';
import {
  renderMission,
  renderManifest,
  renderAgent,
  renderClaude,
  renderIndexAssignments,
  renderIndexPlans,
  renderIndexDecisions,
  renderStatus,
  renderResourcesIndex,
  renderMemoriesIndex,
  renderAssignment,
  renderPlan,
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

export function createWriteRouter(missionsDir: string): Router {
  const router = Router();

  router.get('/api/templates/mission', (_req: Request, res: Response) => {
    const content = renderMission({
      id: generateId(),
      slug: 'my-new-mission',
      title: 'My New Mission',
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
    });
    res.json({ content });
  });

  router.get('/api/missions/:slug/edit', async (req: Request, res: Response) => {
    const slug = getParam(req.params.slug);
    const document = await getEditableDocument(missionsDir, 'mission', slug);
    if (!document) {
      res.status(404).json({ error: `Mission "${slug}" not found` });
      return;
    }
    res.json(document);
  });

  router.get('/api/missions/:slug/assignments/:aslug/edit', async (req: Request, res: Response) => {
    const slug = getParam(req.params.slug);
    const assignmentSlug = getParam(req.params.aslug);
    const document = await getEditableDocument(
      missionsDir,
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

  router.get('/api/missions/:slug/assignments/:aslug/plan/edit', async (req: Request, res: Response) => {
    const slug = getParam(req.params.slug);
    const assignmentSlug = getParam(req.params.aslug);
    const document = await getEditableDocument(
      missionsDir,
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

  router.get('/api/missions/:slug/assignments/:aslug/scratchpad/edit', async (req: Request, res: Response) => {
    const slug = getParam(req.params.slug);
    const assignmentSlug = getParam(req.params.aslug);
    const document = await getEditableDocument(
      missionsDir,
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

  router.get('/api/missions/:slug/assignments/:aslug/handoff/edit', async (req: Request, res: Response) => {
    const slug = getParam(req.params.slug);
    const assignmentSlug = getParam(req.params.aslug);
    const document = await getEditableDocument(
      missionsDir,
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

  router.get('/api/missions/:slug/assignments/:aslug/decision-record/edit', async (req: Request, res: Response) => {
    const slug = getParam(req.params.slug);
    const assignmentSlug = getParam(req.params.aslug);
    const document = await getEditableDocument(
      missionsDir,
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

  router.post('/api/missions', async (req: Request, res: Response) => {
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

      const missionDir = resolve(missionsDir, slug);
      if (await fileExists(missionDir)) {
        res.status(409).json({ error: `Mission "${slug}" already exists` });
        return;
      }

      const title = fields.title;
      const timestamp = fields.created || nowTimestamp();

      await ensureDir(resolve(missionDir, 'assignments'));
      await ensureDir(resolve(missionDir, 'resources'));
      await ensureDir(resolve(missionDir, 'memories'));

      await writeFileForce(resolve(missionDir, 'mission.md'), content);

      try {
        const companions: Array<[string, string]> = [
          [resolve(missionDir, 'manifest.md'), renderManifest({ slug, timestamp })],
          [resolve(missionDir, 'agent.md'), renderAgent({ slug, timestamp })],
          [resolve(missionDir, 'claude.md'), renderClaude({ slug })],
          [resolve(missionDir, '_index-assignments.md'), renderIndexAssignments({ slug, title, timestamp })],
          [resolve(missionDir, '_index-plans.md'), renderIndexPlans({ slug, title, timestamp })],
          [resolve(missionDir, '_index-decisions.md'), renderIndexDecisions({ slug, title, timestamp })],
          [resolve(missionDir, '_status.md'), renderStatus({ slug, title, timestamp })],
          [resolve(missionDir, 'resources', '_index.md'), renderResourcesIndex({ slug, title, timestamp })],
          [resolve(missionDir, 'memories', '_index.md'), renderMemoriesIndex({ slug, title, timestamp })],
        ];

        for (const [filePath, fileContent] of companions) {
          await writeFileForce(filePath, fileContent);
        }
      } catch (companionError) {
        try {
          await rm(missionDir, { recursive: true, force: true });
        } catch {
          // Best effort cleanup only.
        }
        throw companionError;
      }

      res.status(201).json({ slug });
    } catch (error) {
      console.error('Error creating mission:', error);
      res.status(500).json({ error: `Failed to create mission: ${(error as Error).message}` });
    }
  });

  router.post('/api/missions/:slug/assignments', async (req: Request, res: Response) => {
    try {
      const missionSlug = getParam(req.params.slug);
      const missionDir = resolve(missionsDir, missionSlug);
      const missionMdPath = resolve(missionDir, 'mission.md');

      if (!(await fileExists(missionMdPath))) {
        res.status(404).json({ error: `Mission "${missionSlug}" not found` });
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

      const assignmentDir = resolve(missionDir, 'assignments', assignmentSlug);
      if (await fileExists(assignmentDir)) {
        res.status(409).json({
          error: `Assignment "${assignmentSlug}" already exists in mission "${missionSlug}"`,
        });
        return;
      }

      const title = fields.title;
      const timestamp = fields.created || nowTimestamp();

      await ensureDir(assignmentDir);
      await writeFileForce(resolve(assignmentDir, 'assignment.md'), content);

      try {
        const companions: Array<[string, string]> = [
          [resolve(assignmentDir, 'plan.md'), renderPlan({ assignmentSlug, title, timestamp })],
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

      res.status(201).json({ slug: assignmentSlug, missionSlug });
    } catch (error) {
      console.error('Error creating assignment:', error);
      res.status(500).json({ error: `Failed to create assignment: ${(error as Error).message}` });
    }
  });

  router.patch('/api/missions/:slug', async (req: Request, res: Response) => {
    try {
      const missionSlug = getParam(req.params.slug);
      const missionPath = resolve(missionsDir, missionSlug, 'mission.md');
      const currentContent = await readCurrentDocument(missionPath);
      if (!currentContent) {
        res.status(404).json({ error: `Mission "${missionSlug}" not found` });
        return;
      }

      const nextContentRaw = requireContent(req, res);
      if (!nextContentRaw) {
        return;
      }

      const current = parseMission(currentContent);
      const next = parseMission(nextContentRaw);

      if (!next.slug || !next.title) {
        res.status(400).json({ error: 'Mission content must include slug and title.' });
        return;
      }

      if (next.slug !== current.slug) {
        res.status(400).json({ error: 'Mission slug cannot be changed once created.' });
        return;
      }

      const nextContent = setTopLevelField(nextContentRaw, 'updated', nowTimestamp());
      await writeFileForce(missionPath, nextContent);

      const mission = await getMissionDetail(missionsDir, missionSlug);
      res.json({ mission, content: nextContent });
    } catch (error) {
      console.error('Error updating mission:', error);
      res.status(500).json({ error: `Failed to update mission: ${(error as Error).message}` });
    }
  });

  router.patch('/api/missions/:slug/assignments/:aslug', async (req: Request, res: Response) => {
    try {
      const missionSlug = getParam(req.params.slug);
      const assignmentSlug = getParam(req.params.aslug);
      const assignmentPath = resolve(
        missionsDir,
        missionSlug,
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

      const assignment = await getAssignmentDetail(missionsDir, missionSlug, assignmentSlug);
      res.json({ assignment, content: nextContent });
    } catch (error) {
      console.error('Error updating assignment:', error);
      res.status(500).json({ error: `Failed to update assignment: ${(error as Error).message}` });
    }
  });

  router.patch('/api/missions/:slug/assignments/:aslug/acceptance-criteria/:index', async (req: Request, res: Response) => {
    try {
      const missionSlug = getParam(req.params.slug);
      const assignmentSlug = getParam(req.params.aslug);
      const assignmentPath = resolve(
        missionsDir,
        missionSlug,
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

      const assignment = await getAssignmentDetail(missionsDir, missionSlug, assignmentSlug);
      res.json({ assignment, content: nextContent });
    } catch (error) {
      console.error('Error toggling acceptance criterion:', error);
      res.status(500).json({ error: `Failed to toggle acceptance criterion: ${(error as Error).message}` });
    }
  });

  router.patch('/api/missions/:slug/assignments/:aslug/plan', async (req: Request, res: Response) => {
    try {
      const missionSlug = getParam(req.params.slug);
      const assignmentSlug = getParam(req.params.aslug);
      const planPath = resolve(
        missionsDir,
        missionSlug,
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

      const assignment = await getAssignmentDetail(missionsDir, missionSlug, assignmentSlug);
      res.json({ assignment, content: nextContent });
    } catch (error) {
      console.error('Error updating plan:', error);
      res.status(500).json({ error: `Failed to update plan: ${(error as Error).message}` });
    }
  });

  router.patch('/api/missions/:slug/assignments/:aslug/scratchpad', async (req: Request, res: Response) => {
    try {
      const missionSlug = getParam(req.params.slug);
      const assignmentSlug = getParam(req.params.aslug);
      const scratchpadPath = resolve(
        missionsDir,
        missionSlug,
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

      const assignment = await getAssignmentDetail(missionsDir, missionSlug, assignmentSlug);
      res.json({ assignment, content: nextContent });
    } catch (error) {
      console.error('Error updating scratchpad:', error);
      res.status(500).json({ error: `Failed to update scratchpad: ${(error as Error).message}` });
    }
  });

  router.post('/api/missions/:slug/assignments/:aslug/handoff/entries', async (req: Request, res: Response) => {
    try {
      const missionSlug = getParam(req.params.slug);
      const assignmentSlug = getParam(req.params.aslug);
      const handoffPath = resolve(
        missionsDir,
        missionSlug,
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
      const assignment = await getAssignmentDetail(missionsDir, missionSlug, assignmentSlug);
      res.status(201).json({ assignment, content: nextContent });
    } catch (error) {
      console.error('Error appending handoff entry:', error);
      res.status(500).json({ error: `Failed to append handoff entry: ${(error as Error).message}` });
    }
  });

  router.post('/api/missions/:slug/assignments/:aslug/decision-record/entries', async (req: Request, res: Response) => {
    try {
      const missionSlug = getParam(req.params.slug);
      const assignmentSlug = getParam(req.params.aslug);
      const decisionPath = resolve(
        missionsDir,
        missionSlug,
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
      const assignment = await getAssignmentDetail(missionsDir, missionSlug, assignmentSlug);
      res.status(201).json({ assignment, content: nextContent });
    } catch (error) {
      console.error('Error appending decision entry:', error);
      res.status(500).json({ error: `Failed to append decision entry: ${(error as Error).message}` });
    }
  });

  // --- Move Workspace Endpoint ---

  router.post('/api/missions/:slug/move-workspace', async (req: Request, res: Response) => {
    try {
      const missionSlug = getParam(req.params.slug);
      const missionPath = resolve(missionsDir, missionSlug, 'mission.md');
      if (!(await fileExists(missionPath))) {
        res.status(404).json({ error: `Mission "${missionSlug}" not found` });
        return;
      }

      const { workspace } = req.body || {};
      if (workspace !== null && (typeof workspace !== 'string' || !workspace.trim())) {
        res.status(400).json({ error: 'workspace must be a non-empty string or null (for ungrouped).' });
        return;
      }

      let content = await readFile(missionPath, 'utf-8');
      content = setTopLevelField(content, 'workspace', workspace ?? null);
      content = setTopLevelField(content, 'updated', nowTimestamp());
      await writeFileForce(missionPath, content);

      const mission = await getMissionDetail(missionsDir, missionSlug);
      res.json({ mission });
    } catch (error) {
      console.error('Error moving mission workspace:', error);
      res.status(500).json({ error: `Failed to move workspace: ${(error as Error).message}` });
    }
  });

  // --- Status Override Endpoints ---

  router.post('/api/missions/:slug/status-override', async (req: Request, res: Response) => {
    try {
      const missionSlug = getParam(req.params.slug);
      const missionPath = resolve(missionsDir, missionSlug, 'mission.md');
      if (!(await fileExists(missionPath))) {
        res.status(404).json({ error: `Mission "${missionSlug}" not found` });
        return;
      }

      const { status } = req.body || {};
      const config = await getStatusConfig();
      const validStatuses = ['active', 'archived', ...config.statuses.map((s) => s.id)];
      if (status !== null && (typeof status !== 'string' || !validStatuses.includes(status))) {
        res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}, or null to clear.` });
        return;
      }

      let content = await readFile(missionPath, 'utf-8');
      content = setTopLevelField(content, 'statusOverride', status ?? null);
      content = setTopLevelField(content, 'updated', nowTimestamp());
      await writeFileForce(missionPath, content);

      const mission = await getMissionDetail(missionsDir, missionSlug);
      res.json({ mission });
    } catch (error) {
      console.error('Error setting mission status override:', error);
      res.status(500).json({ error: `Failed to set status override: ${(error as Error).message}` });
    }
  });

  router.post('/api/missions/:slug/assignments/:aslug/status-override', async (req: Request, res: Response) => {
    try {
      const missionSlug = getParam(req.params.slug);
      const assignmentSlug = getParam(req.params.aslug);
      const assignmentPath = resolve(
        missionsDir,
        missionSlug,
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

      const assignment = await getAssignmentDetail(missionsDir, missionSlug, assignmentSlug);
      res.json({ assignment });
    } catch (error) {
      console.error('Error overriding assignment status:', error);
      res.status(500).json({ error: `Failed to override status: ${(error as Error).message}` });
    }
  });

  // --- Lifecycle Transitions ---

  router.post('/api/missions/:slug/assignments/:aslug/transitions/:command', async (req: Request, res: Response) => {
    try {
      const missionSlug = getParam(req.params.slug);
      const assignmentSlug = getParam(req.params.aslug);
      const command = req.params.command as Parameters<typeof executeTransition>[2];
      const config = await getStatusConfig();
      const validCommands = [...new Set(config.transitions.map((t) => t.command))];
      if (!validCommands.includes(command)) {
        res.status(400).json({ error: `Unsupported transition command "${req.params.command}"` });
        return;
      }

      const missionDir = resolve(missionsDir, missionSlug);
      const assignmentPath = resolve(missionDir, 'assignments', assignmentSlug, 'assignment.md');
      if (!(await fileExists(assignmentPath))) {
        res.status(404).json({ error: 'Assignment not found' });
        return;
      }

      const { reason } = req.body || {};
      const result = await executeTransition(missionDir, assignmentSlug, command, {
        reason: typeof reason === 'string' ? reason : undefined,
        transitionTable: config.custom ? config.transitionTable : undefined,
        terminalStatuses: config.custom ? config.terminalStatuses : undefined,
      });

      if (!result.success) {
        res.status(400).json({ error: result.message });
        return;
      }

      const assignment = await getAssignmentDetail(missionsDir, missionSlug, assignmentSlug);
      res.json({ assignment, transition: result });
    } catch (error) {
      console.error('Error running assignment transition:', error);
      res.status(500).json({ error: `Failed to transition assignment: ${(error as Error).message}` });
    }
  });

  return router;
}
