import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const EXCLUDED = new Set([
  'fake-command-resolver.ts',
  'listen-guard.test.ts',
  'listen-guard-scan.ts',
]);

/** Replace string and template literal contents with spaces so `(` / `)` inside never count. */
function maskStrings(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ' ';
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\' && i + 1 < source.length) {
          out += '  ';
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          out += ' ';
          i += 1;
          break;
        }
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '`') {
      out += ' ';
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\' && i + 1 < source.length) {
          out += '  ';
          i += 2;
          continue;
        }
        if (source[i] === '$' && source[i + 1] === '{') {
          out += '  ';
          i += 2;
          let depth = 1;
          while (i < source.length && depth > 0) {
            const c = source[i];
            if (c === '{') depth += 1;
            else if (c === '}') depth -= 1;
            out += c === '\n' ? '\n' : ' ';
            i += 1;
          }
          continue;
        }
        if (source[i] === '`') {
          out += ' ';
          i += 1;
          break;
        }
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

const HOST_LITERAL = /'127\.0\.0\.1'|"127\.0\.0\.1"/;

/**
 * Best-effort scan: every `.listen(` in test sources must pass the literal host
 * `'127.0.0.1'` in its argument list unless the call line carries
 * `// listen-guard: ignore`.
 */
export function findListenGuardViolations(source: string, label = 'file'): string[] {
  const stripped = maskStrings(source);
  const violations: string[] = [];
  const needle = '.listen(';
  let from = 0;
  while (true) {
    const at = stripped.indexOf(needle, from);
    if (at === -1) break;
    const lineStart = source.lastIndexOf('\n', at) + 1;
    const lineEnd = source.indexOf('\n', at);
    const rawLine = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
    if (rawLine.includes('listen-guard: ignore')) {
      from = at + needle.length;
      continue;
    }
    let depth = 1;
    let i = at + needle.length;
    while (i < stripped.length && depth > 0) {
      const ch = stripped[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    const args = source.slice(at + needle.length, i - 1);
    if (!HOST_LITERAL.test(args)) {
      violations.push(`${label}:${lineNumberAt(source, at)}`);
    }
    from = at + needle.length;
  }
  return violations;
}

export async function scanTestTree(root: string): Promise<string[]> {
  const violations: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      if (EXCLUDED.has(entry.name)) continue;
      const source = await readFile(path, 'utf-8');
      violations.push(...findListenGuardViolations(source, path));
    }
  }
  await walk(root);
  return violations;
}
