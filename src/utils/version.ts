import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function readPackageVersion(
  scriptUrl: string,
): Promise<string | null> {
  try {
    const scriptPath = fileURLToPath(scriptUrl);
    const pkgRoot = dirname(dirname(scriptPath));
    const raw = await readFile(join(pkgRoot, 'package.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}
