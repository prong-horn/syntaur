import { mkdir, writeFile, access, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function writeFileSafe(
  filePath: string,
  content: string,
): Promise<boolean> {
  if (await fileExists(filePath)) {
    return false;
  }
  await ensureDir(dirname(filePath));
  await writeFile(filePath, content, 'utf-8');
  return true;
}

export async function writeFileForce(
  filePath: string,
  content: string,
): Promise<void> {
  const dir = dirname(filePath);
  const tempPath = join(
    dir,
    `.${Math.random().toString(36).slice(2)}.${Date.now()}.tmp`,
  );
  await ensureDir(dir);
  await writeFile(tempPath, content, 'utf-8');
  await rename(tempPath, filePath);
}
