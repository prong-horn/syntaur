import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileExists } from './fs.js';

export async function findPackageRoot(
  expectedRelativePath: string,
): Promise<string> {
  let currentDir = dirname(fileURLToPath(import.meta.url));

  while (true) {
    const candidate = resolve(currentDir, expectedRelativePath);
    if (await fileExists(candidate)) {
      return currentDir;
    }

    const parentDir = resolve(currentDir, '..');
    if (parentDir === currentDir) {
      throw new Error(
        `Could not locate package root containing ${expectedRelativePath}.`,
      );
    }
    currentDir = parentDir;
  }
}
