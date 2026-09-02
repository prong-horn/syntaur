// Fixture export: `node fixtures.ts --claude <run> --codex <run>`
// Copies each run's frame transcripts into src/__tests__/fixtures/acp/<adapter>/, writes manifest.json (run ids,
// versions, scenario → file map with pass/fail) and regenerates the capture block of the fixtures README.
// Exits 1 when a run is missing a scenario row this scenario list expects, a transcript is missing or not
// well-formed NDJSON in the {seq, ts, t, dir, msg} envelope, or a transcript lacks either direction.

import fs from 'node:fs';
import path from 'node:path';
import type { ScenarioResult } from './harness.ts';
import { scenarios } from './scenarios.ts';

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
  sourceCommit?: string;
  files: string[];
  notes: string[];
  error?: string;
  metrics?: Record<string, unknown>;
};
const manifest = {
  generated: new Date().toISOString(),
  envelope: '{seq, ts, t, dir: "in"|"out", msg} per line; t = ms since adapter spawn; dir is from the client\'s point of view',
  volatile: [
    'absolute paths under scripts/spike/acp/out/target-<adapter> (the disposable target clones) and scripts/spike/acp/out/perm',
    'sessionId values',
    'tool-call ids (toolu_… / call_… / exec-…)',
    'usage_update numbers and _meta["_claude/rateLimit"]',
    'timestamps and model output text',
    'e-mail addresses (already replaced with [redacted-email] at capture time)',
  ],
  runs: {} as Record<
    string,
    { run: string; versions: Record<string, string>; target?: string; sourceCommit?: string }
  >,
  scenarios: [] as ManifestScenario[],
};
const problems: string[] = [];

// A transcript must parse line by line into the envelope and, unless it documents an adapter that died before
// answering (`.early-exit`), carry traffic in both directions.
function validateTranscript(file: string, rel: string) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (lines.length === 0) return problems.push(`${rel}: empty`);
  const dirs = new Set<string>();
  let prevSeq = 0;
  for (const [i, line] of lines.entries()) {
    let f: { seq?: unknown; ts?: unknown; t?: unknown; dir?: unknown; msg?: unknown };
    try {
      f = JSON.parse(line);
    } catch {
      return problems.push(`${rel}:${i + 1}: not JSON`);
    }
    if (typeof f.seq !== 'number' || f.seq <= prevSeq) return problems.push(`${rel}:${i + 1}: seq ${String(f.seq)} not increasing`);
    prevSeq = f.seq;
    if (typeof f.ts !== 'string' || typeof f.t !== 'number' || (f.dir !== 'in' && f.dir !== 'out') || typeof f.msg !== 'object' || f.msg === null)
      return problems.push(`${rel}:${i + 1}: bad envelope ${line.slice(0, 80)}`);
    dirs.add(f.dir);
  }
  if (dirs.size < 2 && !rel.includes('.early-exit')) problems.push(`${rel}: only "${[...dirs][0]}" frames`);
}

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
  for (const sc of scenarios) if (sc.adapters.includes(adapter) && !latest.has(sc.id)) problems.push(`${adapter}: no results row for ${sc.id}`);
  for (const r of [...latest.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const files: string[] = [];
    const frames = (r.frames ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (frames.length === 0) problems.push(`${adapter}/${r.id}: row has no transcripts`);
    for (const rel of frames) {
      const src = path.join(here, rel);
      // out/<run>/<id>.<adapter>[.label].ndjson → <id>[.label].ndjson
      const name = path.basename(src).replace(`.${adapter}`, '');
      if (!fs.existsSync(src)) {
        problems.push(`${adapter}/${name}: transcript ${rel} missing`);
        continue;
      }
      validateTranscript(src, `${adapter}/${name}`);
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
      ...(r.sourceCommit ? { sourceCommit: r.sourceCommit } : {}),
      files,
      notes: r.notes,
      ...(r.error ? { error: r.error.split('\n')[0] } : {}),
      metrics,
    });
  }
}

if (problems.length) {
  console.error(`fixture export refused:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

fs.writeFileSync(path.join(fixturesDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// README capture block: versions, source commits, runs, and one line per scenario × adapter.
const readmePath = path.join(fixturesDir, 'README.md');
const readme = fs.readFileSync(readmePath, 'utf8');
const start = readme.indexOf('<!-- capture:start -->');
const end = readme.indexOf('<!-- capture:end -->');
if (start < 0 || end < 0) throw new Error(`${readmePath}: capture markers missing`);
const short = (c?: string) => (c ? c.slice(0, 12) : '-');
const res = (p: boolean | null) => (p === null ? 'observed' : p ? 'PASS' : 'FAIL');
const block = [
  '<!-- capture:start -->',
  `Captured ${manifest.generated.slice(0, 10)}; regenerated by \`fixtures.ts\`, do not edit by hand.`,
  '',
  '| Adapter | Run | Versions | Source commit |',
  '|---|---|---|---|',
  ...Object.entries(manifest.runs).map(
    ([a, r]) => `| ${a} | \`${r.run}\` | ${Object.entries(r.versions).map(([k, v]) => `${k} ${v}`).join(', ')} | \`${short(r.sourceCommit)}\` |`,
  ),
  '',
  'Rows whose source commit differs from the run\'s were rerun with `--only` after the branch moved.',
  '',
  '| Scenario | Adapter | Result | Source commit | Transcripts |',
  '|---|---|---|---|---|',
  ...manifest.scenarios.map(
    (s) => `| ${s.id} — ${s.title} | ${s.adapter} | ${res(s.pass)} | \`${short(s.sourceCommit)}\` | ${s.files.map((f) => `\`${f}\``).join(', ')} |`,
  ),
  '<!-- capture:end -->',
].join('\n');
fs.writeFileSync(readmePath, readme.slice(0, start) + block + readme.slice(end + '<!-- capture:end -->'.length));

const n = manifest.scenarios.reduce((a, s) => a + s.files.length, 0);
console.log(`wrote ${n} transcripts + manifest.json + README capture block under ${path.relative(repoRoot, fixturesDir)}`);
