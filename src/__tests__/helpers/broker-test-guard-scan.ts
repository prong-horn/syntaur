import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const EXCLUDED = new Set([
  'fake-command-resolver.ts',
  'broker-test-guard.test.ts',
  'broker-test-guard-scan.ts',
]);

function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i);
      if (end === -1) break;
      out += '\n';
      i = end + 1;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) break;
      out += ' '.repeat(end + 2 - i);
      i = end + 2;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

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

/**
 * Best-effort scan: every `createChatBroker(` in test sources must pass an
 * options object that includes `commandResolver:` unless the call line carries
 * `// broker-test-guard: ignore`.
 */
export function findCreateChatBrokerGuardViolations(source: string, label = 'file'): string[] {
  const stripped = maskStrings(stripComments(source));
  const violations: string[] = [];
  const needle = 'createChatBroker(';
  let from = 0;
  while (true) {
    const at = stripped.indexOf(needle, from);
    if (at === -1) break;
    const lineStart = source.lastIndexOf('\n', at) + 1;
    const lineEnd = source.indexOf('\n', at);
    const rawLine = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
    if (rawLine.includes('broker-test-guard: ignore')) {
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
    const options = stripped.slice(at + needle.length, i - 1);
    if (!/\bcommandResolver\s*:/.test(options)) {
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
      violations.push(...findCreateChatBrokerGuardViolations(source, path));
    }
  }
  await walk(root);
  return violations;
}
