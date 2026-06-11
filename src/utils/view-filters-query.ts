/**
 * Bidirectional translators between the dashboard's chip-based `ViewFilters`
 * and an AQL (Assignment Query Language) query string.
 *
 * This is the correctness linchpin of the query-language saved-views feature:
 * a chip-only `ViewFilters` must round-trip through a query string exactly.
 *
 * Browser-safe: imports ONLY from `./query/index.js` (the AQL parser surface)
 * and the `ViewFilters` type. No Node-only APIs — mirrors the browser-safety of
 * `saved-views-schema.ts`, so the dashboard can translate client-side.
 *
 * ── The chip-representable subset (the exact contract) ───────────────────────
 * A query is chip-representable iff its AST is:
 *   - `all` (empty input / `*`)                            → {}
 *   - a single chip atom, OR
 *   - a FLAT AND of chip atoms with at most one atom per chip slot
 *     (dateRange may use two atoms — a `>=` and a `<=` on the same date field).
 * Recognized chip atoms:
 *   - status/type/priority/assignee/project/tags with op ':' and 1+ values
 *     (IN-list ↔ multi-select). Sentinels assignee:none ↔ '__unassigned__',
 *     project:none ↔ '__standalone__'.
 *   - search:"text" ↔ the search box.
 *   - The EXACT activity shapes `updated < -7d` (stale) / `updated >= -7d` (fresh).
 *   - dateRange shapes: `created|updated >= -X` (last_X), `< -X` (older_X), and
 *     absolute `>= YYYY-MM-DD` / `<= YYYY-MM-DD` (from/to).
 * Everything else → `null` (the dashboard's read-only-fallback trigger): any OR,
 * any NOT/negation, any parenthesized grouping, comparison atoms outside the
 * recognized shapes, any other field, or a duplicate slot.
 *
 * ── The `updated` collision (documented precedence) ──────────────────────────
 * Activity stale/fresh and a dateRange `{field:'updated', preset:'older_7d'|'last_7d'}`
 * encode the IDENTICAL AST atom (`updated < -7d` / `updated >= -7d`). Activity is
 * the canonical owner of that exact shape:
 *   - Parse: `updated < -7d` → activity 'stale'; `updated >= -7d` → activity 'fresh'
 *     (these NEVER parse to a dateRange).
 *   - Normalize (`normalizeChipFilters`): a `field:'updated'` dateRange whose preset
 *     is older_7d/last_7d folds into activity stale/fresh and the dateRange is dropped.
 * The same presets on `field:'created'` do NOT collide (activity is updated-only) and
 * round-trip cleanly as a dateRange.
 */

import { parseQuery } from './query/index.js';
import type { QueryNode } from './query/index.js';
import type { AtomNode, QueryValue } from './query/ast.js';
import type {
  ViewFilters,
  Activity,
  DateRangeField,
  DateRangePreset,
  DateRangeFilter,
} from './view-prefs-schema.js';
import { toFilterValues } from './view-prefs-schema.js';

// ── Lexer-parity IDENT / keyword recognition (Decision 5) ────────────────────
// Must match the lexer at src/utils/query/lexer.ts (~55-56): IDENT_START =
// [A-Za-z_], IDENT_CHAR = [A-Za-z0-9_-]. A keyword (and/or/not, case-insensitive)
// would re-lex as AND/OR/NOT, so it must be quoted to survive as a value.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const KEYWORDS = new Set(['and', 'or', 'not']);

/**
 * Emit a query-string value: unquoted when it is a bare identifier that is not a
 * keyword; otherwise a double-quoted string with `\` and `"` escaped. This is
 * what forces actor ids like `agent:codex` (contains `:`) to be quoted.
 */
export function quoteQueryValue(value: string): string {
  if (IDENT_RE.test(value) && !KEYWORDS.has(value.toLowerCase())) {
    return value;
  }
  return quoteString(value);
}

