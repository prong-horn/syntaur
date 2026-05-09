import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseResource, parseMemory } from '../dashboard/parser.js';
import { fileExists, writeFileForce, ensureDir } from './fs.js';

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function readProjectSlug(projectDir: string): string {
  return projectDir.split('/').filter(Boolean).pop() ?? '';
}

async function listSlugFiles(dir: string): Promise<string[]> {
  if (!(await fileExists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort();
}

function escapeCell(value: string): string {
  // Pipes break markdown tables; escape them. Newlines collapse to spaces.
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function joinList(items: string[]): string {
  return items.length === 0 ? '—' : items.map(escapeCell).join(', ');
}

export async function rebuildResourcesIndex(projectDir: string): Promise<{
  total: number;
  path: string;
}> {
  const dir = resolve(projectDir, 'resources');
  await ensureDir(dir);
  const files = await listSlugFiles(dir);
  const slug = readProjectSlug(projectDir);
  const lines: string[] = [];
  lines.push('---');
  lines.push(`project: ${slug}`);
  lines.push(`generated: "${nowIso()}"`);
  lines.push(`total: ${files.length}`);
  lines.push('---');
  lines.push('');
  lines.push('# Resources');
  lines.push('');
  lines.push('| Name | Category | Source | Related Assignments | Updated |');
  lines.push('|------|----------|--------|---------------------|---------|');
  for (const fileName of files) {
    const content = await readFile(resolve(dir, fileName), 'utf-8');
    const parsed = parseResource(content);
    const slugBase = fileName.replace(/\.md$/, '');
    const name = parsed.name || slugBase;
    const link = `[${escapeCell(name)}](./${fileName})`;
    lines.push(
      `| ${link} | ${escapeCell(parsed.category)} | ${escapeCell(parsed.source)} | ${joinList(parsed.relatedAssignments)} | ${escapeCell(parsed.updated)} |`,
    );
  }
  lines.push('');
  const indexPath = resolve(dir, '_index.md');
  await writeFileForce(indexPath, lines.join('\n'));
  return { total: files.length, path: indexPath };
}

export async function rebuildMemoriesIndex(projectDir: string): Promise<{
  total: number;
  path: string;
}> {
  const dir = resolve(projectDir, 'memories');
  await ensureDir(dir);
  const files = await listSlugFiles(dir);
  const slug = readProjectSlug(projectDir);
  const lines: string[] = [];
  lines.push('---');
  lines.push(`project: ${slug}`);
  lines.push(`generated: "${nowIso()}"`);
  lines.push(`total: ${files.length}`);
  lines.push('---');
  lines.push('');
  lines.push('# Memories');
  lines.push('');
  lines.push('| Name | Source | Scope | Source Assignment | Updated |');
  lines.push('|------|--------|-------|-------------------|---------|');
  for (const fileName of files) {
    const content = await readFile(resolve(dir, fileName), 'utf-8');
    const parsed = parseMemory(content);
    const slugBase = fileName.replace(/\.md$/, '');
    const name = parsed.name || slugBase;
    const link = `[${escapeCell(name)}](./${fileName})`;
    lines.push(
      `| ${link} | ${escapeCell(parsed.source)} | ${escapeCell(parsed.scope)} | ${escapeCell(parsed.sourceAssignment ?? '—')} | ${escapeCell(parsed.updated)} |`,
    );
  }
  lines.push('');
  const indexPath = resolve(dir, '_index.md');
  await writeFileForce(indexPath, lines.join('\n'));
  return { total: files.length, path: indexPath };
}
