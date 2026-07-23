#!/usr/bin/env node
// Cold-start latency spike (Phase E, item 3 — measure-before-building warm pools).
//
// Measures dispatch → pty-host-spawned (process cold-start), NOT agent readiness.
// Metric = Date.parse(spawned.at) − Date.parse(dispatch.ts) in ms.
//   • dispatch.ts comes from the structured pre-spawn `dispatch` record in
//     ~/.syntaur/daemon.log (stamped before spawn(), carrying short + agent).
//   • spawned.at comes from ~/.syntaur/jobs/<short>/timeline.jsonl (`spawned`).
//   • join key is `short` (job dir); `agent` (from dispatch) only groups results.
//
// Read-only. No production code, no pooling. Only samples sessions dispatched
// AFTER Phase E Task 1 landed (older sessions have plaintext dispatch lines and
// are skipped). Agent-readiness latency is NOT derivable from current artifacts
// (runDerive only emits a `state` timeline event on CHANGE), so it is out of scope.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = process.env.SYNTAUR_HOME || join(homedir(), '.syntaur');
const logPath = join(root, 'daemon.log');
const jobsDir = join(root, 'jobs');

function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0);
}

// 1. Collect structured `dispatch` records (skip legacy plaintext + other events).
const dispatches = [];
for (const line of readLines(logPath)) {
  if (!line.startsWith('{')) continue; // legacy plaintext → skip
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    continue;
  }
  if (rec && rec.event === 'dispatch' && typeof rec.short === 'string' && typeof rec.ts === 'string') {
    dispatches.push({ short: rec.short, agent: typeof rec.agent === 'string' ? rec.agent : 'unknown', ts: rec.ts });
  }
}

// 2. Join to each job's `spawned` timeline event and compute the interval.
const byAgent = new Map();
let unspawned = 0;
let invalid = 0;
for (const d of dispatches) {
  const timeline = join(jobsDir, d.short, 'timeline.jsonl');
  const spawned = readLines(timeline)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.event === 'spawned' && typeof e.at === 'string');
  if (!spawned) {
    unspawned += 1; // dispatched but never spawned (spawn failure / not yet up)
    continue;
  }
  const ms = Date.parse(spawned.at) - Date.parse(d.ts);
  if (!Number.isFinite(ms) || ms < 0) {
    invalid += 1; // unparsable or negative (clock/ordering anomaly)
    continue;
  }
  if (!byAgent.has(d.agent)) byAgent.set(d.agent, []);
  byAgent.get(d.agent).push(ms);
}

function pct(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

// 3. Report.
const matched = [...byAgent.values()].reduce((n, a) => n + a.length, 0);
console.log('cold-start latency (dispatch → pty-host spawned)');
console.log(`  dispatch records: ${dispatches.length}  matched: ${matched}  unspawned: ${unspawned}  invalid: ${invalid}`);
if (matched === 0) {
  console.log('  no matched samples — collect sessions dispatched after Phase E Task 1');
  console.log('  (run a few: `syntaur bg -- <cmd>`, then re-run this script)');
} else {
  console.log('  per agent (ms):');
  for (const [agent, arr] of [...byAgent.entries()].sort()) {
    const s = [...arr].sort((a, b) => a - b);
    console.log(`    ${agent.padEnd(10)} n=${s.length}  p50=${pct(s, 50)}  p90=${pct(s, 90)}  p99=${pct(s, 99)}  max=${s[s.length - 1]}`);
  }
  const all = [...byAgent.values()].flat().sort((a, b) => a - b);
  console.log(`  overall     n=${all.length}  p50=${pct(all, 50)}  p90=${pct(all, 90)}  p99=${pct(all, 99)}`);
  console.log('');
  console.log('  finding: warm pools are worth building only if p90 cold-start is a');
  console.log('  perceptible fraction of a typical session’s time-to-usefulness. Compare');
  console.log('  p90 above against that; sub-~250ms cold-start does not justify a pool.');
}
