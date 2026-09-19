import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileExists } from './fs.js';
import { readConfig } from './config.js';
import { syntaurRoot } from './paths.js';

export async function isSyntaurDataInstalled(): Promise<boolean> {
  return fileExists(resolve(syntaurRoot(), 'config.md'));
}

export function isSyntaurDataInstalledSync(): boolean {
  return existsSync(resolve(syntaurRoot(), 'config.md'));
}

export async function getConfiguredProjectDir(): Promise<string | null> {
  if (!(await fileExists(resolve(syntaurRoot(), 'config.md')))) {
    return null;
  }

  return (await readConfig()).defaultProjectDir;
}
