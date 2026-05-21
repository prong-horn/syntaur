import { Command, Option } from 'commander';
import {
  initUsageDb,
  upsertEvent,
  listDaily,
  getMeta,
  advanceMetaIso,
  getUsageDb,
  type UsageEventInput,
  type ListDailyFilter,
} from '../db/usage-db.js';
import { initSessionDb } from '../dashboard/session-db.js';
import { runCcusage, isoToCcusageDate } from '../usage/ccusage-collector.js';
import {
  walkClaudeProjects,
  walkCodexSessions,
  type SessionMeta,
} from '../usage/cwd-extractor.js';
import { resolveAttribution } from '../usage/session-join.js';
import { runRollup } from '../usage/rollup-runner.js';

interface UsageCommandOptions {
  since?: string;
  until?: string;
  project?: string;
  assignment?: string;
  json?: boolean;
  /** Test override: skip ccusage entirely, render from existing DB only. */
  skipCollect?: boolean;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const usageCommand = new Command('usage')
  .description('Show token usage rolled up by project/assignment')
  .option('--since <iso>', 'restrict report to events on or after this ISO date')
  .option('--until <iso>', 'restrict report to events on or before this ISO date')
  .option('--project <slug>', 'restrict to one project slug')
  .option('--assignment <slug>', 'restrict to one assignment slug')
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
    collectInfo = await collectAndPersist();
  }

  runRollup();

  const filter: ListDailyFilter = {};
  if (options.since) filter.since = options.since.slice(0, 10);
  if (options.until) filter.until = options.until.slice(0, 10);
  if (options.project !== undefined) filter.projectSlug = options.project;
  if (options.assignment !== undefined) filter.assignmentSlug = options.assignment;

  const rows = listDaily(filter);
  const grouped = groupByProjectAssignment(rows);

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

interface CollectInfo {
  isFirstRun: boolean;
  rowsIngested: number;
}

interface GroupedRow {
  projectSlug: string;
  assignmentSlug: string;
  totalTokens: number;
  totalCost: number;
  lastEventDay: string;
}

function groupByProjectAssignment(
  rows: ReturnType<typeof listDaily>,
): GroupedRow[] {
  const map = new Map<string, GroupedRow>();
  for (const r of rows) {
    const key = `${r.project_slug}\x00${r.assignment_slug}`;
    const existing = map.get(key);
    if (existing) {
      existing.totalTokens += r.total_tokens;
      existing.totalCost += r.total_cost;
      if (r.day > existing.lastEventDay) existing.lastEventDay = r.day;
    } else {
      map.set(key, {
        projectSlug: r.project_slug,
        assignmentSlug: r.assignment_slug,
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

  const headers = ['Project', 'Assignment', 'Tokens', 'Cost (USD)', 'Last event'];
  const data = rows.map((r) => [
    r.projectSlug || '(unattributed)',
    r.assignmentSlug || '(unattributed)',
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

async function collectAndPersist(): Promise<CollectInfo> {
  const lastRunIso = getMeta('usage_last_collector_run');
  const isFirstRun = lastRunIso === null;
  const sinceIso = lastRunIso
    ? lastRunIso
    : new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
  const sinceDate = isoToCcusageDate(sinceIso);

  const result = await runCcusage({ sinceDate });
  if (!result || result.rows.length === 0) {
    // No new data — leave existing DB alone, leave `last_run` unchanged so a
    // future run can re-cover this window.
    return { isFirstRun, rowsIngested: 0 };
  }

  // Use the UTC-day start corresponding to `sinceDate` for the mtime cutoff,
  // not `lastRunIso` exact wall time. This keeps the cwd-walk window aligned
  // with ccusage's day-granular `--since` filter so a same-day re-collect
  // doesn't skip session files whose mtime predates the last run's exact
  // moment but is still within the day ccusage will report (codex-review
  // CRITICAL on attribution erasure).
  const sinceMtimeMs = new Date(`${formatDayFromCcusageDate(sinceDate)}T00:00:00.000Z`).getTime();

  // Build a sessionId → SessionMeta map from the cwd walkers.
  const metaBySession = new Map<string, SessionMeta>();
  for await (const meta of walkClaudeProjects({ sinceMtimeMs })) {
    metaBySession.set(meta.sessionId, meta);
  }
  for await (const meta of walkCodexSessions({ sinceMtimeMs })) {
    metaBySession.set(meta.sessionId, meta);
  }

  // Enrich rows with cwd + attribution.
  const enriched: UsageEventInput[] = result.rows.map((row) => {
    const sessionMeta = metaBySession.get(row.sessionId);
    const cwd = sessionMeta?.cwd ?? null;
    const attr = resolveAttribution({
      sessionId: row.sessionId,
      cwd,
      eventTs: row.eventTs,
    });
    return {
      sessionId: row.sessionId,
      model: row.model,
      tool: row.tool,
      eventTs: row.eventTs,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheCreationTokens: row.cacheCreationTokens,
      cacheReadTokens: row.cacheReadTokens,
      totalTokens: row.totalTokens,
      totalCost: row.totalCost,
      cwd,
      projectSlug: attr.projectSlug ?? '',
      assignmentSlug: attr.assignmentSlug ?? '',
      rawJson: row.rawJson,
    };
  });

  // Persist atomically: all events + last_run advance in one transaction.
  // `advanceMetaIso` is monotonic — an older snapshot can't regress the
  // high-water mark even if two collectors race.
  const db = getUsageDb();
  const tx = db.transaction(() => {
    for (const row of enriched) upsertEvent(row);
    if (result.highWaterMark) {
      advanceMetaIso('usage_last_collector_run', result.highWaterMark);
    }
  });
  tx.immediate();

  return { isFirstRun, rowsIngested: enriched.length };
}

/** Convert `YYYYMMDD` back to `YYYY-MM-DD` for ISO construction. */
function formatDayFromCcusageDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}
