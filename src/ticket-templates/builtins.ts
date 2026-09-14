import { resolve, dirname } from 'node:path';
import { readdir, readFile, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureDir, fileExists } from '../utils/fs.js';

export const BUILTIN_TEMPLATE_IDS = ['feature', 'bug', 'spike', 'quick', 'legacy'] as const;
export type BuiltinTemplateId = (typeof BUILTIN_TEMPLATE_IDS)[number];

export type BuiltinDriftStatus = 'current' | 'modified' | 'outdated' | 'missing';

/** Shipped built-ins under the package `templates/` directory. */
export function builtinTemplatesDir(): string {
  let currentDir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = resolve(currentDir, 'templates');
    if (existsSync(resolve(candidate, 'feature', 'template.md'))) {
      return candidate;
    }
    const parentDir = resolve(currentDir, '..');
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  throw new Error('Could not locate shipped templates directory.');
}

async function readBuiltinStamp(id: BuiltinTemplateId): Promise<string | null> {
  const path = resolve(builtinTemplatesDir(), id, 'template.md');
  const content = await readFile(path, 'utf-8');
  const match = content.match(/^---\n[\s\S]*?^builtin:\s*(\S+)/m);
  return match?.[1] ?? null;
}

async function readHomeStamp(root: string, id: string): Promise<string | null> {
  const path = resolve(root, 'templates', id, 'template.md');
  if (!(await fileExists(path))) return null;
  const content = await readFile(path, 'utf-8');
  const match = content.match(/^---\n[\s\S]*?^builtin:\s*(\S+)/m);
  return match?.[1] ?? null;
}

async function filesMatchBuiltin(root: string, id: BuiltinTemplateId): Promise<boolean> {
  const shippedDir = resolve(builtinTemplatesDir(), id);
  const homeDir = resolve(root, 'templates', id);
  if (!(await fileExists(homeDir))) return false;

  const shippedEntries = await readdir(shippedDir, { withFileTypes: true });
  for (const entry of shippedEntries) {
    if (!entry.isFile()) continue;
    const shippedPath = resolve(shippedDir, entry.name);
    const homePath = resolve(homeDir, entry.name);
    if (!(await fileExists(homePath))) return false;
    const [shipped, home] = await Promise.all([
      readFile(shippedPath),
      readFile(homePath),
    ]);
    if (!shipped.equals(home)) return false;
  }
  return true;
}

/**
 * Report drift status for one built-in template in the home.
 */
export async function builtinStatus(
  root: string,
  id: BuiltinTemplateId,
): Promise<BuiltinDriftStatus> {
  const homeDir = resolve(root, 'templates', id);
  if (!(await fileExists(homeDir))) return 'missing';

  const shippedStamp = await readBuiltinStamp(id);
  const homeStamp = await readHomeStamp(root, id);

  if (shippedStamp && homeStamp && shippedStamp !== homeStamp) {
    return 'outdated';
  }

  if (await filesMatchBuiltin(root, id)) {
    return 'current';
  }
  return 'modified';
}

/**
 * Seed built-in templates that are absent. Never overwrites existing directories.
 */
export async function seedMissingBuiltins(root: string): Promise<string[]> {
  const seeded: string[] = [];
  const templatesRoot = resolve(root, 'templates');
  await ensureDir(templatesRoot);

  for (const id of BUILTIN_TEMPLATE_IDS) {
    const targetDir = resolve(templatesRoot, id);
    if (await fileExists(targetDir)) continue;

    const sourceDir = resolve(builtinTemplatesDir(), id);
    await cp(sourceDir, targetDir, { recursive: true });
    seeded.push(id);
  }
  return seeded;
}

/**
 * Restore one built-in from the shipped package. Extra files in the home copy are kept.
 */
export async function resetBuiltin(root: string, id: BuiltinTemplateId): Promise<void> {
  const sourceDir = resolve(builtinTemplatesDir(), id);
  const targetDir = resolve(root, 'templates', id);
  await ensureDir(targetDir);

  const shippedEntries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of shippedEntries) {
    if (!entry.isFile()) continue;
    const content = await readFile(resolve(sourceDir, entry.name), 'utf-8');
    const { writeFileForce } = await import('../utils/fs.js');
    await writeFileForce(resolve(targetDir, entry.name), content);
  }
}

/**
 * Reset all missing built-ins (same as seedMissingBuiltins but returns count).
 */
export async function resetMissingBuiltins(root: string): Promise<string[]> {
  return seedMissingBuiltins(root);
}
