// Runner: `node run.ts --adapter claude|codex|both [--only 02,07,14] [--run <name>]`
// Writes out/<run>/{<scenario>.ndjson,<scenario>.stderr.log,results.json,summary.md}.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Harness, appendResult, preflight, type Adapter, type ScenarioResult } from './harness.ts';
import { scenarios, envScrub, type Ctx } from './scenarios.ts';

const here = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const flag = (name: string, dflt?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const adapterArg = flag('adapter', 'both')!;
const adapters: Adapter[] = adapterArg === 'both' ? ['claude', 'codex'] : [adapterArg as Adapter];
const only = flag('only')?.split(',').map((s) => s.trim().padStart(2, '0'));
const runName = flag('run') ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runDir = path.join(here, 'out', runName);
// a full run starts from an empty output set; `--only` reruns replace just their own rows/transcripts
if (!only) fs.rmSync(runDir, { recursive: true, force: true });
fs.mkdirSync(runDir, { recursive: true });

const pre = preflight(); // throws on missing binaries, wrong versions, or no login
fs.writeFileSync(path.join(runDir, 'preflight.json'), JSON.stringify(pre, null, 2));
console.log(`run=${runName} adapters=${adapters.join(',')}`);
console.log(JSON.stringify(pre));

for (const adapter of adapters) {
  // one disposable clone per adapter, reset to this repo's HEAD, so both suites can run concurrently
  const [target, sourceCommit] = execFileSync(path.join(here, 'target.sh'), [`target-${adapter}`], { encoding: 'utf8' }).trim().split(' ');
  const runInfoPath = path.join(runDir, 'run.json');
  const runInfo = fs.existsSync(runInfoPath) ? JSON.parse(fs.readFileSync(runInfoPath, 'utf8')) : { run: runName, startedAt: new Date().toISOString(), targets: {} };
  runInfo.targets[adapter] = { path: target, sourceCommit };
  fs.writeFileSync(runInfoPath, JSON.stringify(runInfo, null, 2));
  console.log(`[${adapter}] target=${target} @ ${sourceCommit.slice(0, 12)}`);
  for (const sc of scenarios) {
    if (!sc.adapters.includes(adapter)) continue;
    if (only && !only.some((o) => sc.id.startsWith(o))) continue;
    const notes: string[] = [];
    const metrics: Record<string, unknown> = {};
    const spawned: Harness[] = [];
    const ctx: Ctx = {
      adapter,
      runDir,
      target,
      async spawn(label, opts) {
        const h = await Harness.spawn({
          adapter,
          cwd: target,
          runDir,
          scenario: `${sc.id}.${adapter}`,
          label,
          scrubEnv: envScrub(adapter),
          ...opts,
        });
        spawned.push(h);
        return h;
      },
      note: (s) => {
        notes.push(s);
        console.log(`  · ${s}`);
      },
      metric: (k, v) => {
        metrics[k] = v;
      },
    };
    console.log(`\n=== [${adapter}] ${sc.id} — ${sc.title}`);
    const t0 = Date.now();
    const result: ScenarioResult = { id: sc.id, title: sc.title, adapter, pass: null, notes, metrics, ms: 0 };
    try {
      result.pass = await sc.run(ctx);
    } catch (e) {
      result.pass = false;
      result.error = (e as Error).stack ?? String(e);
      console.log(`  !! ${result.error.split('\n')[0]}`);
    } finally {
      for (const h of spawned) {
        try {
          await h.close();
        } catch {}
        if (h.badStdoutLines.length) notes.push(`NON-JSON STDOUT LINES (${h.label}): ${h.badStdoutLines.length} e.g. ${JSON.stringify(h.badStdoutLines[0].slice(0, 120))}`);
      }
      // leave the target clean for the next scenario
      try {
        execFileSync('git', ['-C', target, 'checkout', '-q', '--', '.']);
        execFileSync('git', ['-C', target, 'clean', '-qfd']);
      } catch {}
    }
    result.ms = Date.now() - t0;
    result.frames = spawned.map((h) => path.relative(here, h.framesPath)).join(', ');
    metrics.badStdoutLines = spawned.reduce((n, h) => n + h.badStdoutLines.length, 0);
    if (result.pass === true && (metrics.badStdoutLines as number) > 0) {
      result.pass = false; // stdout must be 100% parseable NDJSON (§5.9a step 15)
      notes.push('FAILED: adapter wrote non-JSON lines to stdout');
    }
    metrics.adapters = Object.fromEntries(spawned.map((h) => [h.label, h.stats()]));
    appendResult(runDir, result);
    console.log(`  => ${result.pass === null ? 'OBSERVED' : result.pass ? 'PASS' : 'FAIL'} (${result.ms}ms)`);
  }
}

// summary table
const all: ScenarioResult[] = JSON.parse(fs.readFileSync(path.join(runDir, 'results.json'), 'utf8'));
const rows = ['| # | Scenario | Adapter | Result | ms | Notes |', '|---|---|---|---|---|---|'];
for (const r of all) {
  const res = r.pass === null ? 'observed' : r.pass ? 'PASS' : 'FAIL';
  rows.push(`| ${r.id} | ${r.title} | ${r.adapter} | ${res} | ${r.ms} | ${(r.error ? [r.error.split('\n')[0], ...r.notes] : r.notes).join('<br>').replace(/\|/g, '\\|')} |`);
}
fs.writeFileSync(path.join(runDir, 'summary.md'), rows.join('\n') + '\n');
console.log('\n' + rows.join('\n'));
