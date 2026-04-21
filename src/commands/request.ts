import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { expandHome, assignmentsDir as assignmentsDirFn } from '../utils/paths.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { isValidSlug } from '../utils/slug.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { resolveAssignmentById } from '../utils/assignment-resolver.js';

export interface RequestOptions {
  project?: string;
  dir?: string;
  from?: string;
}

function setTopLevelField(content: string, key: string, value: string): string {
  const fieldRegex = new RegExp(`^(${key}:)\\s*.*$`, 'm');
  if (fieldRegex.test(content)) {
    return content.replace(fieldRegex, `$1 ${value}`);
  }
  return content;
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
  const todoLine = `- [ ] ${text.trim()} (from: ${source})`;

  const todosHeading = /^## Todos\s*$/m;
  if (todosHeading.test(content)) {
    content = content.replace(
      /(^## Todos[\s\S]*?)(\n## |\n*$)/m,
      (_m, section, nextHeading) => {
        return `${section.trimEnd()}\n${todoLine}\n${nextHeading}`;
      },
    );
  } else {
    // No Todos section — append one
    content = `${content.trimEnd()}\n\n## Todos\n\n${todoLine}\n`;
  }

  const timestamp = nowTimestamp();
  content = setTopLevelField(content, 'updated', `"${timestamp}"`);

  await writeFileForce(assignmentMdPath, content);

  console.log(`Added todo to ${targetRef}: ${text.trim()} (from: ${source})`);
}
