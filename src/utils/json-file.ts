import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ensureDir, fileExists, writeFileForce } from './fs.js';

export async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  if (!(await fileExists(path))) return {};
  const raw = await readFile(path, 'utf-8');
  if (raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    throw new Error(`Unable to parse ${path}: ${(error as Error).message}. Fix the JSON and re-run.`);
  }
}

export async function writeJsonFileAtomic(
  path: string,
  data: Record<string, unknown>,
): Promise<void> {
  await ensureDir(dirname(path));
  await writeFileForce(path, JSON.stringify(data, null, 2) + '\n');
}
