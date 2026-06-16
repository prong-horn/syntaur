import { Command } from 'commander';
import { readConfig } from '../utils/config.js';
import { assignmentsDir as getAssignmentsDir } from '../utils/paths.js';
import {
  getIndex,
  resolveProvider,
  parseFileKinds,
  type FileKind,
  type SearchHit,
  type MatchRange,
} from '../search/index.js';

/** Parsed `syntaur search` options (commander populates these from the flags). */
export interface SearchOptions {
  project?: string;
  type?: string[];
  status?: string[];
  in?: FileKind[];
  all?: boolean;
  limit?: string;
  semantic?: boolean;
  json?: boolean;
}

/** The JSON-contract shape emitted by `--json` (acceptance-criteria field names). */
interface JsonHit {
  path: string;
  project: string | null;
  assignment: string | null;
  fileKind: FileKind;
  score: number;
  snippet: string;
  line: number;
  section?: string;
  route: string;
}

const DEFAULT_LIMIT = 20;

/**
 * Resolve the CONFIGURED content dirs (mirrors `dashboard.ts`), build/get the
 * cached index, run the resolved provider, and return typed hits. Dirs are
 * resolved from `readConfig().defaultProjectDir` + `getAssignmentsDir()` — never
 * the hardcoded `defaultProjectDir()` path helper — so a CLI search indexes the
 * same tree the dashboard displays.
 */
export async function runSearch(query: string, options: SearchOptions): Promise<SearchHit[]> {
  const config = await readConfig();
  const projectsDir = config.defaultProjectDir;
  const assignmentsDir = getAssignmentsDir();

  const limit = parseLimit(options.limit);

  const docs = await getIndex({
    projectsDir,
    assignmentsDir,
    includeArchived: options.all,
  });

  const provider = resolveProvider({ semantic: options.semantic });
  await provider.index(docs);

  const hits = await provider.query(
    {
      query,
      project: options.project,
      type: options.type,
      status: options.status,
      in: options.in,
    },
    limit,
  );
  return hits;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`Invalid --limit value: "${raw}". Must be a positive integer.`);
  }
  return n;
}

/** Map an internal `SearchHit` to the AC JSON contract (`projectSlug`→`project`). */
function toJsonHit(hit: SearchHit): JsonHit {
  const json: JsonHit = {
    path: hit.path,
    project: hit.projectSlug,
    assignment: hit.assignmentSlug,
    fileKind: hit.fileKind,
    score: hit.score,
    snippet: hit.snippet,
    line: hit.line,
    route: hit.route,
  };
  if (hit.section !== undefined) json.section = hit.section;
  return json;
}

/**
 * Wrap each match range in `**…**`. Apply ranges from the LAST backward so
 * earlier offsets don't shift as we insert markers.
 */
function highlight(snippet: string, matches: MatchRange[]): string {
  let out = snippet;
  const ordered = [...matches].sort((a, b) => b.start - a.start);
  for (const { start, end } of ordered) {
    if (end <= start || start < 0 || end > out.length) continue;
    out = `${out.slice(0, start)}**${out.slice(start, end)}**${out.slice(end)}`;
  }
  return out;
}

function pad(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width);
  return value + ' '.repeat(width - value.length);
}

function sourceLabel(hit: SearchHit): string {
  return hit.section ? `${hit.fileKind} › ${hit.section}` : hit.fileKind;
}

function renderTable(hits: SearchHit[]): string {
  if (hits.length === 0) return 'No matches.';
  const rows: string[][] = hits.map((hit) => [
    hit.projectSlug ?? '(standalone)',
    hit.assignmentSlug ?? hit.itemSlug ?? '—',
    sourceLabel(hit),
    highlight(hit.snippet, hit.matches).replace(/\s*\n\s*/g, ' ').trim(),
  ]);
  const header = ['PROJECT', 'ASSIGNMENT', 'SOURCE', 'SNIPPET'];
  // Highlight markers inflate the snippet width; cap non-snippet cols only.
  const widths = header.map((_, c) => {
    if (c === header.length - 1) return 0; // snippet — never padded/truncated
    const all = [header, ...rows];
    return Math.min(40, Math.max(...all.map((row) => row[c]?.length ?? 0)));
  });
  const all = [header, ...rows];
  return all
    .map((row) =>
      row
        .map((cell, c) => (c === header.length - 1 ? (cell ?? '') : pad(cell ?? '', widths[c])))
        .join('  '),
    )
    .join('\n');
}

export const searchCommand = new Command('search')
  .description(
    'Full-text search across all Syntaur markdown content (assignments, plans, progress, comments, handoffs, decision records, scratchpads, project memories + resources).',
  )
  .argument('<query>', 'Search query')
  .option('--project <slug>', 'Restrict to one project')
  .option('--type <list>', 'Comma-separated assignment type filter', (v) => v.split(',').map((s) => s.trim()).filter(Boolean))
  .option('--status <list>', 'Comma-separated assignment status filter', (v) => v.split(',').map((s) => s.trim()).filter(Boolean))
  .option(
    '--in <fileKinds>',
    'Comma-separated file-kind filter (e.g. comments,plans). Accepts singular or plural names.',
    (v) => parseFileKinds(v),
  )
  .option('--all', 'Include archived assignments/projects (excluded by default)')
  .option('--limit <n>', 'Maximum number of results', String(DEFAULT_LIMIT))
  .option('--semantic', 'Use the semantic provider when available (falls back to full-text)')
  .option('--json', 'Emit JSON instead of a table')
  .action(async (query: string, options: SearchOptions) => {
    try {
      const hits = await runSearch(query, options);
      if (options.json) {
        console.log(JSON.stringify(hits.map(toJsonHit), null, 2));
      } else {
        console.log(renderTable(hits));
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
