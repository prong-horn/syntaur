import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { listAssignmentsBoard } from '../dashboard/api.js';
import { defaultProjectDir, assignmentsDir as standaloneAssignmentsDir } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';
import type { AssignmentBoardItem } from '../dashboard/types.js';

interface LsOptions {
  status?: string;
  project?: string;
  tag?: string;
  age?: string;
  json?: boolean;
}

const AGE_PATTERN = /^(\d+)([dhwm])$/i;

function parseAgeToCutoff(age: string): Date {
  const match = age.match(AGE_PATTERN);
  if (!match) {
    throw new Error(
      `Invalid --age value: "${age}". Use formats like 7d, 24h, 2w, 1m.`,
    );
  }
  const n = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const ms =
    unit === 'h'
      ? n * 60 * 60 * 1000
      : unit === 'd'
        ? n * 24 * 60 * 60 * 1000
        : unit === 'w'
          ? n * 7 * 24 * 60 * 60 * 1000
          : /* m: months ≈ 30 days */ n * 30 * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms);
}

function assignmentMdPath(item: AssignmentBoardItem): string {
  if (item.projectSlug) {
    return resolve(
      defaultProjectDir(),
      item.projectSlug,
      'assignments',
      item.slug,
      'assignment.md',
    );
  }
  return resolve(standaloneAssignmentsDir(), item.id, 'assignment.md');
}

async function loadTags(item: AssignmentBoardItem): Promise<string[]> {
  const path = assignmentMdPath(item);
  if (!(await fileExists(path))) return [];
  try {
    const content = await readFile(path, 'utf-8');
    return parseAssignmentFrontmatter(content).tags;
  } catch {
    return [];
  }
}

export async function runLs(
  options: LsOptions,
): Promise<{ items: AssignmentBoardItem[] }> {
  const board = await listAssignmentsBoard(
    defaultProjectDir(),
    standaloneAssignmentsDir(),
  );
  let items = board.assignments;

  if (options.status) {
    const statuses = options.status.split(',').map((s) => s.trim()).filter(Boolean);
    items = items.filter((a) => statuses.includes(a.status));
  }
  if (options.project) {
    items = items.filter((a) => a.projectSlug === options.project);
  }
  if (options.age) {
    const cutoff = parseAgeToCutoff(options.age);
    items = items.filter((a) => {
      const updatedTs = Date.parse(a.updated);
      return Number.isFinite(updatedTs) && updatedTs >= cutoff.getTime();
    });
  }
  if (options.tag) {
    const wanted = options.tag.split(',').map((s) => s.trim()).filter(Boolean);
    const tagged = await Promise.all(
      items.map(async (a) => {
        const tags = await loadTags(a);
        return { item: a, tags };
      }),
    );
    items = tagged
      .filter(({ tags }) => wanted.every((t) => tags.includes(t)))
      .map(({ item }) => item);
  }

  return { items };
}

function pad(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width);
  return value + ' '.repeat(width - value.length);
}

function renderTable(items: AssignmentBoardItem[]): string {
  if (items.length === 0) return 'No assignments matched.';
  const rows: string[][] = items.map((a) => [
    a.projectSlug ?? '(standalone)',
    a.slug,
    a.status,
    a.priority,
    a.assignee ?? '—',
    a.updated.slice(0, 10),
    a.title,
  ]);
  const header = ['PROJECT', 'SLUG', 'STATUS', 'PRIORITY', 'ASSIGNEE', 'UPDATED', 'TITLE'];
  const all = [header, ...rows];
  const widths = header.map((_, c) =>
    Math.min(60, Math.max(...all.map((row) => row[c]?.length ?? 0))),
  );
  return all
    .map((row) => row.map((cell, c) => pad(cell ?? '', widths[c])).join('  '))
    .join('\n');
}

export const lsCommand = new Command('ls')
  .description(
    'List assignments across all projects with optional filters by status, project, tag, or age.',
  )
  .option('--status <list>', 'Comma-separated status filter (e.g. pending,in_progress)')
  .option('--project <slug>', 'Filter to one project')
  .option('--tag <list>', 'Comma-separated tag filter (assignment must have ALL tags)')
  .option('--age <duration>', 'Only include assignments updated within duration (e.g. 7d, 24h, 2w, 1m)')
  .option('--json', 'Emit JSON instead of a table')
  .action(async (options: LsOptions) => {
    try {
      const { items } = await runLs(options);
      if (options.json) {
        console.log(JSON.stringify({ assignments: items }, null, 2));
      } else {
        console.log(renderTable(items));
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
