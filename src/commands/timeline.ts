import { Command } from 'commander';
import { resolveAssignmentTarget } from '../utils/assignment-target.js';
import { initEventsDb, listEventsByAssignment, type EventRow } from '../db/events-db.js';

/** Parsed `syntaur timeline` options (commander populates these from the flags). */
export interface TimelineOptions {
  project?: string;
  json?: boolean;
  since?: string;
  /** Comma-split list of event types (e.g. `status-change,plan-approval`). */
  type?: string[];
  /** Max rows returned (default 50). */
  limit?: number;
}

const DEFAULT_LIMIT = 50;

/** A timeline event with `details` parsed back into an object (JSON branch). */
export interface TimelineEvent extends Omit<EventRow, 'details'> {
  details: unknown;
}

/**
 * Resolve the assignment (`--project <slug> + <slug>`, or a bare standalone
 * UUID), open the events DB, and return its events newest-first with the
 * requested filters applied. `details` is parsed from its stored JSON string
 * into an object per event (best-effort — malformed JSON falls back to the raw
 * string).
 */
export async function runTimeline(
  assignment: string,
  options: TimelineOptions = {},
): Promise<TimelineEvent[]> {
  const resolved = await resolveAssignmentTarget(assignment, { project: options.project });

  initEventsDb();
  const rows = listEventsByAssignment(resolved.id, {
    since: options.since,
    types: options.type,
    limit: options.limit ?? DEFAULT_LIMIT,
  });

  return rows.map((row) => ({ ...row, details: parseDetails(row.details) }));
}

/** Parse a stored `details` JSON string into an object; fall back to the raw value. */
function parseDetails(details: string | null): unknown {
  if (details === null) return null;
  try {
    return JSON.parse(details);
  } catch {
    return details;
  }
}

function parseLimit(raw: string): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`Invalid --limit value: "${raw}". Must be a positive integer.`);
  }
  return n;
}

/**
 * One-line summary of an event for the table view. `status-change` renders
 * `from → to`; everything else renders a compact gist of `details` (key=value
 * pairs), or the bare type when there are no details.
 */
function summarize(event: TimelineEvent): string {
  const d = event.details;
  if (event.type === 'status-change' && d && typeof d === 'object') {
    const obj = d as Record<string, unknown>;
    const from = obj.from == null ? '∅' : String(obj.from);
    const to = obj.to == null ? '∅' : String(obj.to);
    return `${from} → ${to}`;
  }
  if (d && typeof d === 'object') {
    const pairs = Object.entries(d as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${String(v)}`);
    return pairs.join(' ');
  }
  if (typeof d === 'string') return d;
  return '';
}

function pad(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width);
  return value + ' '.repeat(width - value.length);
}

function renderTable(events: TimelineEvent[]): string {
  if (events.length === 0) return 'No events.';
  const rows: string[][] = events.map((e) => [
    e.at,
    e.actor,
    e.type,
    summarize(e),
  ]);
  const header = ['AT', 'ACTOR', 'TYPE', 'SUMMARY'];
  const all = [header, ...rows];
  // Cap fixed-width cols; let the trailing SUMMARY run free.
  const widths = header.map((_, c) => {
    if (c === header.length - 1) return 0;
    return Math.min(40, Math.max(...all.map((row) => row[c]?.length ?? 0)));
  });
  return all
    .map((row) =>
      row
        .map((cell, c) => (c === header.length - 1 ? (cell ?? '') : pad(cell ?? '', widths[c])))
        .join('  '),
    )
    .join('\n');
}

export const timelineCommand = new Command('timeline')
  .description(
    'Show the chronological event log (who changed what, when, from→to) for one assignment, newest-first.',
  )
  .argument('<assignment>', 'Assignment slug (with --project) or standalone UUID')
  .option('--project <slug>', 'Project slug the assignment belongs to')
  .option('--since <date>', 'Only events at or after this UTC ISO timestamp (at >= since)')
  .option(
    '--type <list>',
    'Comma-separated event-type filter (e.g. status-change,plan-approval)',
    (v) => v.split(',').map((s) => s.trim()).filter(Boolean),
  )
  .option('--limit <n>', 'Maximum number of events to show (default 50)', parseLimit)
  .option('--json', 'Emit JSON instead of a table')
  .action(async (assignment: string, options: TimelineOptions) => {
    try {
      const events = await runTimeline(assignment, options);
      if (options.json) {
        console.log(JSON.stringify(events, null, 2));
      } else {
        console.log(renderTable(events));
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
