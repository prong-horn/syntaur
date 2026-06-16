/**
 * Tolerant runtime parser for `ccusage session --json --breakdown` output.
 *
 * Verified against ccusage 20.0.1 (capture date 2026-05-21; see
 * `src/__tests__/fixtures/ccusage-session.meta.json` for capture metadata).
 *
 * This parser is tool-agnostic: it keys off `raw.agent` to identify the tool
 * and handles any agent that ccusage reports. As of ccusage 20.0.1, ~15 agents
 * are reported, including: claude, codex, opencode, amp, droid, hermes, pi,
 * goose, kilo, copilot, gemini, kimi, qwen, openclaw, codebuff.
 *
 * Real-world quirks observed from a 477-session capture:
 *   - Top-level shape: `{ session: SessionRow[], totals: ... }`.
 *   - Session ID lives on `period`, not `sessionId`. For codex, `period` is a
 *     path-like string of the form
 *     `YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<uuid>`; the actual session
 *     UUID is the LAST hyphen-delimited block. For all other tools (claude,
 *     opencode, pi, etc.), `period` is passed through unchanged as the session
 *     id.
 *   - `agent` carries the tool name (see list above).
 *   - `metadata.lastActivity` may be:
 *       date-only YYYY-MM-DD (claude),
 *       full ISO timestamp (codex),
 *       or undefined (opencode).
 *   - `modelBreakdowns[]` is always present (the request passes `--breakdown`)
 *     and ordered. Per-model fields use `cost` (not `totalCost`) and
 *     `modelName` (not `model`).
 */

export interface ParsedCcusageRow {
  sessionId: string;
  model: string;
  tool: string;
  eventTs: string; // canonical ISO; derived from lastActivity (with fallbacks)
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  rawJson: string;
}

interface RawSessionRow {
  agent?: unknown;
  period?: unknown;
  modelBreakdowns?: unknown;
  modelsUsed?: unknown;
  metadata?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheCreationTokens?: unknown;
  cacheReadTokens?: unknown;
  totalTokens?: unknown;
  totalCost?: unknown;
}

interface RawModelBreakdown {
  modelName?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheCreationTokens?: unknown;
  cacheReadTokens?: unknown;
  cost?: unknown;
}

export interface ParseSessionResult {
  rows: ParsedCcusageRow[];
  highWaterMark: string | null;
  warnings: string[];
}

/**
 * Parse a `ccusage session --json --breakdown` payload. Tolerates additive
 * fields and per-row malformation (skips with a warning rather than throwing).
 *
 * `nowIso` is injected so callers can stamp fallback timestamps deterministically
 * in tests.
 */
export function parseCcusageSession(
  payload: unknown,
  nowIso: () => string = () => new Date().toISOString(),
): ParseSessionResult {
  const warnings: string[] = [];

  if (!payload || typeof payload !== 'object') {
    warnings.push('ccusage payload was not an object');
    return { rows: [], highWaterMark: null, warnings };
  }

  const sessions = (payload as { session?: unknown }).session;
  if (!Array.isArray(sessions)) {
    warnings.push('ccusage payload had no `session` array');
    return { rows: [], highWaterMark: null, warnings };
  }

  const rows: ParsedCcusageRow[] = [];
  let highWaterIso: string | null = null;

  for (const raw of sessions as RawSessionRow[]) {
    if (!raw || typeof raw !== 'object') {
      warnings.push('skipped non-object session row');
      continue;
    }
    const tool = typeof raw.agent === 'string' ? raw.agent : null;
    const period = typeof raw.period === 'string' ? raw.period : null;
    if (!tool || !period) {
      warnings.push('skipped session row missing agent or period');
      continue;
    }
    const sessionId = extractSessionId(tool, period);
    const breakdowns = Array.isArray(raw.modelBreakdowns)
      ? (raw.modelBreakdowns as RawModelBreakdown[])
      : [];
    const eventTs = normalizeLastActivity(
      (raw.metadata as { lastActivity?: unknown } | undefined)?.lastActivity,
      nowIso,
    );

    if (eventTs && (!highWaterIso || eventTs > highWaterIso)) {
      highWaterIso = eventTs;
    }

    if (breakdowns.length === 0) {
      // Fall back to a single synthetic per-row entry using the row's
      // top-level totals + first model name (or unknown).
      const modelsUsed = Array.isArray(raw.modelsUsed) ? (raw.modelsUsed as unknown[]) : [];
      const fallbackModel = typeof modelsUsed[0] === 'string' ? (modelsUsed[0] as string) : 'unknown';
      rows.push({
        sessionId,
        model: fallbackModel,
        tool,
        eventTs,
        inputTokens: toInt(raw.inputTokens),
        outputTokens: toInt(raw.outputTokens),
        cacheCreationTokens: toInt(raw.cacheCreationTokens),
        cacheReadTokens: toInt(raw.cacheReadTokens),
        totalTokens: toInt(raw.totalTokens),
        totalCost: toNumber(raw.totalCost),
        rawJson: JSON.stringify(raw),
      });
      continue;
    }

    for (const b of breakdowns) {
      if (!b || typeof b !== 'object') {
        warnings.push(`skipped malformed modelBreakdown for session ${sessionId}`);
        continue;
      }
      const model = typeof b.modelName === 'string' ? b.modelName : null;
      if (!model) {
        warnings.push(`skipped modelBreakdown missing modelName for session ${sessionId}`);
        continue;
      }
      const inputTokens = toInt(b.inputTokens);
      const outputTokens = toInt(b.outputTokens);
      const cacheCreationTokens = toInt(b.cacheCreationTokens);
      const cacheReadTokens = toInt(b.cacheReadTokens);
      const totalTokens =
        inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
      rows.push({
        sessionId,
        model,
        tool,
        eventTs,
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        totalTokens,
        totalCost: toNumber(b.cost),
        rawJson: JSON.stringify(raw),
      });
    }
  }

  return { rows, highWaterMark: highWaterIso, warnings };
}

/**
 * Extract a canonical session id from ccusage's `period` field, which is
 * tool-specific.
 */
export function extractSessionId(tool: string, period: string): string {
  if (tool === 'codex') {
    // Codex period example:
    //   "2026/03/13/rollout-2026-03-13T05-48-02-019ce706-657d-7b70-ae09-9f33e32745ee"
    // The session UUID is the trailing five hyphen-delimited blocks
    // (8-4-4-4-12). Pull it out by matching the canonical UUID shape at the end.
    const m = period.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    if (m) return m[0];
  }
  return period;
}

/**
 * Normalize ccusage's `metadata.lastActivity` (date-only, ISO, or undefined)
 * into a canonical ISO 8601 string.
 */
function normalizeLastActivity(value: unknown, nowIso: () => string): string {
  if (typeof value === 'string' && value.length > 0) {
    // Already ISO?
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
    // Date-only YYYY-MM-DD → snap to UTC midnight.
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  }
  // Undefined / malformed — stamp with current time minus a 1-minute safety
  // lag so the event sorts before any "current" rollup query.
  const now = new Date(nowIso());
  now.setMinutes(now.getMinutes() - 1);
  return now.toISOString();
}

function toInt(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  return 0;
}

function toNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return 0;
}
