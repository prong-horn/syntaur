import { Command } from 'commander';
import { readConfig, DEFAULT_DERIVE_CONFIG } from '../utils/config.js';
import { assignmentsDir as getAssignmentsDir } from '../utils/paths.js';
import { getStatusConfig } from '../dashboard/api.js';
import {
  computeInbox,
  INBOX_CATEGORIES,
  type InboxCategory,
  type InboxItem,
  type InboxResult,
  type InboxStatusConfig,
} from '../inbox/index.js';

/** Parsed `syntaur inbox` options (commander populates these from the flags). */
export interface InboxOptions {
  project?: string;
  /** Comma-split category list, validated against `INBOX_CATEGORIES`. */
  type?: string;
  limit?: string;
  json?: boolean;
}

/**
 * Run the inbox aggregation against the CONFIGURED content dirs and the resolved
 * lifecycle status-config.
 *
 * Dir resolution mirrors `search.ts` (the mandatory audit-#8 pattern):
 * `readConfig().defaultProjectDir` + `getAssignmentsDir()` — never the hardcoded
 * `defaultProjectDir()` path helper — so the CLI scans the same tree the
 * dashboard displays.
 *
 * Status-config resolution: we reuse `getStatusConfig()` from `src/dashboard/api.ts`
 * — the SAME loader the dashboard's `getAvailableTransitions` and the lifecycle
 * routes wrap, and the canonical source for accept/reopen verb derivation under
 * custom status configs. It is import-safe: `api.ts` is a pure data/logic module
 * (no Express, no `app.listen`/`app.use` at module top — it only imports
 * fs/path/lifecycle/utils/parser), and existing CLI commands already import it
 * (`ls.ts` imports `listAssignmentsBoard`). Its `ResolvedStatusConfig` return is a
 * structural superset of `InboxStatusConfig` (statuses `{id,terminal?}`,
 * transitions `{from,command,to}`, `transitionTable`, `terminalStatuses`), so it
 * is assignable directly. A lifecycle-level `resolveDeriveContext` exists but does
 * NOT expose the transition table the accept-verb derivation needs, so it would
 * not suffice here.
 */
export async function runInbox(options: InboxOptions): Promise<InboxResult> {
  const config = await readConfig();
  const projectsDir = config.defaultProjectDir;
  const assignmentsDir = getAssignmentsDir();

  const limit = parseLimit(options.limit);
  // Parse `--type` INSIDE the command's error path (not as a Commander coercion)
  // so an unknown category yields a clean one-line error, not an uncaught stack.
  const types = parseTypes(options.type);

  const resolved = await getStatusConfig();
  // The blocked/parked HEADLINE status ids are NOT valid active "reopen" targets.
  // `derive` is null when the user has no custom derive rules → DEFAULT_DERIVE_CONFIG.
  const headline = (resolved.derive ?? DEFAULT_DERIVE_CONFIG).headline;
  const blockedParkedStatuses = new Set([headline.blocked, headline.parked].filter(Boolean));
  const statusConfig: InboxStatusConfig = { ...resolved, blockedParkedStatuses };

  return computeInbox({
    projectsDir,
    assignmentsDir,
    project: options.project,
    types,
    limit,
    statusConfig,
  });
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`Invalid --limit value: "${raw}". Must be a positive integer.`);
  }
  return n;
}

/** Comma-split `--type` into validated `InboxCategory[]` (clean error on unknowns). */
function parseTypes(raw: string | undefined): InboxCategory[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  const known = new Set<string>(INBOX_CATEGORIES);
  const unknown = parts.filter((p) => !known.has(p));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown --type categor${unknown.length > 1 ? 'ies' : 'y'}: ${unknown
        .map((u) => `"${u}"`)
        .join(', ')}. Valid: ${INBOX_CATEGORIES.join(', ')}.`,
    );
  }
  return parts as InboxCategory[];
}

/** Human-readable label per category for the section headers. */
const CATEGORY_LABEL: Record<InboxCategory, string> = {
  review: 'review',
  blocked: 'blocked',
  question: 'question',
  'plan-approval': 'plan-approval',
};

/** Humanize a millisecond age into a compact `2d`/`3h`/`5m`/`just now` form. */
function humanizeAge(ageMs: number): string {
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return sec <= 0 ? 'just now' : `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  return `${wk}w ago`;
}

/** `project/slug` for project assignments; the standalone UUID otherwise. */
function locator(item: InboxItem): string {
  if (item.project === null) return item.assignmentId;
  return `${item.project}/${item.assignmentSlug}`;
}

/** Render the at-a-glance header: total + per-category counts. */
function renderHeader(result: InboxResult): string {
  if (result.total === 0) return 'Nothing needs you.';
  const noun = result.total === 1 ? 'item needs' : 'items need';
  const counts = INBOX_CATEGORIES.filter((c) => result.counts[c] > 0)
    .map((c) => `${CATEGORY_LABEL[c]} ${result.counts[c]}`)
    .join('  ');
  return `${result.total} ${noun} you  ·  ${counts}`;
}

/**
 * Render the grouped, oldest-first human view. Items arrive from `computeInbox`
 * already grouped in canonical category order and ordered most-urgent (largest
 * `ageMs`) first within each group. The CLI only PRINTS `action.command` — it
 * never mutates.
 */
function renderHuman(result: InboxResult): string {
  const lines: string[] = [renderHeader(result)];
  if (result.total === 0) return lines.join('\n');

  for (const category of INBOX_CATEGORIES) {
    const items = result.items.filter((i) => i.category === category);
    if (items.length === 0) continue;
    lines.push('');
    lines.push(`${CATEGORY_LABEL[category]} (${result.counts[category]})`);
    for (const item of items) {
      lines.push(`  ${item.title}  [${locator(item)}]  ${humanizeAge(item.ageMs)}`);
      if (item.summary) lines.push(`    ${item.summary}`);
      lines.push(`    → ${item.action.command}`);
    }
  }
  return lines.join('\n');
}

export const inboxCommand = new Command('inbox')
  .description(
    'One triage view of everything awaiting a human: assignments in review, blocked, with an unanswered question, or with a plan awaiting approval. Read-only — prints the exact action command for each item; never mutates.',
  )
  .option('--project <slug>', 'Restrict to one project')
  .option(
    '--type <list>',
    `Comma-separated category filter (${INBOX_CATEGORIES.join(', ')})`,
  )
  .option('--limit <n>', 'Maximum number of items to show')
  .option('--json', 'Emit the structured InboxResult JSON instead of the grouped view')
  .action(async (options: InboxOptions) => {
    try {
      const result = await runInbox(options);
      if (options.json) {
        // `counts` is a Record and every item field is JSON-safe (no Map), so
        // the InboxResult serializes directly.
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(renderHuman(result));
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
