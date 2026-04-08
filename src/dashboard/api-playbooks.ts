import { Router } from 'express';
import { resolve } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import { listPlaybooks, getPlaybookDetail } from './api.js';
import { parsePlaybook } from './parser.js';
import { isValidSlug } from '../utils/slug.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { ensureDir, fileExists, writeFileForce } from '../utils/fs.js';
import { renderPlaybook } from '../templates/playbook.js';
import { rebuildPlaybookManifest } from '../utils/playbooks.js';

export function createPlaybooksRouter(playbooksDir: string): Router {
  const router = Router();

  // GET / — list all playbooks
  router.get('/', async (_req, res) => {
    try {
      const playbooks = await listPlaybooks(playbooksDir);
      res.json({ playbooks, generatedAt: new Date().toISOString() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list playbooks' });
    }
  });

  // GET /template/new — scaffold template (must be before /:slug to avoid param capture)
  router.get('/template/new', async (_req, res) => {
    try {
      const content = renderPlaybook({
        slug: 'my-playbook',
        name: 'My Playbook',
        description: 'A new playbook',
        timestamp: nowTimestamp(),
      });
      res.json({ content });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to get template' });
    }
  });

  // GET /:slug — get playbook detail
  router.get('/:slug', async (req, res) => {
    try {
      const detail = await getPlaybookDetail(playbooksDir, req.params.slug);
      if (!detail) {
        res.status(404).json({ error: `Playbook "${req.params.slug}" not found` });
        return;
      }
      res.json(detail);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to get playbook' });
    }
  });

  // GET /:slug/edit — raw file content for editor
  router.get('/:slug/edit', async (req, res) => {
    try {
      const filePath = resolve(playbooksDir, `${req.params.slug}.md`);
      if (!(await fileExists(filePath))) {
        res.status(404).json({ error: `Playbook "${req.params.slug}" not found` });
        return;
      }
      const content = await readFile(filePath, 'utf-8');
      res.json({
        documentType: 'playbook',
        title: `Edit Playbook: ${req.params.slug}`,
        content,
        slug: req.params.slug,
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to get playbook for editing' });
    }
  });

  // POST / — create new playbook
  router.post('/', async (req, res) => {
    try {
      const { content } = req.body;
      if (!content || typeof content !== 'string') {
        res.status(400).json({ error: 'content is required' });
        return;
      }

      const parsed = parsePlaybook(content);
      const slug = parsed.slug;
      if (!slug || !isValidSlug(slug)) {
        res.status(400).json({ error: `Invalid or missing slug: "${slug}"` });
        return;
      }

      await ensureDir(playbooksDir);
      const filePath = resolve(playbooksDir, `${slug}.md`);
      if (await fileExists(filePath)) {
        res.status(409).json({ error: `Playbook "${slug}" already exists` });
        return;
      }

      await writeFileForce(filePath, content);
      await rebuildPlaybookManifest(playbooksDir);
      res.status(201).json({ slug, path: filePath });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to create playbook' });
    }
  });

  // PUT /:slug — update playbook content
  router.put('/:slug', async (req, res) => {
    try {
      const { content } = req.body;
      if (!content || typeof content !== 'string') {
        res.status(400).json({ error: 'content is required' });
        return;
      }

      const filePath = resolve(playbooksDir, `${req.params.slug}.md`);
      if (!(await fileExists(filePath))) {
        res.status(404).json({ error: `Playbook "${req.params.slug}" not found` });
        return;
      }

      await writeFileForce(filePath, content);
      await rebuildPlaybookManifest(playbooksDir);
      res.json({ slug: req.params.slug, path: filePath });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to update playbook' });
    }
  });

  // DELETE /:slug — delete a playbook
  router.delete('/:slug', async (req, res) => {
    try {
      if (req.params.slug === 'manifest') {
        res.status(403).json({ error: 'The playbook manifest cannot be deleted' });
        return;
      }

      const filePath = resolve(playbooksDir, `${req.params.slug}.md`);
      if (!(await fileExists(filePath))) {
        res.status(404).json({ error: `Playbook "${req.params.slug}" not found` });
        return;
      }

      await unlink(filePath);
      await rebuildPlaybookManifest(playbooksDir);
      res.json({ deleted: req.params.slug });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to delete playbook' });
    }
  });

  return router;
}
