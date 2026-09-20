import { Command } from 'commander';
import { relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileExists } from '../utils/fs.js';
import { syntaurRoot } from '../utils/paths.js';
import { resolveTicketTarget } from '../utils/ticket-target.js';
import { resolveEngagementBinding } from '../utils/engagement-binding.js';
import { renderTimelineTable, runTimeline } from './timeline.js';

export interface HistoryOptions {
  project?: string;
  limit?: number;
  json?: boolean;
  events?: boolean;
  cwd?: string;
}

export interface HistoryEntry {
  sha: string;
  at: string;
  subject: string;
  files: string[];
}

const DEFAULT_LIMIT = 50;

export function parseLimit(raw: string): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`Invalid --limit value: "${raw}". Must be a positive integer.`);
  }
  return n;
}

export function parseGitLog(stdout: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  let current: HistoryEntry | null = null;

  for (const line of stdout.split('\n')) {
    if (line.includes('\x1f')) {
      if (current) entries.push(current);
      const parts = line.split('\x1f');
      const sha = parts[0] ?? '';
      const at = parts[1] ?? '';
      const subject = parts.slice(2).join('\x1f');
      current = { sha, at, subject, files: [] };
      continue;
    }
    if (line.trim() === '') {
      if (current && current.files.length > 0) {
        entries.push(current);
        current = null;
      }
      continue;
    }
    if (current) current.files.push(line);
  }
  if (current) entries.push(current);
  return entries;
}

function sha7(sha: string): string {
  return sha.slice(0, 7);
}

export function formatHistoryLine(entry: HistoryEntry): string {
  const n = entry.files.length;
  return `${entry.at}  ${sha7(entry.sha)}  ${entry.subject}  (${n} files)`;
}

export function renderHistoryText(entries: HistoryEntry[]): string {
  if (entries.length === 0) return 'No commits touch this ticket yet.';
  return entries.map(formatHistoryLine).join('\n');
}

export async function runHistory(
  ticket: string,
  options: HistoryOptions = {},
): Promise<HistoryEntry[] | string> {
  const cwd = options.cwd ?? process.cwd();
  const resolved = await resolveTicketTarget(ticket, {
    project: options.project,
    cwd,
    resolveEngagement: () => resolveEngagementBinding(cwd),
  });

  if (options.events) {
    const events = await runTimeline(ticket, {
      project: options.project,
      limit: options.limit ?? DEFAULT_LIMIT,
      cwd,
    });
    return renderTimelineTable(events);
  }

  const home = syntaurRoot();
  const gitDir = resolve(home, '.git');
  if (!(await fileExists(gitDir))) {
    throw new Error(`${home} is not a git repository — run syntaur init`);
  }

  const relPath = relative(home, resolved.ticketDir);
  const limit = options.limit ?? DEFAULT_LIMIT;
  const result = spawnSync(
    'git',
    [
      '-C',
      home,
      'log',
      `-n`,
      String(limit),
      '--format=%H%x1f%aI%x1f%s',
      '--name-only',
      '--',
      relPath,
    ],
    { encoding: 'utf-8' },
  );

  if (result.status !== 0) {
    const msg = (result.stderr ?? result.stdout ?? '').trim();
    throw new Error(msg || 'git log failed');
  }

  return parseGitLog(result.stdout ?? '');
}

export const historyCommand = new Command('history')
  .description('Show the git commit history for a ticket folder (newest first)')
  .argument('<ticket>', 'Ticket slug (with --project) or standalone UUID')
  .option('--project <slug>', 'Project slug the ticket belongs to')
  .option('--limit <n>', 'Maximum number of commits to show (default 50)', parseLimit)
  .option('--json', 'Emit JSON instead of text lines')
  .option('--events', 'Show the events table instead of git history')
  .action(async (ticket: string, options: HistoryOptions) => {
    try {
      const result = await runHistory(ticket, options);
      if (options.events) {
        console.log(result);
        return;
      }
      const entries = result as HistoryEntry[];
      if (options.json) {
        console.log(JSON.stringify(entries, null, 2));
      } else {
        console.log(renderHistoryText(entries));
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
