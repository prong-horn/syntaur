import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { listTicketsBoard } from '../dashboard/api.js';
import { defaultProjectDir } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import { buildQueryRegistry } from '../utils/query/registry.js';
import { compileQuery, type QueryItem } from '../utils/query/index.js';
import { isTerminalStageId } from '../dashboard/stage-config.js';
import type { TicketBoardItem } from '../dashboard/types.js';

interface LsOptions {
  status?: string;
  project?: string;
  tag?: string;
  age?: string;
  query?: string;
  json?: boolean;
  archived?: boolean;
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

function ticketMdPath(item: TicketBoardItem): string {
  if (!item.projectSlug) {
    throw new Error(`Ticket "${item.id}" has no project; expected a project-nested ticket.`);
  }
  return resolve(
    defaultProjectDir(),
    item.projectSlug,
    'tickets',
    item.slug,
    'ticket.md',
  );
}

async function loadTags(item: TicketBoardItem): Promise<string[]> {
  const path = ticketMdPath(item);
  if (!(await fileExists(path))) return [];
  try {
    const content = await readFile(path, 'utf-8');
    return parseTicketFrontmatter(content).tags;
  } catch {
    return [];
  }
}

export async function runLs(
  options: LsOptions,
): Promise<{ items: TicketBoardItem[] }> {
  const board = await listTicketsBoard(
    defaultProjectDir(),
    { archived: options.archived ? 'only' : 'exclude' },
  );
  let items = board.tickets;

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

  if (options.query) {
    const { query, errors, warnings } = compileQuery(options.query, buildQueryRegistry());
    if (!query) {
      throw new Error(
        `Invalid --query:\n${errors.map((e) => `  at ${e.pos}: ${e.message}`).join('\n')}`,
      );
    }
    for (const w of warnings) {
      console.error(`Warning: at ${w.pos}: ${w.message}`);
    }
    const now = Date.now();
    const enriched = await Promise.all(
      items.map(async (item) => ({
        item,
        q: await loadQueryItem(item, now),
      })),
    );
    items = enriched.filter(({ q }) => q !== null && query.predicate(q, { now })).map(({ item }) => item);
  }

  return { items };
}

/**
 * Materialize the full AQL item (frontmatter fields + facts + history
 * virtuals) for one board row. CLI-scale (hundreds of tickets) — full
 * loads are fine; the dashboard ships the same shape in payloads instead.
 */
async function loadQueryItem(
  item: TicketBoardItem,
  now: number,
): Promise<QueryItem | null> {
  const path = ticketMdPath(item);
  if (!(await fileExists(path))) return null;
  try {
    const content = await readFile(path, 'utf-8');
    const fm = parseTicketFrontmatter(content);
    const updatedMs = Date.parse(fm.updated);
    const statusAge = Number.isNaN(updatedMs) ? null : now - updatedMs;
    const completedAt =
      isTerminalStageId(fm.status) && fm.status === 'done' && !Number.isNaN(updatedMs)
        ? fm.updated
        : null;

    return {
      status: fm.status,
      priority: fm.priority,
      template: fm.template,
      assignee: fm.assignee,
      project: item.projectSlug,
      tags: fm.tags,
      archived: fm.archived,
      title: fm.title,
      created: fm.created,
      updated: fm.updated,
      completedAt,
      statusAge,
      phaseAge: statusAge,
      blocked: Boolean(fm.blocked),
      parked: Boolean(fm.parked),
      searchText: `${item.title ?? ''} ${item.slug ?? ''} ${item.id ?? ''} ${item.projectTitle ?? ''} ${item.projectSlug ?? ''}`,
    };
  } catch {
    return null;
  }
}

function pad(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width);
  return value + ' '.repeat(width - value.length);
}

function renderTable(items: TicketBoardItem[]): string {
  if (items.length === 0) return 'No tickets matched.';
  const rows: string[][] = items.map((a) => [
    a.projectSlug ?? '—',
    a.id,
    a.slug,
    a.status,
    a.priority,
    a.assignee ?? '—',
    a.updated.slice(0, 10),
    a.title,
  ]);
  const header = ['PROJECT', 'ID', 'SLUG', 'STATUS', 'PRIORITY', 'ASSIGNEE', 'UPDATED', 'TITLE'];
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
    'List tickets across all projects with optional filters by status, project, tag, or age.',
  )
  .option('--status <list>', 'Comma-separated status filter (e.g. pending,in_progress)')
  .option('--project <slug>', 'Filter to one project')
  .option('--tag <list>', 'Comma-separated tag filter (ticket must have ALL tags)')
  .option('--age <duration>', 'Only include tickets updated within duration (e.g. 7d, 24h, 2w, 1m)')
  .option(
    '--query <expr>',
    'AQL boolean filter over fields + facts (e.g. "disposition:blocked AND phase:ready_to_implement", "planApproved:true AND workspaceSet:false", "phase:planning AND statusAge > 3d")',
  )
  .option('--archived', 'List only archived tickets (hidden from the default view)')
  .option('--json', 'Emit JSON instead of a table')
  .action(async (options: LsOptions) => {
    try {
      const { items } = await runLs(options);
      if (options.json) {
        console.log(JSON.stringify({ tickets: items }, null, 2));
      } else {
        console.log(renderTable(items));
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
