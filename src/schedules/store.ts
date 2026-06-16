/**
 * Per-file `ScheduledJob` store under `~/.syntaur/schedules/<id>.md`, auditable
 * like an assignment. Each frontmatter line is `key: <JSON value>` — JSON is a
 * valid YAML flow scalar, so the files stay human-readable AND round-trip
 * losslessly without a YAML dependency. Mutable writes go through
 * `writeFileForce` (temp-file + atomic rename) so a crash never leaves a
 * half-written job; this is the crash-safety floor the attempt state machine
 * relies on (the cursor/dedupe advance is persisted before any launch).
 *
 * Dir override `SYNTAUR_SCHEDULES_DIR` mirrors `SYNTAUR_RUNTIME_SESSIONS_DIR`
 * so tests point at a tmpdir.
 */

import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeFileForce, fileExists } from '../utils/fs.js';
import { syntaurRoot } from '../utils/paths.js';
import { nowTimestamp } from '../utils/timestamp.js';
import {
  type ScheduledJob,
  type JobAttempt,
  type JobTrigger,
  type JobTiming,
  type UnattendedLimits,
} from './types.js';

export function schedulesDir(): string {
  const override = process.env.SYNTAUR_SCHEDULES_DIR;
  if (override && override.length > 0) return resolve(override);
  return resolve(syntaurRoot(), 'schedules');
}

export function jobPath(id: string): string {
  return resolve(schedulesDir(), `${jobFileSafe(id)}.md`);
}

/** Job ids are minted by us (UUID), but guard against path traversal anyway. */
function jobFileSafe(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`Unsafe schedule id: ${JSON.stringify(id)}`);
  }
  return id;
}

export function newJobId(): string {
  return `job-${randomUUID()}`;
}

// Field order is stable for readable diffs; `attempt` last (it churns most).
const FIELD_ORDER: ReadonlyArray<keyof ScheduledJob> = [
  'id',
  'assignmentId',
  'agentId',
  'promptTemplate',
  'playbook',
  'terminalPreference',
  'unattended',
  'limits',
  'trigger',
  'timing',
  'note',
  'createdAt',
  'updatedAt',
  'attempt',
];

export function serializeJobFile(job: ScheduledJob): string {
  const fm = FIELD_ORDER.map((k) => `${k}: ${JSON.stringify(job[k])}`).join('\n');
  return `---\n${fm}\n---\n\n${renderBody(job)}\n`;
}

function renderBody(job: ScheduledJob): string {
  const lines = [
    `# Schedule: ${describeTrigger(job.trigger)}`,
    '',
    `- Assignment: \`${job.assignmentId}\``,
    `- Agent: \`${job.agentId}\``,
    `- Mode: ${job.unattended ? 'unattended' : 'interactive'}`,
    `- State: \`${job.attempt.state}\``,
  ];
  if (job.note) lines.push('', job.note);
  return lines.join('\n');
}

export function describeTrigger(t: JobTrigger): string {
  switch (t.kind) {
    case 'at':
      return `at ${t.at}`;
    case 'in':
      return `in ${Math.round(t.durationMs / 1000)}s (from ${t.anchorIso})`;
    case 'cron':
      return `cron \`${t.expr}\`${t.tz ? ` (${t.tz})` : ''}`;
    case 'after-reset':
      return `after ${t.provider} reset`;
    case 'when-status':
      return `when ${t.assignmentId ?? 'this assignment'} reaches \`${t.status}\``;
    case 'when-plan-lands':
      return `when ${t.assignmentId ?? 'this assignment'}'s plan lands`;
  }
}

export class ScheduleParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleParseError';
  }
}

export function parseJobFile(content: string): ScheduledJob {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new ScheduleParseError('Missing frontmatter block');
  const raw: Record<string, unknown> = {};
  for (const line of m[1].split('\n')) {
    if (line.trim().length === 0) continue;
    const idx = line.indexOf(': ');
    if (idx === -1) throw new ScheduleParseError(`Malformed frontmatter line: ${line}`);
    const key = line.slice(0, idx);
    const valueText = line.slice(idx + 2);
    try {
      raw[key] = JSON.parse(valueText);
    } catch {
      throw new ScheduleParseError(`Field \`${key}\` is not valid JSON: ${valueText}`);
    }
  }
  return validateJob(raw);
}

function req<T>(raw: Record<string, unknown>, key: string, check: (v: unknown) => v is T): T {
  const v = raw[key];
  if (!check(v)) throw new ScheduleParseError(`Field \`${key}\` is missing or invalid`);
  return v;
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function validateJob(raw: Record<string, unknown>): ScheduledJob {
  const job: ScheduledJob = {
    id: req(raw, 'id', isString),
    assignmentId: req(raw, 'assignmentId', isString),
    agentId: req(raw, 'agentId', isString),
    promptTemplate: req(raw, 'promptTemplate', isStringOrNull),
    playbook: req(raw, 'playbook', isStringOrNull),
    terminalPreference: req(raw, 'terminalPreference', isStringOrNull) as ScheduledJob['terminalPreference'],
    unattended: req(raw, 'unattended', isBool),
    limits: req(raw, 'limits', isObject) as unknown as UnattendedLimits,
    trigger: req(raw, 'trigger', isObject) as unknown as JobTrigger,
    timing: req(raw, 'timing', isObject) as unknown as JobTiming,
    note: req(raw, 'note', isStringOrNull),
    createdAt: req(raw, 'createdAt', isString),
    updatedAt: req(raw, 'updatedAt', isString),
    attempt: req(raw, 'attempt', isObject) as unknown as JobAttempt,
  };
  // Spot-check the nested unions/records enough to fail fast on corruption.
  if (!isString((job.trigger as { kind?: unknown }).kind)) {
    throw new ScheduleParseError('Field `trigger.kind` is missing');
  }
  if (!isString((job.attempt as { state?: unknown }).state)) {
    throw new ScheduleParseError('Field `attempt.state` is missing');
  }
  return job;
}

export async function readJob(id: string): Promise<ScheduledJob | null> {
  const path = jobPath(id);
  if (!(await fileExists(path))) return null;
  return parseJobFile(await readFile(path, 'utf-8'));
}

/** Persist a job atomically, stamping `updatedAt`. */
export async function writeJob(job: ScheduledJob): Promise<ScheduledJob> {
  const next = { ...job, updatedAt: nowTimestamp() };
  await writeFileForce(jobPath(next.id), serializeJobFile(next));
  return next;
}

export async function listJobs(): Promise<ScheduledJob[]> {
  let names: string[];
  try {
    names = await readdir(schedulesDir());
  } catch {
    return [];
  }
  const jobs: ScheduledJob[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    try {
      jobs.push(parseJobFile(await readFile(resolve(schedulesDir(), name), 'utf-8')));
    } catch {
      // A corrupt/half-written file must not poison the whole sweep.
    }
  }
  jobs.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return jobs;
}

export async function deleteJob(id: string): Promise<void> {
  await rm(jobPath(id), { force: true });
  await rm(resolve(schedulesDir(), `${jobFileSafe(id)}.jsonl`), { force: true });
}