/** Unconditional double-quoted string literal with `\` and `"` escaped. */
function quoteString(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

// ── Sentinels ────────────────────────────────────────────────────────────────
const UNASSIGNED = '__unassigned__';
const STANDALONE = '__standalone__';

// ── dateRange preset ↔ AQL relative-duration literal ─────────────────────────
// last_X → `field >= -X`; older_X → `field < -X` (Decision 7). The literal text
// is the canonical duration the lexer accepts (`24h`, `7d`, `30d`, `90d`).
const PRESET_DURATION: Record<DateRangePreset, string> = {
  last_24h: '24h',
  last_7d: '7d',
  last_30d: '30d',
  last_90d: '90d',
  older_7d: '7d',
  older_30d: '30d',
};
// `last_*` use `>=`; `older_*` use `<`.
function presetOp(preset: DateRangePreset): '>=' | '<' {
  return preset.startsWith('older_') ? '<' : '>=';
}

// Multi-capable chip slots (op ':' with values), in canonical emission order.
const VALUE_SLOTS = ['status', 'type', 'priority', 'assignee', 'project', 'tags'] as const;
type ValueSlot = (typeof VALUE_SLOTS)[number];

const DATE_FIELDS: readonly DateRangeField[] = ['created', 'updated'];

// ── normalizeChipFilters ─────────────────────────────────────────────────────
// Canonical form a chip-only ViewFilters reduces to. The round-trip law is
// stated against THIS, not the raw input. Rules:
//   - VALUE_SLOTS → deduped string[] via toFilterValues; omitted when empty.
//   - search → trimmed; omitted when blank.
//   - activity → omitted when undefined / 'all'.
//   - dateRange → kept as-is EXCEPT a `field:'updated'` older_7d/last_7d preset
//     folds into activity (stale/fresh) and the dateRange is dropped (the
//     documented `updated` collision). When an `updated` dateRange folds AND an
//     activity is already set, activity wins (it owns the slot) and the
//     dateRange is dropped.
export function normalizeChipFilters(filters: ViewFilters): ViewFilters {
  const out: ViewFilters = {};

  for (const slot of VALUE_SLOTS) {
    const values = toFilterValues(filters[slot]);
    if (values.length) out[slot] = values;
  }

  const search = filters.search?.trim();
  if (search) out.search = search;

  let activity: Activity | undefined =
    filters.activity && filters.activity !== 'all' ? filters.activity : undefined;

  const dr = filters.dateRange;
  if (dr) {
    const folded = foldUpdatedPresetToActivity(dr);
    if (folded) {
      // `updated` collision: dateRange becomes activity, unless one is already set.
      if (!activity) activity = folded;
    } else {
      const cleaned = cleanDateRange(dr);
      if (cleaned) out.dateRange = cleaned;
    }
  }

  if (activity) out.activity = activity;

  return out;
}

// Returns the activity an `updated` older_7d/last_7d dateRange collides with, or
// null when the dateRange does not collide.
function foldUpdatedPresetToActivity(dr: DateRangeFilter): Activity | null {
  if (dr.field !== 'updated' || !dr.preset) return null;
  if (dr.preset === 'older_7d') return 'stale';
  if (dr.preset === 'last_7d') return 'fresh';
  return null;
}

// Drop a dateRange that carries no real constraint (no preset and no from/to).
function cleanDateRange(dr: DateRangeFilter): DateRangeFilter | null {
  if (dr.preset) return { field: dr.field, preset: dr.preset };
  const from = dr.from && dr.from.length > 0 ? dr.from : undefined;
  const to = dr.to && dr.to.length > 0 ? dr.to : undefined;
  if (!from && !to) return null;
  const out: DateRangeFilter = { field: dr.field };
  if (from) out.from = from;
  if (to) out.to = to;
  return out;
}

// ── viewFiltersToQuery (total) ───────────────────────────────────────────────
/**
 * Total: emits the canonical chip-subset query string for any ViewFilters, or
 * '' when there are no constraints. Atoms are joined with ` AND `. Input is
 * normalized first (so the round-trip law holds against `normalizeChipFilters`).
 */
export function viewFiltersToQuery(filters: ViewFilters): string {
  const f = normalizeChipFilters(filters);
  const atoms: string[] = [];

  for (const slot of VALUE_SLOTS) {
    const values = (f[slot] as string[] | undefined) ?? [];
    if (!values.length) continue;
    atoms.push(emitValueSlot(slot, values));
  }

  // search is ALWAYS quoted (free text): emit a double-quoted, escaped string
  // even for bare-ident-looking text, so the chip is unambiguously the search box.
  if (f.search) atoms.push(`search:${quoteString(f.search)}`);

  if (f.activity === 'stale') atoms.push('updated < -7d');
  else if (f.activity === 'fresh') atoms.push('updated >= -7d');

  if (f.dateRange) atoms.push(...emitDateRange(f.dateRange));

  return atoms.join(' AND ');
}

function emitValueSlot(slot: ValueSlot, values: string[]): string {
  const mapped = values.map((v) => mapSentinelOut(slot, v));
  if (mapped.length === 1) return `${slot}:${mapped[0]}`;
  return `${slot}:(${mapped.join(', ')})`;
}

// Sentinel → query token (assignee/project `none`); everything else is quoted
// per the IDENT rule.
function mapSentinelOut(slot: ValueSlot, value: string): string {
  if (slot === 'assignee' && value === UNASSIGNED) return 'none';
  if (slot === 'project' && value === STANDALONE) return 'none';
  return quoteQueryValue(value);
}

function emitDateRange(dr: DateRangeFilter): string[] {
  if (dr.preset) {
    return [`${dr.field} ${presetOp(dr.preset)} -${PRESET_DURATION[dr.preset]}`];
  }
  const out: string[] = [];
  if (dr.from) out.push(`${dr.field} >= ${dr.from}`);
  if (dr.to) out.push(`${dr.field} <= ${dr.to}`);
  return out;
}

// ── queryToViewFilters (partial) ─────────────────────────────────────────────
/**
 * Partial: returns a ViewFilters when the AST is chip-representable, else null.
 * Structural parse only (no FieldRegistry) — recognition is by atom shape.
 */
export function queryToViewFilters(query: string): ViewFilters | null {
  const parsed = parseQuery(query);
  if (!parsed.ast) return null; // lex/parse error

  const atoms = flattenChipAtoms(parsed.ast);
  if (atoms === null) return null; // OR / NOT / grouping / non-atom → not chip-representable

  const result: ViewFilters = {};
  // Track occupied logical slots to reject duplicates. The `updated`/date fields
  // share special handling below.
  const used = new Set<string>();
  // Accumulate date-field bounds so a `>=`/`<=` pair on one field merges into a
  // single dateRange.
  const dateBounds = new Map<DateRangeField, { from?: string; to?: string }>();

  for (const atom of atoms) {
    const slot = recognizeAtom(atom);
    if (!slot) return null;

    switch (slot.kind) {
      case 'value': {
        if (used.has(slot.field)) return null; // duplicate slot
        used.add(slot.field);
        result[slot.field] = slot.values;
        break;
      }
      case 'search': {
        if (used.has('search')) return null;
        used.add('search');
        result.search = slot.text;
        break;
      }
      case 'activity': {
        // activity and the `updated` date field are the same AST field; one
        // owner only. Reject if a preset claimed `updated` (used) OR absolute
        // bounds did (dateBounds).
        if (used.has('activity') || used.has('date:updated') || dateBounds.has('updated')) {
          return null;
        }
        used.add('activity');
        used.add('date:updated');
        result.activity = slot.activity;
        break;
      }
      case 'datePreset': {
        const key = `date:${slot.field}`;
        if (used.has(key)) return null;
        // A preset is a whole dateRange — it cannot coexist with bounds on the
        // same field. `updated` preset also conflicts with activity.
        if (slot.field === 'updated' && used.has('activity')) return null;
        if (dateBounds.has(slot.field)) return null;
        used.add(key);
        result.dateRange = { field: slot.field, preset: slot.preset };
        break;
      }
      case 'dateBound': {
        // Bounds accumulate (>= → from, <= → to) but each direction only once,
        // and not alongside a preset on the same field.
        const key = `date:${slot.field}`;
        if (used.has(key)) return null; // a preset already claimed this field
        if (slot.field === 'updated' && used.has('activity')) return null;
        const bounds = dateBounds.get(slot.field) ?? {};
        if (slot.bound === 'from') {
          if (bounds.from !== undefined) return null; // duplicate >=
          bounds.from = slot.date;
        } else {
          if (bounds.to !== undefined) return null; // duplicate <=
          bounds.to = slot.date;
        }
        dateBounds.set(slot.field, bounds);
        break;
      }
    }
  }

  // Materialize accumulated absolute date bounds into a single dateRange. At most
  // one date field may carry bounds (a second would be a separate dateRange slot).
  if (dateBounds.size > 1) return null;
  for (const [field, bounds] of dateBounds) {
    if (result.dateRange) return null; // already set by a preset → conflict
    const dr: DateRangeFilter = { field };
    if (bounds.from !== undefined) dr.from = bounds.from;
    if (bounds.to !== undefined) dr.to = bounds.to;
    result.dateRange = dr;
  }

  return result;
}

// Flatten the AST into a list of atoms IFF it is `all`, a single atom, or a flat
// AND of atoms. Returns null for OR / NOT / nested grouping / any non-atom child.
// (Parenthesized grouping that collapses to a bare AND/atom is indistinguishable
// from the unparenthesized form in this AST — both are accepted. A grouping that
// introduces OR/NOT is rejected by the non-atom check.)
function flattenChipAtoms(node: QueryNode): AtomNode[] | null {
  if (node.kind === 'all') return [];
  if (node.kind === 'atom') return [node];
  if (node.kind === 'and') {
    const out: AtomNode[] = [];
    for (const child of node.children) {
      if (child.kind !== 'atom') return null; // nested AND/OR/NOT inside the AND
      out.push(child);
    }
    return out;
  }
  return null; // or / not
}

// ── Atom recognition ─────────────────────────────────────────────────────────
type Recognized =
  | { kind: 'value'; field: ValueSlot; values: string[] }
  | { kind: 'search'; text: string }
  | { kind: 'activity'; activity: Activity }
  | { kind: 'datePreset'; field: DateRangeField; preset: DateRangePreset }
  | { kind: 'dateBound'; field: DateRangeField; bound: 'from' | 'to'; date: string };

function recognizeAtom(atom: AtomNode): Recognized | null {
  const field = atom.field.toLowerCase();

  // ── ':' atoms (value slots, sentinels, search) ──
  if (atom.op === ':') {
    if ((VALUE_SLOTS as readonly string[]).includes(field)) {
      const slot = field as ValueSlot;
      const values: string[] = [];
      for (const v of atom.values) {
        const mapped = mapSentinelIn(slot, v);
        if (mapped === null) return null; // unrepresentable value (e.g. wrong type)
        values.push(mapped);
      }
      if (values.length === 0) return null;
      return { kind: 'value', field: slot, values };
    }
    if (field === 'search') {
      if (atom.values.length !== 1) return null;
      const v = atom.values[0];
      // Accept any single-value search; the canonical emission is a string, but
      // a bare word (`search:foo`) is equally representable.
      return { kind: 'search', text: v.raw };
    }
    return null; // any other field with ':' → not a chip slot
  }

  // ── comparison atoms (activity / dateRange) ──
  if (!DATE_FIELDS.includes(field as DateRangeField)) return null;
  const dateField = field as DateRangeField;
  if (atom.values.length !== 1) return null;
  const v = atom.values[0];

  // Relative-duration comparison: activity (updated only) or last_/older_ preset.
  if (v.type === 'duration') {
    return recognizeRelative(dateField, atom.op, v);
  }
  // Absolute date comparison: from (>=) / to (<=).
  if (v.type === 'date') {
    if (atom.op === '>=') return { kind: 'dateBound', field: dateField, bound: 'from', date: v.raw };
    if (atom.op === '<=') return { kind: 'dateBound', field: dateField, bound: 'to', date: v.raw };
    return null; // <, >, =, != on a date are not chip-representable
  }
  return null;
}

// A relative-duration comparison on a date field. Only the EXACT canonical forms
// are recognized; everything else → null (read-only fallback). Magnitudes are
// matched by the literal duration text so e.g. `-7d` and `-1w` (both 7 days) are
// NOT conflated — we only accept what we emit.
function recognizeRelative(field: DateRangeField, op: AtomNode['op'], v: QueryValue): Recognized | null {
  // Only past-relative literals (`-X`) are canonical. A bare `7d` lexes with
  // sign 0 (treated as "ago" by the engine) but is not what we emit, so reject
  // it to keep the contract exact. `+X` (future) is never chip-representable.
  if (v.sign !== -1) return null;
  const dur = stripSign(v.raw); // e.g. '7d' from '-7d'

  // Activity (updated field only).
  if (field === 'updated') {
    if (op === '<' && dur === '7d') return { kind: 'activity', activity: 'stale' };
    if (op === '>=' && dur === '7d') return { kind: 'activity', activity: 'fresh' };
  }

  // dateRange presets. `>=` → last_X; `<` → older_X. Match the canonical durations.
  const preset = relativeToPreset(op, dur);
  if (preset) return { kind: 'datePreset', field, preset };
  return null;
}

// `-7d` → `7d`. The lexer's DURATION raw retains the leading sign.
function stripSign(raw: string): string {
  return raw.replace(/^[-+]/, '');
}

// Map a (op, duration-text) to its canonical dateRange preset, or null.
// NOTE: `updated >= -7d` / `updated < -7d` are intercepted as activity BEFORE
// this is consulted (see recognizeRelative), so the 7d entries here are reached
// only for the `created` field.
const RELATIVE_PRESETS: Record<'>=' | '<', Record<string, DateRangePreset>> = {
  '>=': { '24h': 'last_24h', '7d': 'last_7d', '30d': 'last_30d', '90d': 'last_90d' },
  '<': { '7d': 'older_7d', '30d': 'older_30d' },
};

function relativeToPreset(op: AtomNode['op'], dur: string): DateRangePreset | null {
  if (op !== '>=' && op !== '<') return null;
  return RELATIVE_PRESETS[op][dur] ?? null;
}

// Sentinel + value-type guard for a ':' value. Returns the chip value string, or
// null when the value can't be a chip value. assignee/project accept `none` as
// the unassigned/standalone sentinel.
function mapSentinelIn(slot: ValueSlot, v: QueryValue): string | null {
  // Use the raw text. word/string values are direct; number/date/duration raw
  // text is also a legitimate string value (e.g. a numeric tag). We keep raw so
  // `status:1` works, but these are uncommon. Reject nothing on type alone.
  const raw = v.raw;
  if (slot === 'assignee' && raw.toLowerCase() === 'none') return UNASSIGNED;
  if (slot === 'project' && raw.toLowerCase() === 'none') return STANDALONE;
  return raw;
}
