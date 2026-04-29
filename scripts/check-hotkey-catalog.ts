// Greps every `useHotkey({ keys: '...' })` call in the dashboard tree and
// asserts the `keys` value is represented in BUILTIN_RESERVED_COMBOS so the
// shared catalog stays in sync as new built-in shortcuts are added.
//
// Run via: `npx tsx scripts/check-hotkey-catalog.ts` (or wire into prebuild).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_RESERVED_COMBOS,
  canonicalizeCombo,
} from '../src/utils/hotkeysCatalog.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD_SRC = resolve(ROOT, 'dashboard/src');

interface Sighting {
  file: string;
  line: number;
  rawKeys: string;
  canonical: string;
}

function* walk(dir: string): Iterable<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      yield full;
    }
  }
}

function findSightings(): Sighting[] {
  const sightings: Sighting[] = [];
  // Match patterns like:
  //   useHotkey({
  //     keys: 'g a',
  //   useHotkey({ keys: '?', ...
  // Catches both single-line and multi-line variants.
  const re = /useHotkey\s*\(\s*\{[^}]*?keys:\s*['"`]([^'"`]+)['"`]/g;
  for (const file of walk(DASHBOARD_SRC)) {
    const content = readFileSync(file, 'utf-8');
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const raw = match[1];
      const upToHere = content.slice(0, match.index);
      const line = upToHere.split('\n').length;
      sightings.push({
        file: file.replace(`${ROOT}/`, ''),
        line,
        rawKeys: raw,
        canonical: canonicalizeCombo(raw),
      });
    }
  }
  return sightings;
}

function main() {
  const sightings = findSightings();
  const reserved = new Set(BUILTIN_RESERVED_COMBOS.map((c) => canonicalizeCombo(c)));
  const missing: Sighting[] = [];
  for (const s of sightings) {
    // Chord prefixes — the catalog stores `g <suffix>` entries; skip the
    // bare-`g` chord starter check here because individual `g <suffix>` pairs
    // are what useHotkey registers.
    if (!reserved.has(s.canonical)) missing.push(s);
  }

  if (missing.length === 0) {
    console.log(
      `[hotkey-catalog] ok — ${sightings.length} useHotkey sightings all present in BUILTIN_RESERVED_COMBOS`,
    );
    return;
  }

  console.error('[hotkey-catalog] FAIL — combos missing from BUILTIN_RESERVED_COMBOS:');
  for (const s of missing) {
    console.error(`  ${s.file}:${s.line}  keys: "${s.rawKeys}" (canonical: "${s.canonical}")`);
  }
  console.error(
    'Add the missing combos to src/utils/hotkeysCatalog.ts (BUILTIN_RESERVED_COMBOS) and the dashboard-only metadata in dashboard/src/hotkeys/bindableActions.ts (BUILTIN_HOTKEY_CATALOG).',
  );
  process.exit(1);
}

main();
