import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { expandHome, assignmentsDir as assignmentsDirFn } from '../utils/paths.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { isValidSlug } from '../utils/slug.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { resolveAssignmentById } from '../utils/assignment-resolver.js';
import { appendTodosToAssignmentBody, touchAssignmentUpdated } from '../utils/assignment-todos.js';

export interface RequestOptions {
  project?: string;
  dir?: string;
  from?: string;
}

export async function requestCommand(
  target: string,
  text: string,
  options: RequestOptions = {},
): Promise<void> {
  if (!text || !text.trim()) {
    throw new Error('Request text cannot be empty.');
  }

  const config = await readConfig();
  const baseDir = options.dir ? expandHome(options.dir) : config.defaultProjectDir;

  let assignmentDir: string;
  let targetRef: string;
  if (options.project) {
    if (!isValidSlug(options.project)) {
      throw new Error(`Invalid project slug "${options.project}".`);
    }
    if (!isValidSlug(target)) {
      throw new Error(`Invalid assignment slug "${target}".`);
    }
    assignmentDir = resolve(baseDir, options.project, 'assignments', target);
    targetRef = target;
  } else {
    const resolved = await resolveAssignmentById(baseDir, assignmentsDirFn(), target);
    if (!resolved) {
      throw new Error(`Target assignment "${target}" not found. Provide --project <slug> or a valid UUID.`);
    }
    assignmentDir = resolved.assignmentDir;
    targetRef = resolved.standalone ? resolved.id : resolved.assignmentSlug;
  }

  const assignmentMdPath = resolve(assignmentDir, 'assignment.md');
  if (!(await fileExists(assignmentMdPath))) {
    throw new Error(`assignment.md not found at ${assignmentMdPath}`);
  }

  const source = options.from
    ?? process.env.SYNTAUR_ASSIGNMENT
    ?? 'unknown';

  let content = await readFile(assignmentMdPath, 'utf-8');
  content = appendTodosToAssignmentBody(content, [
    { description: `${text.trim()} (from: ${source})` },
  ]);
  content = touchAssignmentUpdated(content, nowTimestamp());

  await writeFileForce(assignmentMdPath, content);

  console.log(`Added todo to ${targetRef}: ${text.trim()} (from: ${source})`);
}
