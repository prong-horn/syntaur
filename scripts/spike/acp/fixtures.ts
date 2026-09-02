// Fixture export: `node fixtures.ts --claude <run> --codex <run>`
// Copies each run's frame transcripts into src/__tests__/fixtures/acp/<adapter>/
// and writes manifest.json (run ids, versions, scenario → file map with pass/fail).

import fs from 'node:fs';
import path from 'node:path';
import type { ScenarioResult } from './harness.ts';

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, '../../..');
const fixturesDir = path.join(repoRoot, 'src/__tests__/fixtures/acp');
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const runs = { claude: flag('claude'), codex: flag('codex') } as const;
if (!runs.claude && !runs.codex) {
  console.error('usage: node fixtures.ts --claude <run> --codex <run>');
  process.exit(2);
}

type ManifestScenario = {
  id: string;
  title: string;
  adapter: string;
  pass: boolean | null;
  ms: number;
  files: string[];
  notes: string[];
  error?: string;
  metrics?: Record<string, unknown>;
};
const manifest = {
  generated: new Date().toISOString(),
  envelope: '{seq, ts, t, dir: "in"|"out", msg} per line; t = ms since adapter spawn; dir is from the client\'s point of view',
  volatile: [
    'absolute paths under scripts/spike/acp/out/target-<adapter> (the disposable target clones)',
    'sessionId values',
    'tool-call ids (toolu_… / call_…)',
    'usage_update numbers and _meta["_claude/rateLimit"]',
    'e-mail addresses (already replaced with [redacted-email] at capture time)',
  ],
  runs: {} as Record<
    string,
    { run: string; versions: Record<string, string>; target?: string; sourceCommit?: string }
  >,
  scenarios: [] as ManifestScenario[],
};

for (const adapter of ['claude', 'codex'] as const) {
  const run = runs[adapter];
  if (!run) continue;
  const runDir = path.join(here, 'out', run);
  const results: ScenarioResult[] = JSON.parse(fs.readFileSync(path.join(runDir, 'results.json'), 'utf8'));
  const pre = JSON.parse(fs.readFileSync(path.join(runDir, 'preflight.json'), 'utf8')) as Record<string, string>;
  // versions only — the auth-status lines carry account details
  const versions = Object.fromEntries(
    Object.entries(pre).filter(([k]) => !/status/.test(k)),
  );
  // run.json records the target clone + the commit it was reset to (written by run.ts)
  const runJsonPath = path.join(runDir, 'run.json');
  const targetInfo = fs.existsSync(runJsonPath)
    ? (JSON.parse(fs.readFileSync(runJsonPath, 'utf8')) as {
        targets?: Record<string, { path?: string; sourceCommit?: string }>;
      }).targets?.[adapter]
    : undefined;
  manifest.runs[adapter] = {
    run,
    versions,
    ...(targetInfo?.path ? { target: targetInfo.path } : {}),
    ...(targetInfo?.sourceCommit ? { sourceCommit: targetInfo.sourceCommit } : {}),
  };
  const outDir = path.join(fixturesDir, adapter);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  // later reruns of the same scenario (via --only) replace earlier rows
  const latest = new Map<string, ScenarioResult>();
  for (const r of results) latest.set(r.id, r);
  for (const r of [...latest.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const files: string[] = [];
    for (const rel of (r.frames ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const src = path.join(here, rel);
      if (!fs.existsSync(src)) continue;
      // out/<run>/<id>.<adapter>[.label].ndjson → <id>[.label].ndjson
      const name = path.basename(src).replace(`.${adapter}`, '');
      fs.copyFileSync(src, path.join(outDir, name));
      files.push(`${adapter}/${name}`);
    }
    const { badStdoutLines: _b, adapters: _a, ...metrics } = (r.metrics ?? {}) as Record<string, unknown>;
    manifest.scenarios.push({
      id: r.id,
      title: r.title,
      adapter,
      pass: r.pass,
      ms: r.ms,
      files,
      notes: r.notes,
      ...(r.error ? { error: r.error.split('\n')[0] } : {}),
      metrics,
    });
  }
}

fs.writeFileSync(path.join(fixturesDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const n = manifest.scenarios.reduce((a, s) => a + s.files.length, 0);
console.log(`wrote ${n} transcripts + manifest.json under ${path.relative(repoRoot, fixturesDir)}`);
