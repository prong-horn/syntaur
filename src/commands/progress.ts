import { Command } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists } from '../utils/fs.js';
import { defaultProjectDir, assignmentsDir } from '../utils/paths.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { formatProgressEntry, renderProgress } from '../templates/index.js';

interface ContextFile {
  assignmentDir?: string;
  assignmentSlug?: string;
}

async function readContext(cwd: string): Promise<ContextFile | null> {
  const path = resolve(cwd, '.syntaur', 'context.json');
  if (!(await fileExists(path))) return null;
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as ContextFile;
  } catch {
    return null;
  }
}

async function resolveAssignmentDir(opts: {
  assignment?: string;
  project?: string;
  cwd: string;
}): Promise<{ dir: string; slug: string }> {
  if (opts.assignment) {
    if (opts.project) {
      return {
        dir: resolve(defaultProjectDir(), opts.project, 'assignments', opts.assignment),
        slug: opts.assignment,
      };
    }
    return { dir: resolve(assignmentsDir(), opts.assignment), slug: opts.assignment };
  }
  const ctx = await readContext(opts.cwd);
  if (ctx?.assignmentDir) {
    return { dir: ctx.assignmentDir, slug: ctx.assignmentSlug ?? '' };
  }
  throw new Error(
    'No active assignment. Pass --assignment <slug> [--project <slug>] or run from a workspace with .syntaur/context.json.',
  );
}

/**
 * Insert a new entry immediately after the `# Progress` H1 (reverse-chronological),
 * replacing the `No progress yet.` placeholder if present. Frontmatter `entryCount`
 * is incremented and `updated` bumped; `assignment` and `generated` are preserved
 * verbatim (we edit the raw frontmatter rather than round-tripping through a parser
 * that would drop `generated`).
 */
export function appendProgressEntry(content: string, entry: string, now: string): string {
  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---\n?)([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error('progress.md has no YAML frontmatter.');
  }
  const [, open, fmBody, close, body] = fmMatch;

  // Bump entryCount (default 0 → 1) and updated; preserve everything else.
  let newFm = fmBody;
  const countMatch = newFm.match(/^entryCount:\s*(\d+)\s*$/m);
  const nextCount = countMatch ? parseInt(countMatch[1], 10) + 1 : 1;
  if (countMatch) {
    newFm = newFm.replace(/^entryCount:\s*\d+\s*$/m, `entryCount: ${nextCount}`);
  } else {
    newFm = `${newFm}\nentryCount: ${nextCount}`;
  }
  if (/^updated:\s*.*$/m.test(newFm)) {
    newFm = newFm.replace(/^updated:\s*.*$/m, `updated: "${now}"`);
  } else {
    newFm = `${newFm}\nupdated: "${now}"`;
  }

  const entryBlock = formatProgressEntry(entry, now);

  // Body handling: drop the placeholder, then insert the new entry right after the
  // `# Progress` H1 so newest is first.
  let newBody = body.replace(/\n?No progress yet\.\s*\n?/, '\n');
  const h1 = newBody.match(/^#\sProgress\s*$/m);
  if (h1) {
    const idx = newBody.indexOf(h1[0]) + h1[0].length;
    const before = newBody.slice(0, idx).replace(/\s*$/, '');
    const after = newBody.slice(idx).replace(/^\s*/, '');
    newBody = `${before}\n\n${entryBlock}${after.length > 0 ? `\n${after}` : ''}`;
  } else {
    newBody = `# Progress\n\n${entryBlock}${newBody.trim().length > 0 ? `\n${newBody.trim()}\n` : ''}`;
  }
  if (!newBody.endsWith('\n')) newBody += '\n';

  return `${open}${newFm}${close.startsWith('\n') ? close : `\n${close}`}${newBody}`;
}

export async function runProgressLog(
  text: string,
  options: { assignment?: string; project?: string },
  cwd: string = process.cwd(),
): Promise<string> {
  if (!text || text.trim().length === 0) {
    throw new Error('Provide the progress text: `syntaur progress log "<text>"`.');
  }
  const { dir, slug } = await resolveAssignmentDir({
    assignment: options.assignment,
    project: options.project,
    cwd,
  });
  const path = resolve(dir, 'progress.md');
  const now = nowTimestamp();

  const content = (await fileExists(path))
    ? await readFile(path, 'utf-8')
    : renderProgress({ assignment: slug, timestamp: now });

  const next = appendProgressEntry(content, text, now);
  await writeFile(path, next, 'utf-8');
  return path;
}

export const progressCommand = new Command('progress').description(
  'Record progress on the active assignment',
);

progressCommand
  .command('log')
  .description("Append a timestamped entry to the assignment's progress.md")
  .argument('<text>', 'Progress entry text')
  .option('--assignment <slug>', 'Assignment slug (UUID for standalone). Defaults to .syntaur/context.json')
  .option('--project <slug>', 'Project slug. Required with --assignment for a project-nested assignment')
  .action(async (text: string, options: { assignment?: string; project?: string }) => {
    try {
      const path = await runProgressLog(text, options);
      console.log(`Logged progress to ${path}`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
