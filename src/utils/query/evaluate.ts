/**
 * AQL evaluator — compiles a parsed AST into a predicate function over
 * QueryItems. Field references are validated at compile time (structured
 * errors with positions); evaluation is pure.
 *
 * Time semantics (AQL design, "Duration literals"):
 *  - vs a TIMESTAMP field, a duration literal is a relative point in time:
 *    `created > -36h` ⇒ created after (now − 36h). A bare duration (`36h`)
 *    means "ago" (same as `-36h`).
 *  - vs a DURATION field, a duration literal is a magnitude (sign ignored):
 *    `statusAge > 3d` ⇒ in current status longer than 3 days.
 *  - Absolute dates compare on LOCAL-day boundaries (consistent with the
 *    dashboard's matchesDateRange).
 *
 * Browser-safe (no Node APIs). `now` is injected via EvalContext — never read
 * from Date.now() here — so evaluation is deterministic and testable.
 */

import type { AtomNode, QueryError, QueryNode, QueryValue } from './ast.js';
import { readField, resolveField, type FieldDef, type FieldRegistry, type QueryItem } from './fields.js';

export interface EvalContext {
  /** Epoch ms used to resolve relative duration literals. */
  now: number;
}

export type Predicate = (item: QueryItem, ctx: EvalContext) => boolean;

export class CompileError extends Error {
  constructor(public errors: QueryError[]) {
    super(errors.map((e) => `${e.message} (at ${e.pos})`).join('; '));
    this.name = 'CompileError';
  }
}

/**
 * [startOfDay, startOfNextDay) for a YYYY-MM-DD in local time. Rejects
 * impossible calendar dates (e.g. 2026-02-30) instead of letting `new Date`
 * silently roll them over — otherwise `created:2026-02-30` would compile and
 * match March 2. Throws CompileError with the atom's position on invalid input.
 */
function localDayBounds(value: { raw: string; pos: number }): [number, number] {
  const [y, m, d] = value.raw.split('-').map((n) => parseInt(n, 10));
  const start = new Date(y, m - 1, d);
  if (start.getFullYear() !== y || start.getMonth() !== m - 1 || start.getDate() !== d) {
    throw new CompileError([{ pos: value.pos, message: `Invalid date "${value.raw}"` }]);
  }
  const end = new Date(y, m - 1, d + 1).getTime();
  return [start.getTime(), end];
}

