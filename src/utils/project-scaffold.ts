import { resolve } from 'node:path';
import { ensureDir, fileExists, writeFileForce } from './fs.js';
import { nowTimestamp } from './timestamp.js';
import { generateId } from './uuid.js';
import { renderProject } from '../templates/index.js';

export const REQUIRED_PROJECT_SCAFFOLD_FILES = ['project.md'] as const;

export interface ProjectScaffoldParams {
  slug: string;
  title: string;
  prefix: string;
  nextTicket: number;
  id?: string;
  timestamp?: string;
  defaultTemplate?: string;
}

export async function writeProjectScaffold(
  projectDir: string,
  params: ProjectScaffoldParams,
  options?: { onlyMissing?: boolean },
): Promise<void> {
  const timestamp = params.timestamp ?? nowTimestamp();
  const id = params.id ?? generateId();

  await ensureDir(resolve(projectDir, 'tickets'));

  const projectPath = resolve(projectDir, 'project.md');
  const content = renderProject({
    id,
    slug: params.slug,
    title: params.title,
    timestamp,
    prefix: params.prefix,
    nextTicket: params.nextTicket,
    defaultTemplate: params.defaultTemplate ?? 'feature',
  });

  if (!(options?.onlyMissing && (await fileExists(projectPath)))) {
    await writeFileForce(projectPath, content);
  }
}
