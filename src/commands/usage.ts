import { Command, Option } from 'commander';
import {
  initUsageDb,
  listDaily,
  type ListDailyFilter,
} from '../db/usage-db.js';
import { initSessionDb } from '../dashboard/session-db.js';
import { collectUsage, type CollectInfo } from '../usage/collect.js';
import { runRollup } from '../usage/rollup-runner.js';

interface UsageCommandOptions {
  since?: string;
  until?: string;
  project?: string;
  ticket?: string;
  json?: boolean;
  /** Test override: skip ccusage entirely, render from existing DB only. */
  skipCollect?: boolean;
}

export const usageCommand = new Command('usage')
  .description('Show token usage rolled up by project/ticket')
  .option('--since <iso>', 'restrict report to events on or after this ISO date')
  .option('--until <iso>', 'restrict report to events on or before this ISO date')
  .option('--project <slug>', 'restrict to one project slug')
  .option('--ticket <slug>', 'restrict to one ticket slug')
  .option('--json', 'emit JSON instead of a human-readable table')
  // Internal: skip ccusage ingest. Hidden from --help.
  .addOption(
    new Option('--skip-collect', 'internal: skip ccusage ingest')
      .hideHelp()
      .default(false),
  )
  .action(async (options: UsageCommandOptions) => {
    try {
      await runUsage(options);
    } catch (e) {
      console.error(
        'Error running `syntaur usage`:',
        e instanceof Error ? e.message : String(e),
      );
      process.exit(1);
    }
  });

export async function runUsage(options: UsageCommandOptions): Promise<void> {
  initSessionDb();
  initUsageDb();

  let collectInfo: CollectInfo | null = null;
  if (!options.skipCollect) {
    collectInfo = await collectUsage();
  } else {
    runRollup();
  }

  const filter: ListDailyFilter = {};
  if (options.since) filter.since = options.since.slice(0, 10);
  if (options.until) filter.until = options.until.slice(0, 10);
  if (options.project !== undefined) filter.projectSlug = options.project;
  if (options.ticket !== undefined) filter.ticketSlug = options.ticket;

  const rows = listDaily(filter);
  const grouped = groupByProjectTicket(rows);

  if (options.json) {
    console.log(JSON.stringify({ daily: rows, summary: grouped }, null, 2));
    return;
  }

  if (collectInfo?.isFirstRun) {
    console.log(
      '(first run: ingested last 30 days only — older history is not backfilled. Re-run `syntaur usage` regularly to capture closed sessions before ccusage logs rotate.)',
    );
  }

  renderTable(grouped);
}

interface GroupedRow {
  projectSlug: string;
  ticketSlug: string;
  totalTokens: number;
  totalCost: number;
  lastEventDay: string;
}

function groupByProjectTicket(
  rows: ReturnType<typeof listDaily>,
): GroupedRow[] {
  const map = new Map<string, GroupedRow>();
  for (const r of rows) {
    const key = `${r.project_slug}\x00${r.ticket_id}`;
    const existing = map.get(key);
    if (existing) {
      existing.totalTokens += r.total_tokens;
      existing.totalCost += r.total_cost;
      if (r.day > existing.lastEventDay) existing.lastEventDay = r.day;
    } else {
      map.set(key, {
        projectSlug: r.project_slug,
        ticketSlug: r.ticket_id,
        totalTokens: r.total_tokens,
        totalCost: r.total_cost,
        lastEventDay: r.day,
      });
    }
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

function renderTable(rows: GroupedRow[]): void {
  if (rows.length === 0) {
    console.log('No usage data. Run `syntaur usage` after ccusage has collected some sessions.');
    return;
  }

  const headers = ['Project', 'Ticket', 'Tokens', 'Cost (USD)', 'Last event'];
  const data = rows.map((r) => [
    r.projectSlug || '(unattributed)',
    r.ticketSlug || '(unattributed)',
    r.totalTokens.toLocaleString('en-US'),
    `$${r.totalCost.toFixed(4)}`,
    r.lastEventDay,
  ]);

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i].length)),
  );

  const pad = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join('  ');

  console.log(pad(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of data) console.log(pad(row));
}