function toEpoch(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.length > 0) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function ciEquals(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

function isNone(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

function compileEquality(def: FieldDef, field: string, value: QueryValue, atomPos: number): Predicate {
  switch (def.kind) {
    case 'enum':
    case 'string':
      if (def.noneSentinel && value.raw.toLowerCase() === 'none') {
        return (item) => isNone(readField(def, field, item));
      }
      return (item) => ciEquals(readField(def, field, item), value.raw);
    case 'substring':
      return (item) => {
        const v = readField(def, field, item);
        return typeof v === 'string' && v.toLowerCase().includes(value.raw.toLowerCase());
      };
    case 'bool': {
      const want = value.raw.toLowerCase();
      if (want !== 'true' && want !== 'false') {
        throw new CompileError([
          { pos: value.pos, message: `Field "${field}" is boolean — use ${field}:true or ${field}:false` },
        ]);
      }
      const expected = want === 'true';
      return (item) => {
        // Strict-ish coercion: real booleans pass through; the strings
        // 'true'/'false' parse (frontmatter scalars); null/undefined/'' mean
        // false (an absent fact is false). Anything else never matches —
        // Boolean('false') === true was the bug here.
        const v = readField(def, field, item);
        const b =
          typeof v === 'boolean'
            ? v
            : v === 'true'
              ? true
              : v === 'false' || v === null || v === undefined || v === ''
                ? false
                : null;
        return b !== null && b === expected;
      };
    }
    case 'number': {
      const n = value.num ?? toNumber(value.raw);
      if (n === null) {
        throw new CompileError([{ pos: value.pos, message: `Field "${field}" is numeric — "${value.raw}" is not a number` }]);
      }
      return (item) => toNumber(readField(def, field, item)) === n;
    }
    case 'ordinal':
      return (item) => ciEquals(readField(def, field, item), value.raw);
    case 'list':
      return (item) => {
        const v = readField(def, field, item);
        return Array.isArray(v) && v.some((el) => ciEquals(el, value.raw));
      };
    case 'timestamp': {
      if (value.type === 'date') {
        const [start, end] = localDayBounds(value);
        return (item) => {
          const t = toEpoch(readField(def, field, item));
          return t !== null && t >= start && t < end;
        };
      }
      throw new CompileError([
        { pos: value.pos, message: `Field "${field}" is a timestamp — use a comparison (e.g. ${field} > -36h) or an absolute date (${field}:2026-06-01)` },
      ]);
    }
    case 'duration':
      throw new CompileError([
        { pos: atomPos, message: `Field "${field}" is a duration — use a comparison (e.g. ${field} > 3d)` },
      ]);
  }
}

function compileComparison(def: FieldDef, field: string, op: string, value: QueryValue): Predicate {
  const cmp = (a: number, b: number): boolean => {
    switch (op) {
      case '<':
        return a < b;
      case '>':
        return a > b;
      case '<=':
        return a <= b;
      case '>=':
        return a >= b;
      case '=':
        return a === b;
      case '!=':
        return a !== b;
      default:
        return false;
    }
  };

  switch (def.kind) {
    case 'number': {
      const n = value.num ?? toNumber(value.raw);
      if (n === null) {
        throw new CompileError([{ pos: value.pos, message: `"${value.raw}" is not a number (field "${field}")` }]);
      }
      return (item) => {
        const v = toNumber(readField(def, field, item));
        return v !== null && cmp(v, n);
      };
    }
    case 'ordinal': {
      const order = def.order ?? [];
      const idx = order.findIndex((o) => o.toLowerCase() === value.raw.toLowerCase());
      if (idx < 0) {
        throw new CompileError([
          { pos: value.pos, message: `"${value.raw}" is not a valid ${field} (expected one of: ${order.join(', ')})` },
        ]);
      }
      return (item) => {
        const raw = readField(def, field, item);
        const vIdx = typeof raw === 'string' ? order.findIndex((o) => o.toLowerCase() === raw.toLowerCase()) : -1;
        return vIdx >= 0 && cmp(vIdx, idx);
      };
    }
    case 'timestamp': {
      if (value.type === 'duration') {
        // relative point in time: bare durations mean "ago"
        const sign = value.sign === 0 ? -1 : (value.sign ?? -1);
        const offset = sign * (value.num ?? 0);
        return (item, ctx) => {
          const t = toEpoch(readField(def, field, item));
          return t !== null && cmp(t, ctx.now + offset);
        };
      }
      if (value.type === 'date') {
        const [start, end] = localDayBounds(value);
        return (item) => {
          const t = toEpoch(readField(def, field, item));
          if (t === null) return false;
          switch (op) {
            case '<':
              return t < start;
            case '<=':
              return t < end;
            case '>':
              return t >= end;
            case '>=':
              return t >= start;
            case '=':
              return t >= start && t < end;
            case '!=':
              return t < start || t >= end;
            default:
              return false;
          }
        };
      }
      throw new CompileError([
        { pos: value.pos, message: `Compare timestamp field "${field}" to a duration (e.g. -36h) or a date (YYYY-MM-DD)` },
      ]);
    }
    case 'duration': {
      if (value.type !== 'duration') {
        throw new CompileError([
          { pos: value.pos, message: `Compare duration field "${field}" to a duration literal (e.g. 3d)` },
        ]);
      }
      const magnitude = value.num ?? 0; // sign ignored: magnitudes have no direction
      return (item) => {
        const v = toNumber(readField(def, field, item));
        return v !== null && cmp(v, magnitude);
      };
    }
    case 'enum':
    case 'string':
    case 'substring':
    case 'list': {
      if (op === '=' ) {
        return compileEquality(def, field, value, value.pos);
      }
      if (op === '!=') {
        const eq = compileEquality(def, field, value, value.pos);
        return (item, ctx) => !eq(item, ctx);
      }
      throw new CompileError([
        { pos: value.pos, message: `Field "${field}" does not support ordering comparisons (use ":" or "=").` },
      ]);
    }
    case 'bool': {
      if (op === '=' || op === '!=') {
        const eq = compileEquality(def, field, value, value.pos);
        return op === '=' ? eq : (item, ctx) => !eq(item, ctx);
      }
      throw new CompileError([{ pos: value.pos, message: `Field "${field}" is boolean — use ${field}:true / ${field}:false` }]);
    }
  }
}

function compileAtom(atom: AtomNode, registry: FieldRegistry): Predicate {
  const def = resolveField(registry, atom.field);
  if (!def) {
    throw new CompileError([{ pos: atom.pos, message: `Unknown field "${atom.field}"` }]);
  }
  if (atom.op === ':') {
    // IN-list: OR of equalities
    const preds = atom.values.map((v) => compileEquality(def, atom.field, v, atom.pos));
    if (preds.length === 1) return preds[0];
    return (item, ctx) => preds.some((p) => p(item, ctx));
  }
  return compileComparison(def, atom.field, atom.op, atom.values[0]);
}

export function compileNode(node: QueryNode, registry: FieldRegistry): Predicate {
  switch (node.kind) {
    case 'all':
      return () => true;
    case 'atom':
      return compileAtom(node, registry);
    case 'not': {
      const inner = compileNode(node.child, registry);
      return (item, ctx) => !inner(item, ctx);
    }
    case 'and': {
      const preds = node.children.map((c) => compileNode(c, registry));
      return (item, ctx) => preds.every((p) => p(item, ctx));
    }
    case 'or': {
      const preds = node.children.map((c) => compileNode(c, registry));
      return (item, ctx) => preds.some((p) => p(item, ctx));
    }
  }
}
