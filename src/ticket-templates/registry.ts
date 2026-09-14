import { resolve } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { fileExists } from '../utils/fs.js';
import { parseTemplateManifest, type TemplateManifest } from './manifest.js';
import { validateTemplate, validateTemplateId } from './validate.js';
import { builtinStatus, type BuiltinDriftStatus, BUILTIN_TEMPLATE_IDS } from './builtins.js';

export const LEGACY_TEMPLATE_ID = 'legacy';

export function templatesDir(root: string): string {
  return resolve(root, 'templates');
}

export interface TemplateSummary {
  id: string;
  description: string;
  whenToUse: string;
  builtin?: string;
  driftStatus?: BuiltinDriftStatus;
  stageIds: string[];
  filePaths: string[];
  manifest: TemplateManifest;
}

export async function loadTemplate(root: string, id: string): Promise<TemplateManifest> {
  const dir = resolve(templatesDir(root), id);
  const manifestPath = resolve(dir, 'template.md');
  if (!(await fileExists(manifestPath))) {
    throw new Error(`template ${id} not found (syntaur template list)`);
  }
  const content = await readFile(manifestPath, 'utf-8');
  return parseTemplateManifest(manifestPath, id, content);
}

export async function listTemplates(root: string): Promise<TemplateSummary[]> {
  const dir = templatesDir(root);
  if (!(await fileExists(dir))) return [];

  const entries = await readdir(dir, { withFileTypes: true });
  const summaries: TemplateSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const manifestPath = resolve(dir, id, 'template.md');
    if (!(await fileExists(manifestPath))) continue;

    const content = await readFile(manifestPath, 'utf-8');
    const manifest = parseTemplateManifest(manifestPath, id, content);

    let driftStatus: BuiltinDriftStatus | undefined;
    if ((BUILTIN_TEMPLATE_IDS as readonly string[]).includes(id)) {
      driftStatus = await builtinStatus(root, id as (typeof BUILTIN_TEMPLATE_IDS)[number]);
    }

    summaries.push({
      id,
      description: manifest.description,
      whenToUse: manifest.whenToUse,
      builtin: manifest.builtin,
      driftStatus,
      stageIds: manifest.stages.map((s) => s.id),
      filePaths: manifest.files.map((f) => f.path),
      manifest,
    });
  }

  return summaries.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Resolve the template id for a ticket. Missing field → legacy.
 */
export function resolveTemplateForTicket(
  frontmatter: { template?: string | null },
): string {
  const t = frontmatter.template;
  if (t === undefined || t === null || t === '') return LEGACY_TEMPLATE_ID;
  return t;
}

export async function validateTemplateDir(
  root: string,
  id: string,
): Promise<{ manifest: TemplateManifest; issues: { rule: number | string; message: string }[] }> {
  const dir = resolve(templatesDir(root), id);
  const manifestPath = resolve(dir, 'template.md');
  const content = await readFile(manifestPath, 'utf-8');
  const manifest = parseTemplateManifest(manifestPath, id, content);
  const dirEntries = await readdir(dir);
  const issues = [
    ...validateTemplateId(manifest, id),
    ...validateTemplate(manifest, dirEntries),
  ];
  return { manifest, issues };
}
