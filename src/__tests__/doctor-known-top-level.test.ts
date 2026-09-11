import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KNOWN_TOP_LEVEL } from '../utils/doctor/checks/structure.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

const CRITERION_NAMES = [
  'assignments',
  'agents',
  'workflows',
  'targets',
  'saved-views.json',
  'view-prefs.json',
  'inbox-snoozes.json',
] as const;

const REQUIRED_DISCOVERED = [
  'worktrees',
  'npx-install.json',
  'inbox-snoozes.json',
  'runtime',
] as const;

// session.ts compares against context.json only to skip it — nothing writes it at root.
const EXCLUDED_ROOT_NAMES = new Set(['context.json']);

function walkTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      results.push(...walkTsFiles(full));
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      results.push(full);
    }
  }
  return results;
}

function collectRootBindings(source: string): Set<string> {
  const bindings = new Set<string>(['syntaurRoot']);
  const re = /\b(\w+)\s*=\s*(?:[^;\n]*\?\?\s*)?syntaurRoot\(\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    bindings.add(m[1]);
  }
  return bindings;
}

function rootReceiverPattern(bindings: Set<string>): string {
  const parts: string[] = [];
  for (const id of bindings) {
    if (id === 'syntaurRoot') parts.push(`${id}\\(\\)`);
    else parts.push(`\\b${id}\\b`);
  }
  return parts.join('|');
}

export function collectRootLiterals(source: string, bindings: Set<string>): Set<string> {
  const names = new Set<string>();
  const receiver = rootReceiverPattern(bindings);
  const callRe = new RegExp(
    `(?:resolve|join)\\(\\s*(?:${receiver})\\s*,\\s*['"]([^'"]+)['"]`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source)) !== null) {
    const name = m[1];
    if (!name.includes('/')) names.add(name);
  }

  const multilineFirstRe = new RegExp(
    `(?:resolve|join)\\(\\s*(?:${receiver})\\s*,\\s*[\\s\\n]*['"]([^'"]+)['"]`,
    'g',
  );
  while ((m = multilineFirstRe.exec(source)) !== null) {
    const name = m[1];
    if (!name.includes('/')) names.add(name);
  }

  return names;
}

export function discoverKnownTopLevelNames(): Set<string> {
  const discovered = new Set<string>();
  for (const file of walkTsFiles(join(REPO_ROOT, 'src'))) {
    const source = readFileSync(file, 'utf-8');
    const bindings = collectRootBindings(source);
    for (const name of collectRootLiterals(source, bindings)) {
      if (!EXCLUDED_ROOT_NAMES.has(name)) discovered.add(name);
    }
  }
  for (const marker of markerConstants()) {
    discovered.add(marker);
  }
  return discovered;
}

function markerConstants(): string[] {
  const recompute = readFileSync(join(REPO_ROOT, 'src/lifecycle/recompute.ts'), 'utf-8');
  const stages = readFileSync(join(REPO_ROOT, 'src/utils/stages-marker.ts'), 'utf-8');
  const derive = recompute.match(/const MIGRATION_MARKER = '([^']+)'/)?.[1];
  const stagesMarker = stages.match(/const STAGES_MARKER = '([^']+)'/)?.[1];
  return [derive, stagesMarker].filter((v): v is string => Boolean(v));
}

describe('doctor KNOWN_TOP_LEVEL', () => {
  it('includes every acceptance-criterion name', () => {
    for (const name of CRITERION_NAMES) {
      expect(KNOWN_TOP_LEVEL.has(name)).toBe(true);
    }
  });

  it('matches every root-level literal written via syntaurRoot bindings', () => {
    const discovered = discoverKnownTopLevelNames();

    for (const name of REQUIRED_DISCOVERED) {
      expect(discovered.has(name), `scanner must discover ${name}`).toBe(true);
    }

    const missing = [...discovered].filter((n) => !KNOWN_TOP_LEVEL.has(n)).sort();
    expect(missing).toEqual([]);
  });
});
